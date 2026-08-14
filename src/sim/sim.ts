/**
 * Fleetline simulation core: the fixed-timestep tick loop.
 *
 * One tick = 100 ms of sim time. The loop advances robots along reserved
 * paths, drains/charges batteries, generates and assigns tasks, fires
 * supervised-autonomy help requests from the seeded RNG, and accumulates
 * fleet KPIs. Speed multipliers and pause live in the driver (store) — the
 * sim itself only knows "one step".
 *
 * Everything here is deterministic for a given seed: no Date.now, no
 * Math.random.
 */

import type { Vec2 } from './types'
import { cellKey } from './types'
import type { Rng } from './rng'
import { mulberry32, rangeInt } from './rng'
import { findPath, ReservationTable } from './pathfinding'
import type { Robot, RobotClass, RobotState, TaskHistoryEntry } from './robot'
import {
  CHARGE_RESUME,
  chargeBattery,
  createRobot,
  drainBattery,
  HISTORY_MAX,
  needsCharge,
  specOf,
} from './robot'
import type { Task } from './tasks'
import { generateTask, makeTask, selectRobotForTask, TaskQueue } from './tasks'
import type { TaskParams } from './tasks'
import { EventLog } from './events'
import type { HelpKind, HelpRates, HelpRequest } from './helpRequests'
import {
  createHelpRequest,
  DEFAULT_HELP_RATES,
  isValidOption,
  rollMovingHelp,
  rollPickHelp,
} from './helpRequests'
import { aisleAt, CHARGER_NAMES, getStation, GRID_H, GRID_W, isWalkable, STATIONS } from './warehouse'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TICK_MS = 100
export const TICK_S = TICK_MS / 1000

/** Ticks to complete a pick at a rack. */
export const PICK_TICKS = 30
/** Ticks to complete a drop at a station. */
export const DROP_TICKS = 20
/** How many upcoming path cells a robot reserves beyond its current cell. */
const RESERVE_AHEAD = 2
/** Ticks a robot waits on a traffic conflict before replanning around it. */
const REPLAN_AFTER_TICKS = 12
/** Obstacle lifetime when the operator chooses "wait" (15 s sim). */
const OBSTACLE_TTL_WAIT = 150
/** Default obstacle lifetime (90 s sim). */
const OBSTACLE_TTL_DEFAULT = 900
/** Auto-generator keeps at most this many tasks queued. */
const MAX_QUEUED = 8
/** Per-tick probability of generating a task while under the queue cap. */
const GEN_PROB = 0.02

export interface Obstacle {
  x: number
  y: number
  expiresTick: number
}

/**
 * Which input modality issued an operator command. This distinction is the
 * core of the interaction-research question this prototype supports:
 *
 * - 'direct-manipulation': the operator acts on the spatial representation —
 *   select a robot on the map or roster, then click a destination station
 *   (or use the detail-drawer controls). Precise and low-ambiguity, but it
 *   demands visual attention and a pointer.
 * - 'chat': the operator states intent in natural language and an agent
 *   translates it into these same commands (later stage). Eyes-free and
 *   multi-robot capable, but adds interpretation latency and trust questions.
 *
 * Both modalities converge on the same command API so a study compares
 * interaction cost, not capability.
 */
export type CommandSource = 'direct-manipulation' | 'chat'

export interface CommandResult {
  ok: boolean
  /** Operator-facing explanation when the command is refused. */
  reason?: string
}

/** Instrumentation record of one operator command (accepted or refused). */
export interface OperatorCommand {
  tick: number
  robotId: string
  command: 'goto' | 'charge' | 'reroute' | 'abort'
  target: string
  source: CommandSource
  ok: boolean
  reason?: string
}

/** Starting roster entry (see DEFAULT_FLEET; ROS mode passes `fleet: []`). */
export interface FleetSpec {
  id: string
  cls: RobotClass
  x: number
  y: number
  battery: number
}

export interface SimOptions {
  seed?: number
  autoGenerate?: boolean
  helpRates?: Partial<HelpRates>
  /** Initial roster; defaults to the built-in 5-robot fleet. An empty array
   * is valid — ROS mode starts empty and adds robots via addExternalRobot. */
  fleet?: FleetSpec[]
  /** Starting tick. ROS mode maps the wall clock onto the tick scale so all
   * event timestamps in that mode are real time; the sim default is 0. */
  initialTick?: number
}

export interface Kpis {
  tasksCompleted: number
  tasksAborted: number
  /** Mean assigned-to-completed time in sim seconds. */
  avgTaskTimeS: number
  /** Share of robot-ticks spent moving or executing, in percent. */
  utilizationPct: number
  /** Operator interventions: resolved help requests + e-stops engaged. */
  interventions: number
}

interface FleetKpiAccum {
  tasksCompleted: number
  tasksAborted: number
  taskTicksTotal: number
  busyRobotTicks: number
  totalRobotTicks: number
  interventions: number
}

const DEFAULT_FLEET: FleetSpec[] = [
  { id: 'AMR-1', cls: '100kg', x: 4, y: 2, battery: 92 },
  { id: 'AMR-2', cls: '100kg', x: 10, y: 18, battery: 76 },
  { id: 'AMR-3', cls: '100kg', x: 30, y: 18, battery: 64 },
  { id: 'AMR-4', cls: '600kg', x: 38, y: 9, battery: 88 },
  { id: 'AMR-5', cls: '1500kg', x: 27, y: 21, battery: 58 },
]

// ---------------------------------------------------------------------------
// FleetSim
// ---------------------------------------------------------------------------

export class FleetSim {
  tick = 0
  readonly robots: Robot[]
  readonly queue = new TaskQueue()
  readonly events = new EventLog()
  readonly help: HelpRequest[] = []
  /** Active obstructions, keyed by cell key. */
  readonly obstacles = new Map<string, Obstacle>()
  readonly reservations = new ReservationTable()
  /** Charge bay name -> robot id currently assigned to it. */
  readonly chargerAssignments = new Map<string, string>()
  /** Every operator command issued this shift (research instrumentation). */
  readonly commandLog: OperatorCommand[] = []
  autoGenerate: boolean
  globalEstop = false

  private rng: Rng
  private helpRates: HelpRates
  private taskSeq = 1
  private helpSeq = 1
  private kpi: FleetKpiAccum = {
    tasksCompleted: 0,
    tasksAborted: 0,
    taskTicksTotal: 0,
    busyRobotTicks: 0,
    totalRobotTicks: 0,
    interventions: 0,
  }

  constructor(opts: SimOptions = {}) {
    this.rng = mulberry32(opts.seed ?? 1)
    this.autoGenerate = opts.autoGenerate ?? true
    this.helpRates = { ...DEFAULT_HELP_RATES, ...opts.helpRates }
    this.tick = opts.initialTick ?? 0
    const fleet = opts.fleet ?? DEFAULT_FLEET
    this.robots = fleet.map((f) => createRobot(f.id, f.cls, f.x, f.y, f.battery))
    for (const r of this.robots) {
      this.reservations.reserve(r.id, [{ x: r.gx, y: r.gy }])
    }
    this.events.append(
      this.tick,
      'SIM',
      this.robots.length > 0
        ? `Shift started — fleet online (${this.robots.length} AMRs)`
        : 'Console online — no robots registered yet',
    )
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  getRobot(id: string): Robot {
    const r = this.robots.find((x) => x.id === id)
    if (!r) throw new Error(`Unknown robot: ${id}`)
    return r
  }

  /**
   * Register a robot discovered from an external data source (the ROS
   * bridge). The robot joins the roster, map, and parser vocabulary; its
   * pose/battery/state are owned by the external source from here on —
   * in that mode step() is never called, so no sim behavior applies to it.
   * Continuous (x, y) is preserved; the grid cell is the rounded position.
   */
  addExternalRobot(id: string, cls: RobotClass, x: number, y: number, battery: number): Robot {
    if (this.robots.some((r) => r.id === id)) throw new Error(`Duplicate robot id: ${id}`)
    const r = createRobot(id, cls, Math.round(x), Math.round(y), battery)
    r.x = x
    r.y = y
    r.prevX = x
    r.prevY = y
    this.robots.push(r)
    this.reservations.reserve(r.id, [{ x: r.gx, y: r.gy }])
    this.events.append(this.tick, 'SIM', `${id} joined the fleet (${cls} class)`, { robotId: id })
    return r
  }

  setAutoGenerate(on: boolean): void {
    if (this.autoGenerate === on) return
    this.autoGenerate = on
    this.events.append(this.tick, 'SIM', `Task auto-generation ${on ? 'enabled' : 'disabled'}`)
  }

  /** Enqueue a fully specified task (used by tests and manual dispatch). */
  enqueueTask(params: Omit<TaskParams, 'id' | 'createdTick'> & { id?: string; createdTick?: number }): Task {
    const task = makeTask({
      ...params,
      id: params.id ?? `T-${String(this.taskSeq).padStart(3, '0')}`,
      createdTick: params.createdTick ?? this.tick,
    })
    this.taskSeq++
    this.queue.add(task)
    this.events.append(this.tick, 'TASK_CREATED', `${task.id} created: pick ${task.rackRow} -> ${task.stationName} (P${task.priority}, ${task.requiredClass})`, { taskId: task.id })
    return task
  }

  openHelpRequests(): HelpRequest[] {
    return this.help.filter((h) => h.state === 'open')
  }

  openHelpFor(robotId: string): HelpRequest | undefined {
    return this.help.find((h) => h.robotId === robotId && h.state === 'open')
  }

  kpis(): Kpis {
    const k = this.kpi
    return {
      tasksCompleted: k.tasksCompleted,
      tasksAborted: k.tasksAborted,
      avgTaskTimeS: k.tasksCompleted > 0 ? (k.taskTicksTotal / k.tasksCompleted) * TICK_S : 0,
      utilizationPct: k.totalRobotTicks > 0 ? (k.busyRobotTicks / k.totalRobotTicks) * 100 : 0,
      interventions: k.interventions,
    }
  }

  // -------------------------------------------------------------------------
  // E-stop
  // -------------------------------------------------------------------------

  estopRobot(id: string, viaGlobal = false): void {
    const r = this.getRobot(id)
    if (r.state === 'estopped') {
      // A direct e-stop on an already-halted robot latches an individual
      // lockout, so the robot survives a later global release.
      if (!viaGlobal && r.estopOrigin !== 'individual') {
        r.estopOrigin = 'individual'
        this.kpi.interventions++
        this.events.append(this.tick, 'OPERATOR_ACTION', `E-stop engaged on ${id} — holds through global release`, { robotId: id })
      }
      return
    }
    r.resumeState = r.state
    r.state = 'estopped'
    r.estopOrigin = viaGlobal ? 'global' : 'individual'
    if (!viaGlobal) {
      this.kpi.interventions++
      this.events.append(this.tick, 'OPERATOR_ACTION', `E-stop engaged on ${id}`, { robotId: id })
    }
  }

  resumeRobot(id: string, viaGlobal = false): void {
    const r = this.getRobot(id)
    if (r.state !== 'estopped') return
    // Lockout practice: a global release never clears an e-stop that was
    // engaged on the robot individually — only a per-robot release does.
    if (viaGlobal && r.estopOrigin === 'individual') return
    r.state = r.resumeState ?? 'idle'
    r.resumeState = null
    r.estopOrigin = null
    if (!viaGlobal) {
      this.events.append(this.tick, 'OPERATOR_ACTION', `${id} released from e-stop`, { robotId: id })
    }
  }

  estopAll(): void {
    if (this.globalEstop) return
    this.globalEstop = true
    for (const r of this.robots) this.estopRobot(r.id, true)
    this.kpi.interventions++
    this.events.append(this.tick, 'OPERATOR_ACTION', 'GLOBAL E-STOP engaged — all robots halted')
  }

  resumeAll(): void {
    if (!this.globalEstop) return
    this.globalEstop = false
    const held = this.robots.filter((r) => r.state === 'estopped' && r.estopOrigin === 'individual')
    for (const r of this.robots) this.resumeRobot(r.id, true)
    this.events.append(this.tick, 'OPERATOR_ACTION', 'Global e-stop released — fleet resuming')
    if (held.length > 0) {
      this.events.append(
        this.tick,
        'OPERATOR_ACTION',
        `${held.map((r) => r.id).join(', ')} held — individual e-stop${held.length > 1 ? 's stay' : ' stays'} engaged until released per robot`,
      )
    }
  }

  // -------------------------------------------------------------------------
  // Help requests
  // -------------------------------------------------------------------------

  /**
   * Force a help request onto a robot (also used by the probabilistic rolls).
   * Returns null when the robot's current situation cannot host that kind
   * (e.g. PATH_BLOCKED with no remaining path).
   */
  injectHelpRequest(robotId: string, kind: HelpKind): HelpRequest | null {
    const r = this.getRobot(robotId)
    if (this.openHelpFor(robotId)) return null

    if (kind === 'PATH_BLOCKED') {
      if (r.state !== 'moving' && r.state !== 'blocked') return null
      const ahead = r.path[r.pathIndex + 3] ?? r.path[r.pathIndex + 2] ?? r.path[r.pathIndex + 1]
      if (!ahead) return null
      const k = cellKey(ahead.x, ahead.y)
      this.obstacles.set(k, { x: ahead.x, y: ahead.y, expiresTick: this.tick + OBSTACLE_TTL_DEFAULT })
      const aisle = aisleAt(ahead.y)
      const where = aisle ? aisle.name.replace('AISLE', 'Aisle') : 'the transit corridor'
      return this.fireHelp(r, kind, `Obstruction detected ahead in ${where} — path is blocked.`, {
        obstacleKey: k,
      })
    }

    if (kind === 'LOW_CONFIDENCE') {
      if (r.state !== 'moving') return null
      const pct = rangeInt(this.rng, 28, 55)
      return this.fireHelp(
        r,
        kind,
        `Localization confidence dropped to ${pct}% — position estimate may be stale.`,
        {},
      )
    }

    // STUCK_AT_PICK
    if (r.state !== 'executing' || r.phase !== 'picking') return null
    return this.fireHelp(r, kind, 'Unable to secure load at rack after 2 attempts.', {})
  }

  private fireHelp(r: Robot, kind: HelpKind, reason: string, data: Record<string, string>): HelpRequest {
    const help = createHelpRequest(this.helpSeq++, kind, r.id, reason, this.tick, data)
    this.help.push(help)
    r.helpId = help.id
    r.helpFiredThisLeg = true
    this.setState(r, 'awaiting_help')
    // Free the aisle for other robots while this one holds position.
    this.reservations.reserve(r.id, [{ x: r.gx, y: r.gy }])
    this.events.append(this.tick, 'HELP_REQUEST', `${r.id} needs help (${kind}): ${reason}`, {
      robotId: r.id,
      taskId: r.taskId ?? undefined,
    })
    return help
  }

  /** Operator resolves a help request by choosing one of its options. */
  resolveHelp(helpId: string, optionId: string): void {
    const help = this.help.find((h) => h.id === helpId)
    if (!help || help.state !== 'open') return
    if (!isValidOption(help.kind, optionId)) return
    const r = this.getRobot(help.robotId)

    help.state = 'resolved'
    help.resolution = optionId
    help.resolvedTick = this.tick
    r.helpId = null
    this.kpi.interventions++
    const label = help.options.find((o) => o.id === optionId)?.label ?? optionId
    // Decision latency (request open -> operator choice) is a primary metric
    // for the supervised-autonomy study, so it goes into the log line.
    const latencyS = ((this.tick - help.createdTick) * TICK_S).toFixed(1)
    this.events.append(
      this.tick,
      'OPERATOR_ACTION',
      `Operator chose "${label}" for ${r.id} (${help.kind}) — decided in ${latencyS} s`,
      {
        robotId: r.id,
        taskId: r.taskId ?? undefined,
      },
    )

    switch (help.kind) {
      case 'PATH_BLOCKED': {
        if (optionId === 'reroute') {
          if (this.replanMission(r, false)) {
            this.setState(r, 'moving')
            this.events.append(this.tick, 'HELP_RESOLVED', `${r.id} rerouting around obstruction`, { robotId: r.id })
          } else {
            // No path around it yet — hold and keep retrying via blocked logic.
            r.waitTicks = 0
            this.setState(r, 'blocked')
            this.events.append(this.tick, 'HELP_RESOLVED', `${r.id} holding — no clear route yet`, { robotId: r.id })
          }
        } else if (optionId === 'wait') {
          const k = help.data.obstacleKey
          const obs = k ? this.obstacles.get(k) : undefined
          if (obs) obs.expiresTick = Math.min(obs.expiresTick, this.tick + OBSTACLE_TTL_WAIT)
          r.waitingObstacle = k ?? null
          this.setState(r, 'blocked')
          this.events.append(this.tick, 'HELP_RESOLVED', `${r.id} holding position until obstruction clears`, { robotId: r.id })
        } else {
          this.abortTask(r)
        }
        break
      }
      case 'LOW_CONFIDENCE': {
        if (optionId === 'confirm') {
          this.setState(r, 'moving')
          this.events.append(this.tick, 'HELP_RESOLVED', `${r.id} position confirmed — resuming mission`, { robotId: r.id })
        } else {
          this.requeueTask(r)
          this.sendToStaging(r)
        }
        break
      }
      case 'STUCK_AT_PICK': {
        if (optionId === 'retry') {
          r.actionTicks = PICK_TICKS
          this.setState(r, 'executing')
          this.events.append(this.tick, 'HELP_RESOLVED', `${r.id} retrying pick`, { robotId: r.id })
        } else if (optionId === 'skip') {
          this.requeueTask(r)
          this.setState(r, 'idle')
          this.events.append(this.tick, 'HELP_RESOLVED', `${r.id} released — task returned to queue`, { robotId: r.id })
        } else {
          this.abortTask(r)
        }
        break
      }
    }
  }

  // -------------------------------------------------------------------------
  // Operator commands (manual dispatch)
  //
  // See the CommandSource doc above: these two methods are the single command
  // API that both the direct-manipulation UI (map click / detail drawer) and
  // the chat modality call into. Refusals are logged too — a refused command
  // is interaction data, not a silent no-op.
  // -------------------------------------------------------------------------

  /**
   * Command a robot to a named station. Chargers delegate to commandCharge.
   * An in-flight (not yet picked) task is returned to the queue; a robot that
   * is already carrying a load, executing a pick/drop, awaiting a help
   * decision, or e-stopped refuses the command with a reason.
   */
  commandGoto(robotId: string, stationName: string, source: CommandSource = 'direct-manipulation'): CommandResult {
    const r = this.getRobot(robotId)
    const station = STATIONS.find((s) => s.name === stationName)
    if (!station) {
      return this.commandRejected(r, 'goto', stationName, source, `Unknown station "${stationName}"`)
    }
    if (station.kind === 'charger') return this.commandCharge(robotId, source, stationName)

    const blockReason = this.commandBlockReason(r)
    if (blockReason) return this.commandRejected(r, 'goto', stationName, source, blockReason)

    const dock = station.dock
    if (r.gx === dock.x && r.gy === dock.y) {
      this.releaseForCommand(r)
      r.mission = null
      r.path = []
      r.pathIndex = 0
      r.progress = 0
      this.reservations.reserve(r.id, [{ x: r.gx, y: r.gy }])
      this.setState(r, 'idle')
      return this.commandAccepted(r, 'goto', stationName, source, `${r.id} is already at ${stationName} — holding there`)
    }
    const path = findPath(isWalkable, GRID_W, GRID_H, { x: r.gx, y: r.gy }, dock, new Set(this.obstacles.keys()))
    if (!path) {
      return this.commandRejected(r, 'goto', stationName, source, `No clear route to ${stationName} right now`)
    }
    this.releaseForCommand(r)
    r.mission = { kind: 'goto', target: { ...dock }, label: stationName }
    this.replanMission(r, false)
    this.setState(r, 'moving')
    return this.commandAccepted(r, 'goto', stationName, source, `${r.id} dispatched to ${stationName}`)
  }

  /**
   * Command a robot to a charge bay: the named bay when given (refused if
   * occupied), otherwise the nearest free bay.
   */
  commandCharge(robotId: string, source: CommandSource = 'direct-manipulation', preferredBay?: string): CommandResult {
    const r = this.getRobot(robotId)
    const label = preferredBay ?? 'charge'
    if (r.state === 'charging') {
      return this.commandRejected(r, 'charge', label, source, `${r.id} is already charging at ${r.chargerName}`)
    }
    const blockReason = this.commandBlockReason(r)
    if (blockReason) return this.commandRejected(r, 'charge', label, source, blockReason)

    let bay: string
    if (preferredBay !== undefined) {
      if (!(CHARGER_NAMES as readonly string[]).includes(preferredBay)) {
        return this.commandRejected(r, 'charge', preferredBay, source, `Unknown charge bay "${preferredBay}"`)
      }
      const holder = this.chargerAssignments.get(preferredBay)
      if (holder !== undefined && holder !== r.id) {
        return this.commandRejected(r, 'charge', preferredBay, source, `${preferredBay} is occupied by ${holder}`)
      }
      bay = preferredBay
    } else {
      const nearest = this.freeCharger(r)
      if (!nearest) {
        return this.commandRejected(r, 'charge', label, source, 'All charge bays are occupied')
      }
      bay = nearest
    }

    const dock = getStation(bay).dock
    if (!(r.gx === dock.x && r.gy === dock.y)) {
      const path = findPath(isWalkable, GRID_W, GRID_H, { x: r.gx, y: r.gy }, dock, new Set(this.obstacles.keys()))
      if (!path) return this.commandRejected(r, 'charge', bay, source, `No clear route to ${bay} right now`)
    }
    this.releaseForCommand(r)
    this.chargerAssignments.set(bay, r.id)
    r.chargerName = bay
    if (r.gx === dock.x && r.gy === dock.y) {
      r.mission = null
      this.setState(r, 'charging')
      return this.commandAccepted(r, 'charge', bay, source, `${r.id} docked at ${bay} (${Math.round(r.battery)}%)`)
    }
    r.mission = { kind: 'charge', target: { ...dock }, label: bay }
    this.replanMission(r, false)
    this.setState(r, 'moving')
    return this.commandAccepted(r, 'charge', bay, source, `${r.id} dispatched to ${bay} (battery ${Math.round(r.battery)}%)`)
  }

  /**
   * Replan the robot's active route. If the robot is waiting on a
   * PATH_BLOCKED help decision, this is equivalent to choosing "Reroute" on
   * the intervention card — the chat modality reaching the same resolution.
   */
  commandReroute(robotId: string, source: CommandSource = 'direct-manipulation'): CommandResult {
    const r = this.getRobot(robotId)
    if (r.state === 'estopped') {
      return this.commandRejected(r, 'reroute', 'route', source, `${r.id} is e-stopped — release it before commanding`)
    }
    const help = this.openHelpFor(robotId)
    if (help) {
      if (help.kind === 'PATH_BLOCKED') {
        this.resolveHelp(help.id, 'reroute')
        return this.commandAccepted(r, 'reroute', 'route', source, `${r.id} rerouting around the reported obstruction`)
      }
      return this.commandRejected(
        r,
        'reroute',
        'route',
        source,
        `${r.id} is waiting on a ${help.kind.replace(/_/g, ' ')} decision — resolve it first`,
      )
    }
    if (!r.mission || (r.state !== 'moving' && r.state !== 'blocked')) {
      return this.commandRejected(r, 'reroute', 'route', source, `${r.id} has no active route to replan`)
    }
    const label = r.mission.label
    if (this.replanMission(r, true)) {
      this.setState(r, 'moving')
      return this.commandAccepted(
        r,
        'reroute',
        label ?? 'route',
        source,
        `${r.id} replanned its route${label ? ` to ${label}` : ''}`,
      )
    }
    return this.commandRejected(r, 'reroute', 'route', source, `No alternate route available for ${r.id} right now`)
  }

  /**
   * Cancel the robot's active task outright (destructive: the task is NOT
   * requeued). If the robot is awaiting a help decision whose options include
   * "abort", this resolves the request that way instead.
   */
  commandAbortTask(robotId: string, source: CommandSource = 'direct-manipulation'): CommandResult {
    const r = this.getRobot(robotId)
    if (!r.taskId) {
      return this.commandRejected(r, 'abort', 'task', source, `${r.id} has no active task to abort`)
    }
    const taskId = r.taskId
    if (r.state === 'estopped') {
      return this.commandRejected(r, 'abort', taskId, source, `${r.id} is e-stopped — release it before commanding`)
    }
    const help = this.openHelpFor(robotId)
    if (help) {
      if (isValidOption(help.kind, 'abort')) {
        this.resolveHelp(help.id, 'abort')
        return this.commandAccepted(r, 'abort', taskId, source, `${taskId} aborted — ${r.id} released from its help request`)
      }
      return this.commandRejected(
        r,
        'abort',
        taskId,
        source,
        `${r.id} is waiting on a ${help.kind.replace(/_/g, ' ')} decision — resolve it first`,
      )
    }
    this.abortTask(r)
    return this.commandAccepted(r, 'abort', taskId, source, `${taskId} aborted — ${r.id} released`)
  }

  /** Reason a robot cannot take a manual command right now, or null if it can. */
  private commandBlockReason(r: Robot): string | null {
    switch (r.state) {
      case 'estopped':
        return `${r.id} is e-stopped — release it before commanding`
      case 'awaiting_help':
        return `${r.id} is waiting on a help decision — resolve it first`
      case 'executing':
        return `${r.id} is mid-${r.phase === 'dropping' ? 'drop' : 'pick'} — wait for it to finish`
      default:
        break
    }
    // Carrying a load: hijacking the delivery would strand the load.
    if (r.phase === 'to_drop') {
      return `${r.id} is carrying a load for ${r.taskId ?? 'a task'} — let it finish the delivery`
    }
    return null
  }

  /** Detach a robot from its current commitments before a manual command. */
  private releaseForCommand(r: Robot): void {
    if (r.taskId) this.requeueTask(r)
    if (r.chargerName) {
      this.chargerAssignments.delete(r.chargerName)
      r.chargerName = null
    }
    r.waitingForCharger = false
    r.waitingObstacle = null
    r.waitTicks = 0
    r.phase = null
  }

  private commandAccepted(
    r: Robot,
    command: OperatorCommand['command'],
    target: string,
    source: CommandSource,
    summary: string,
  ): CommandResult {
    this.commandLog.push({ tick: this.tick, robotId: r.id, command, target, source, ok: true })
    this.events.append(this.tick, 'OPERATOR_ACTION', `Operator [${source}]: ${summary}`, { robotId: r.id })
    return { ok: true }
  }

  private commandRejected(
    r: Robot,
    command: OperatorCommand['command'],
    target: string,
    source: CommandSource,
    reason: string,
  ): CommandResult {
    this.commandLog.push({ tick: this.tick, robotId: r.id, command, target, source, ok: false, reason })
    this.events.append(this.tick, 'OPERATOR_ACTION', `Operator [${source}]: command refused — ${reason}`, {
      robotId: r.id,
    })
    return { ok: false, reason }
  }

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------

  step(): void {
    this.tick++
    this.expireObstacles()
    if (this.autoGenerate && !this.globalEstop) this.maybeGenerateTask()
    if (!this.globalEstop) this.assignTasks()
    for (const r of this.robots) {
      r.prevX = r.x
      r.prevY = r.y
      this.updateRobot(r)
    }
    // KPI accumulation
    for (const r of this.robots) {
      if (r.state === 'moving' || r.state === 'executing') this.kpi.busyRobotTicks++
    }
    this.kpi.totalRobotTicks += this.robots.length
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private setState(r: Robot, state: RobotState): void {
    if (r.state === state) return
    r.state = state
  }

  private expireObstacles(): void {
    for (const [k, obs] of this.obstacles) {
      if (this.tick < obs.expiresTick) continue
      this.obstacles.delete(k)
      this.events.append(this.tick, 'SIM', `Obstruction at (${obs.x}, ${obs.y}) cleared`)
      for (const r of this.robots) {
        if (r.waitingObstacle === k) {
          r.waitingObstacle = null
          r.waitTicks = 0
          if (r.state === 'blocked') {
            this.setState(r, 'moving')
            this.events.append(this.tick, 'STATE_CHANGE', `${r.id} resuming — obstruction cleared`, { robotId: r.id })
          }
        }
      }
    }
  }

  private maybeGenerateTask(): void {
    if (this.queue.countByState('queued') >= MAX_QUEUED) return
    if (this.rng() >= GEN_PROB) return
    const task = generateTask(this.rng, this.tick, this.taskSeq++)
    this.queue.add(task)
    this.events.append(this.tick, 'TASK_CREATED', `${task.id} created: pick ${task.rackRow} -> ${task.stationName} (P${task.priority}, ${task.requiredClass})`, { taskId: task.id })
  }

  private assignTasks(): void {
    for (const task of this.queue.queued()) {
      const robot = selectRobotForTask(task, this.robots)
      if (!robot) continue
      this.assignTask(task, robot)
    }
  }

  private assignTask(task: Task, r: Robot): void {
    r.taskId = task.id
    r.mission = { kind: 'pick', target: { ...task.pickApproach } }
    if (r.gx === task.pickApproach.x && r.gy === task.pickApproach.y) {
      // Already standing at the pick approach.
      task.state = 'assigned'
      task.assignedTo = r.id
      task.startedTick = this.tick
      this.startPick(r)
    } else if (this.replanMission(r, false)) {
      task.state = 'assigned'
      task.assignedTo = r.id
      task.startedTick = this.tick
      this.setState(r, 'moving')
    } else {
      // No path right now (should be rare) — leave the task queued.
      r.taskId = null
      r.mission = null
      return
    }
    this.events.append(this.tick, 'TASK_ASSIGNED', `${task.id} assigned to ${r.id} (pick ${task.rackRow} -> ${task.stationName})`, {
      robotId: r.id,
      taskId: task.id,
    })
  }

  /**
   * Plan a fresh path from the robot's current cell to its mission target.
   * Always avoids obstacles; optionally avoids cells reserved by others
   * (used when replanning around traffic). Returns false when no path.
   */
  private replanMission(r: Robot, avoidReserved: boolean): boolean {
    if (!r.mission) return false
    const avoid = new Set<string>(this.obstacles.keys())
    if (avoidReserved) {
      for (const k of this.reservations.cellsReservedByOthers(r.id)) avoid.add(k)
    }
    const path = findPath(isWalkable, GRID_W, GRID_H, { x: r.gx, y: r.gy }, r.mission.target, avoid)
    if (!path) return false
    r.path = path
    r.pathIndex = 0
    r.progress = 0
    r.waitTicks = 0
    this.reserveAhead(r)
    return true
  }

  private reserveAhead(r: Robot): void {
    const cells: Vec2[] = [{ x: r.gx, y: r.gy }]
    for (let i = 1; i <= RESERVE_AHEAD; i++) {
      const c = r.path[r.pathIndex + i]
      if (!c) break
      cells.push(c)
    }
    this.reservations.reserve(r.id, cells)
  }

  private updateRobot(r: Robot): void {
    switch (r.state) {
      case 'estopped':
        return
      case 'charging': {
        chargeBattery(r)
        if (r.battery >= CHARGE_RESUME) {
          if (r.chargerName) this.chargerAssignments.delete(r.chargerName)
          r.chargerName = null
          r.mission = null
          this.setState(r, 'idle')
          this.events.append(this.tick, 'BATTERY', `${r.id} charge complete (${Math.round(r.battery)}%) — returning to service`, { robotId: r.id })
        }
        return
      }
      case 'awaiting_help':
        drainBattery(r, 'idle')
        return
      case 'blocked': {
        drainBattery(r, 'idle')
        this.updateBlocked(r)
        return
      }
      case 'executing': {
        drainBattery(r, 'executing')
        this.checkBatteryDepleted(r)
        if (r.state !== 'executing') return
        if (r.phase === 'picking' && !r.helpFiredThisLeg) {
          const kind = rollPickHelp(this.rng, this.helpRates)
          if (kind && this.injectHelpRequest(r.id, kind)) return
        }
        r.actionTicks--
        if (r.actionTicks <= 0) this.finishAction(r)
        return
      }
      case 'idle': {
        drainBattery(r, 'idle')
        if (needsCharge(r) || r.waitingForCharger) this.sendToCharge(r)
        return
      }
      case 'moving': {
        drainBattery(r, 'moving')
        this.checkBatteryDepleted(r)
        if (r.state !== 'moving') return
        // Help events only roll at cell centers, where replanning is clean.
        if (r.progress === 0 && !r.helpFiredThisLeg) {
          const kind = rollMovingHelp(this.rng, this.helpRates)
          if (kind && this.injectHelpRequest(r.id, kind)) return
        }
        this.moveAlongPath(r)
        return
      }
    }
  }

  private checkBatteryDepleted(r: Robot): void {
    if (r.battery > 0) return
    r.resumeState = 'idle'
    r.state = 'estopped'
    this.events.append(this.tick, 'BATTERY', `${r.id} battery depleted — emergency stop`, { robotId: r.id })
  }

  private updateBlocked(r: Robot): void {
    // Waiting out an obstruction by operator decision: resume handled by
    // expireObstacles when the obstruction clears.
    if (r.waitingObstacle) return

    const next = r.path[r.pathIndex + 1]
    if (!next) {
      this.setState(r, 'moving') // will arrive on the next move
      return
    }
    const k = cellKey(next.x, next.y)
    const obstructed = this.obstacles.has(k)
    const reserved = this.reservations.isBlockedFor(r.id, next.x, next.y)
    if (!obstructed && !reserved) {
      this.setState(r, 'moving')
      return
    }
    r.waitTicks++
    if (r.waitTicks >= REPLAN_AFTER_TICKS) {
      r.waitTicks = 0
      if (this.replanMission(r, true)) {
        this.setState(r, 'moving')
        this.events.append(this.tick, 'TRAFFIC', `${r.id} rerouted around ${obstructed ? 'an obstruction' : 'traffic'}`, { robotId: r.id })
      }
    }
  }

  private moveAlongPath(r: Robot): void {
    let budget = specOf(r).speedCellsPerSec * TICK_S
    while (budget > 1e-9) {
      const next = r.path[r.pathIndex + 1]
      if (!next) {
        this.arrive(r)
        return
      }
      if (r.progress === 0) {
        const k = cellKey(next.x, next.y)
        if (this.obstacles.has(k)) {
          // Obstruction spawned by another robot's event: reroute quietly,
          // or hold if boxed in.
          if (this.replanMission(r, false)) {
            this.events.append(this.tick, 'TRAFFIC', `${r.id} rerouted around an obstruction`, { robotId: r.id })
            continue
          }
          r.waitTicks = 0
          this.setState(r, 'blocked')
          this.reservations.reserve(r.id, [{ x: r.gx, y: r.gy }])
          return
        }
        if (this.reservations.isBlockedFor(r.id, next.x, next.y)) {
          r.waitTicks = 0
          this.setState(r, 'blocked')
          this.reservations.reserve(r.id, [{ x: r.gx, y: r.gy }])
          return
        }
        this.reserveAhead(r)
      }
      const step = Math.min(budget, 1 - r.progress)
      r.progress += step
      budget -= step
      r.x = r.gx + (next.x - r.gx) * r.progress
      r.y = r.gy + (next.y - r.gy) * r.progress
      if (r.progress >= 1 - 1e-9) {
        r.gx = next.x
        r.gy = next.y
        r.x = next.x
        r.y = next.y
        r.progress = 0
        r.pathIndex++
      }
    }
  }

  private arrive(r: Robot): void {
    const mission = r.mission
    this.reservations.reserve(r.id, [{ x: r.gx, y: r.gy }])
    if (!mission) {
      this.setState(r, 'idle')
      return
    }
    switch (mission.kind) {
      case 'pick':
        this.startPick(r)
        return
      case 'drop': {
        const task = r.taskId ? this.queue.get(r.taskId) : undefined
        r.phase = 'dropping'
        r.actionTicks = DROP_TICKS
        r.helpFiredThisLeg = false
        this.setState(r, 'executing')
        this.events.append(this.tick, 'ARRIVAL', `${r.id} arrived at ${task?.stationName ?? 'station'} — unloading`, {
          robotId: r.id,
          taskId: r.taskId ?? undefined,
        })
        return
      }
      case 'charge': {
        this.setState(r, 'charging')
        r.mission = null
        this.events.append(this.tick, 'BATTERY', `${r.id} docked at ${r.chargerName} (${Math.round(r.battery)}%)`, { robotId: r.id })
        return
      }
      case 'staging': {
        r.mission = null
        this.setState(r, 'idle')
        this.events.append(this.tick, 'ARRIVAL', `${r.id} holding at STAGING`, { robotId: r.id })
        return
      }
      case 'goto': {
        const label = mission.label ?? 'destination'
        r.mission = null
        this.setState(r, 'idle')
        this.events.append(this.tick, 'ARRIVAL', `${r.id} arrived at ${label} — holding for instructions`, {
          robotId: r.id,
        })
        return
      }
    }
  }

  private startPick(r: Robot): void {
    const task = r.taskId ? this.queue.get(r.taskId) : undefined
    r.phase = 'picking'
    r.actionTicks = PICK_TICKS
    r.helpFiredThisLeg = false
    this.setState(r, 'executing')
    this.events.append(this.tick, 'ARRIVAL', `${r.id} arrived at ${task?.rackRow ?? 'rack'} pick face — picking`, {
      robotId: r.id,
      taskId: r.taskId ?? undefined,
    })
  }

  private finishAction(r: Robot): void {
    const task = r.taskId ? this.queue.get(r.taskId) : undefined
    if (r.phase === 'picking') {
      if (!task) {
        this.setState(r, 'idle')
        return
      }
      r.mission = { kind: 'drop', target: { ...task.dropCell } }
      r.phase = 'to_drop'
      if (this.replanMission(r, false)) {
        this.setState(r, 'moving')
        this.events.append(this.tick, 'STATE_CHANGE', `${r.id} picked load — en route to ${task.stationName}`, {
          robotId: r.id,
          taskId: task.id,
        })
      } else {
        r.waitTicks = 0
        this.setState(r, 'blocked')
      }
      return
    }
    if (r.phase === 'dropping') {
      if (task) this.completeTask(r, task)
      else this.afterTask(r)
    }
  }

  private pushHistory(r: Robot, taskId: string, outcome: TaskHistoryEntry['outcome']): void {
    r.history.push({ taskId, outcome, tick: this.tick })
    if (r.history.length > HISTORY_MAX) r.history.splice(0, r.history.length - HISTORY_MAX)
  }

  private completeTask(r: Robot, task: Task): void {
    task.state = 'completed'
    task.completedTick = this.tick
    this.pushHistory(r, task.id, 'completed')
    this.kpi.tasksCompleted++
    if (task.startedTick !== null) this.kpi.taskTicksTotal += this.tick - task.startedTick
    this.events.append(this.tick, 'TASK_COMPLETED', `${task.id} completed by ${r.id} at ${task.stationName}`, {
      robotId: r.id,
      taskId: task.id,
    })
    r.taskId = null
    r.mission = null
    r.phase = null
    this.afterTask(r)
  }

  /** After finishing (or losing) a task: charge if low, otherwise idle. */
  private afterTask(r: Robot): void {
    r.phase = null
    if (needsCharge(r)) {
      this.sendToCharge(r)
      if (r.state === 'moving' || r.state === 'charging') return
    }
    this.setState(r, 'idle')
  }

  /** Nearest free charge bay (Manhattan distance) — battery is scarce. */
  private freeCharger(r: Robot): string | null {
    let best: string | null = null
    let bestDist = Infinity
    for (const name of CHARGER_NAMES) {
      const holder = this.chargerAssignments.get(name)
      if (holder !== undefined && holder !== r.id) continue
      const dock = getStation(name).dock
      const d = Math.abs(r.gx - dock.x) + Math.abs(r.gy - dock.y)
      if (d < bestDist) {
        best = name
        bestDist = d
      }
    }
    return best
  }

  private sendToCharge(r: Robot): void {
    const name = this.freeCharger(r)
    if (!name) {
      if (!r.waitingForCharger) {
        r.waitingForCharger = true
        this.events.append(this.tick, 'BATTERY', `${r.id} battery ${Math.round(r.battery)}% — all charge bays occupied, holding`, { robotId: r.id })
      }
      this.setState(r, 'idle')
      return
    }
    const dock = getStation(name).dock
    r.waitingForCharger = false
    if (r.gx === dock.x && r.gy === dock.y) {
      this.chargerAssignments.set(name, r.id)
      r.chargerName = name
      this.setState(r, 'charging')
      this.events.append(this.tick, 'BATTERY', `${r.id} docked at ${name} (${Math.round(r.battery)}%)`, { robotId: r.id })
      return
    }
    r.mission = { kind: 'charge', target: { ...dock } }
    if (this.replanMission(r, false)) {
      this.chargerAssignments.set(name, r.id)
      r.chargerName = name
      this.setState(r, 'moving')
      this.events.append(this.tick, 'BATTERY', `${r.id} battery ${Math.round(r.battery)}% — dispatching to ${name}`, { robotId: r.id })
    } else {
      r.mission = null
      this.setState(r, 'idle')
    }
  }

  private sendToStaging(r: Robot): void {
    const dock = getStation('STAGING').dock
    r.mission = { kind: 'staging', target: { ...dock } }
    if (r.gx === dock.x && r.gy === dock.y || !this.replanMission(r, false)) {
      r.mission = null
      this.setState(r, 'idle')
      return
    }
    this.setState(r, 'moving')
    this.events.append(this.tick, 'STATE_CHANGE', `${r.id} proceeding to STAGING for re-localization`, { robotId: r.id })
  }

  /** Return the robot's task to the queue for another robot. */
  private requeueTask(r: Robot): void {
    const task = r.taskId ? this.queue.get(r.taskId) : undefined
    if (task) {
      task.state = 'queued'
      task.assignedTo = null
      task.startedTick = null
      this.pushHistory(r, task.id, 'requeued')
      this.events.append(this.tick, 'TASK_REQUEUED', `${task.id} returned to queue`, { taskId: task.id })
    }
    r.taskId = null
    r.mission = null
    r.phase = null
    r.path = []
    r.pathIndex = 0
    r.progress = 0
    this.reservations.reserve(r.id, [{ x: r.gx, y: r.gy }])
  }

  /** Cancel the robot's task outright. */
  private abortTask(r: Robot): void {
    const task = r.taskId ? this.queue.get(r.taskId) : undefined
    if (task) {
      task.state = 'aborted'
      task.completedTick = this.tick
      this.pushHistory(r, task.id, 'aborted')
      this.kpi.tasksAborted++
      this.events.append(this.tick, 'TASK_ABORTED', `${task.id} aborted by operator`, {
        robotId: r.id,
        taskId: task.id,
      })
    }
    r.taskId = null
    r.mission = null
    r.phase = null
    r.path = []
    r.pathIndex = 0
    r.progress = 0
    this.reservations.reserve(r.id, [{ x: r.gx, y: r.gy }])
    this.afterTask(r)
  }
}
