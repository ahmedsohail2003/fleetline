/**
 * RosFleetBridge: maps a rosbridge websocket onto the Fleetline console.
 *
 * Topic map, per robot namespace `ns` (e.g. `amr_6` -> roster id AMR-6):
 *
 *   subscribe  /<ns>/odom            nav_msgs/msg/Odometry        -> pose on the grid + MOVING/IDLE
 *   subscribe  /<ns>/battery_state   sensor_msgs/msg/BatteryState -> battery percent
 *   advertise+ /<ns>/goal_pose       geometry_msgs/msg/PoseStamped <- goto / charge commands
 *   advertise+ /<ns>/emergency_stop  std_msgs/msg/Bool             <- e-stop / resume
 *   subscribe  /fleet/status         std_msgs/msg/String (JSON)    -> robot discovery
 *
 * `/fleet/status` is a deliberate stand-in: ROS 2 has no standard fleet-roster
 * message (real deployments use vendor or Open-RMF fleet-state topics), so
 * discovery reads a `std_msgs/String` whose data is JSON:
 *   {"robots":[{"ns":"amr_6","model":"100kg"}, …]}
 * A robot enters the roster on its first odometry fix (so it appears where it
 * actually is), and enters the command parser's vocabulary the same way the
 * sim fleet does — via makeParserContext over sim.robots.
 *
 * Honesty contract for ROS mode (enforced here, surfaced in the UI):
 *   - poses, motion state, and battery are LIVE from the bridge;
 *   - tasks, help requests, and KPIs need a fleet manager the console is not
 *     integrated with, so those commands are refused with a reason and the
 *     sim-only generators stay off (the FleetSim instance backing ROS mode is
 *     never step()ped — it is used as the roster/event-log data structure);
 *   - reroute/abort have no plain-topic equivalent (they would be Nav2
 *     actions), so they are refused rather than faked.
 */

import { FleetSim } from '../sim/sim'
import type { CommandResult, CommandSource, OperatorCommand } from '../sim/sim'
import type { Robot, RobotClass } from '../sim/robot'
import { ROBOT_CLASS_SPECS } from '../sim/robot'
import { CHARGER_NAMES, getStation, GRID_H, GRID_W, STATIONS } from '../sim/warehouse'
import { RosbridgeClient } from './rosbridge'
import type { RosbridgeStatus, WebSocketCtor } from './rosbridge'
import type { BatteryState, BoolMsg, Odometry, PoseStamped, StringMsg } from './messages'
import { MSG_TYPES, rosNow } from './messages'
import type { GridTransform } from './transform'
import { DEFAULT_TRANSFORM, gridToWorld, worldToGrid } from './transform'

export const DEFAULT_BRIDGE_URL = 'ws://localhost:9090'
export const FLEET_STATUS_TOPIC = '/fleet/status'

/** Expected odometry cadence, used only for render interpolation. The mock
 * publishes at 10 Hz; a slower real publisher just renders step-wise. */
const ODOM_PERIOD_MS = 100

/** How long to wait for a first battery_state before admitting a robot to
 * the roster with an honest "battery unknown" (shown as 0%). */
const BATTERY_WAIT_MS = 2000

/** Twist magnitude (m/s) above which a robot renders as MOVING. */
const MOVING_EPS = 0.02

/** Within this many cells of a published goal, with zero twist, the robot is
 * reported as arrived (presentation only — Nav2 owns the real goal state). */
const ARRIVE_CELLS = 0.8

export type RosConnState = 'connecting' | 'connected' | 'error'

export interface RosFleetOptions {
  url: string
  transform?: GridTransform
  /** Robot namespaces to register up front (skips /fleet/status discovery —
   * useful against a single-robot Nav2 stack with no fleet topic). */
  robots?: string[]
  /** Called whenever bridge-owned state changes (store.notify hook). */
  onChange?: () => void
  webSocketImpl?: WebSocketCtor
  initialBackoffMs?: number
}

interface KnownRobot {
  ns: string
  id: string
  cls: RobotClass
  battery: number | null
  firstOdomAtMs: number | null
  warnedOffGrid: boolean
  warnedNoBattery: boolean
}

/** `amr_6` / `/amr_6` -> `AMR-6`; any other namespace uppercases the same way. */
export function nsToRobotId(ns: string): string {
  return ns.replace(/^\//, '').toUpperCase().replace(/_/g, '-')
}

function isRobotClass(v: unknown): v is RobotClass {
  return typeof v === 'string' && v in ROBOT_CLASS_SPECS
}

/** BatteryState.percentage is specified as [0, 1]; some drivers ship 0-100.
 * Values > 1 are treated as already-percent (documented display heuristic). */
export function normalizeBatteryPct(percentage: number): number {
  if (!Number.isFinite(percentage)) return 0
  const pct = percentage <= 1 ? percentage * 100 : percentage
  return Math.min(100, Math.max(0, pct))
}

export class RosFleetBridge {
  readonly sim: FleetSim
  readonly url: string
  readonly transform: GridTransform
  readonly client: RosbridgeClient
  /** Human-readable detail for the last connection failure. */
  lastError: string | null = null

  private readonly known = new Map<string, KnownRobot>() // by namespace
  private readonly byId = new Map<string, KnownRobot>() // by roster id
  private readonly onChange: () => void
  private sinceOdomMs = ODOM_PERIOD_MS // render-interp accumulator
  private warnedBadStatusPayload = false
  private disposed = false

  constructor(sim: FleetSim, opts: RosFleetOptions) {
    this.sim = sim
    this.url = opts.url
    this.transform = opts.transform ?? DEFAULT_TRANSFORM
    this.onChange = opts.onChange ?? (() => {})
    this.client = new RosbridgeClient(opts.url, {
      ...(opts.webSocketImpl !== undefined ? { webSocketImpl: opts.webSocketImpl } : {}),
      ...(opts.initialBackoffMs !== undefined ? { initialBackoffMs: opts.initialBackoffMs } : {}),
      onStatus: (status, detail) => this.handleStatus(status, detail),
    })
    this.client.subscribe<StringMsg>(FLEET_STATUS_TOPIC, MSG_TYPES.string, (msg) => this.handleFleetStatus(msg))
    for (const ns of opts.robots ?? []) this.registerRobot(ns, '100kg')
  }

  /** UI-facing connection state (chip in the top bar). */
  get status(): RosConnState {
    switch (this.client.status) {
      case 'connected':
        return 'connected'
      case 'idle':
      case 'connecting':
        return 'connecting'
      default:
        return 'error'
    }
  }

  connect(): void {
    this.appendEvent('SIM', `Connecting to rosbridge at ${this.url} …`)
    this.client.connect()
  }

  /** Skip the backoff wait (RETRY button). */
  retryNow(): void {
    this.client.retryNow()
  }

  dispose(): void {
    this.disposed = true
    this.client.close()
  }

  /**
   * Render-interpolation alpha for the map, mirroring the sim driver's
   * contract: fraction of the expected odometry period elapsed since the
   * last position update. Called once per animation frame with the frame dt.
   */
  renderAlpha(dtMs: number): number {
    this.sinceOdomMs += dtMs
    return Math.min(this.sinceOdomMs / ODOM_PERIOD_MS, 0.999)
  }

  // --- Commands (same CommandResult contract as FleetSim) -----------------

  /** Send a robot to a named station by publishing a Nav2-style goal pose. */
  commandGoto(robotId: string, stationName: string, source: CommandSource): CommandResult {
    const r = this.sim.getRobot(robotId)
    const station = STATIONS.find((s) => s.name === stationName)
    if (!station) return this.rejected(robotId, 'goto', stationName, source, `Unknown station "${stationName}"`)
    if (station.kind === 'charger') return this.commandCharge(robotId, source, stationName)
    const blocked = this.publishBlockReason(r)
    if (blocked) return this.rejected(robotId, 'goto', stationName, source, blocked)

    const k = this.byId.get(robotId)
    if (!k) return this.rejected(robotId, 'goto', stationName, source, `${robotId} has no bridge namespace`)
    this.publishGoal(k, station.dock.x, station.dock.y)
    r.mission = { kind: 'goto', target: { ...station.dock }, label: stationName }
    return this.accepted(robotId, 'goto', stationName, source, `${robotId} goal published → ${stationName} (/${k.ns}/goal_pose)`)
  }

  /**
   * "Charge" over the bridge is a goal pose at the bay's dock cell — docking
   * and the charge cycle are the robot's own behavior; the console just
   * watches /battery_state. Named bay respected; otherwise nearest bay by
   * grid distance (no occupancy knowledge without a fleet manager).
   */
  commandCharge(robotId: string, source: CommandSource, preferredBay?: string): CommandResult {
    const r = this.sim.getRobot(robotId)
    const label = preferredBay ?? 'charge'
    if (preferredBay !== undefined && !(CHARGER_NAMES as readonly string[]).includes(preferredBay)) {
      return this.rejected(robotId, 'charge', preferredBay, source, `Unknown charge bay "${preferredBay}"`)
    }
    const blocked = this.publishBlockReason(r)
    if (blocked) return this.rejected(robotId, 'charge', label, source, blocked)

    const bay = preferredBay ?? this.nearestBay(r)
    const k = this.byId.get(robotId)
    if (!k) return this.rejected(robotId, 'charge', bay, source, `${robotId} has no bridge namespace`)
    const dock = getStation(bay).dock
    this.publishGoal(k, dock.x, dock.y)
    r.mission = { kind: 'charge', target: { ...dock }, label: bay }
    return this.accepted(
      robotId,
      'charge',
      bay,
      source,
      `${robotId} goal published → ${bay} (docking is robot-side; battery tracked via /${k.ns}/battery_state)`,
    )
  }

  /** No plain-topic equivalent — replanning is a Nav2 action. Refused, honestly. */
  commandReroute(robotId: string, source: CommandSource): CommandResult {
    this.sim.getRobot(robotId) // validate id
    return this.rejected(robotId, 'reroute', 'route', source, 'Reroute needs the Nav2 replanning action interface — not available over this bridge')
  }

  /** Tasks live in a fleet manager the console is not integrated with. */
  commandAbortTask(robotId: string, source: CommandSource): CommandResult {
    this.sim.getRobot(robotId) // validate id
    return this.rejected(robotId, 'abort', 'task', source, 'Task management requires fleet-manager integration — not available in ROS mode')
  }

  // --- E-stop (publishes std_msgs/Bool, mirrors state locally) -------------

  estopRobot(id: string): void {
    this.publishEstop(id, true)
    this.sim.estopRobot(id)
    this.onChange()
  }

  resumeRobot(id: string): void {
    this.publishEstop(id, false)
    this.sim.resumeRobot(id)
    this.onChange()
  }

  estopAll(): void {
    for (const r of this.sim.robots) this.publishEstop(r.id, true)
    this.sim.estopAll()
    this.onChange()
  }

  resumeAll(): void {
    for (const r of this.sim.robots) this.publishEstop(r.id, false)
    this.sim.resumeAll()
    this.onChange()
  }

  // --- Incoming ------------------------------------------------------------

  private handleStatus(status: RosbridgeStatus, detail: string): void {
    if (this.disposed) return
    if (status === 'connected') {
      this.lastError = null
      this.appendEvent('SIM', `Connected to rosbridge at ${this.url} — waiting for ${FLEET_STATUS_TOPIC} and odometry`)
    } else if (status === 'error') {
      this.lastError = detail
      // Log the first failure of a streak, then every 5th, to keep the log honest but readable.
      if (this.client.attempts === 1 || this.client.attempts % 5 === 0) {
        this.appendEvent('SIM', `rosbridge: ${detail}`)
      }
    }
    this.onChange()
  }

  private handleFleetStatus(msg: StringMsg): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(msg.data)
    } catch {
      this.warnBadStatusPayload()
      return
    }
    const robots = (parsed as { robots?: unknown }).robots
    if (!Array.isArray(robots)) {
      this.warnBadStatusPayload()
      return
    }
    for (const entry of robots) {
      if (typeof entry === 'string') {
        this.registerRobot(entry, '100kg')
      } else if (entry !== null && typeof entry === 'object' && typeof (entry as { ns?: unknown }).ns === 'string') {
        const model = (entry as { model?: unknown }).model
        this.registerRobot((entry as { ns: string }).ns, isRobotClass(model) ? model : '100kg')
      }
    }
  }

  private registerRobot(nsRaw: string, cls: RobotClass): void {
    const ns = nsRaw.replace(/^\//, '')
    if (ns === '' || this.known.has(ns)) return
    const id = nsToRobotId(ns)
    if (this.byId.has(id)) return // two namespaces mapping to one id — first wins
    const k: KnownRobot = {
      ns,
      id,
      cls,
      battery: null,
      firstOdomAtMs: null,
      warnedOffGrid: false,
      warnedNoBattery: false,
    }
    this.known.set(ns, k)
    this.byId.set(id, k)
    this.client.subscribe<Odometry>(`/${ns}/odom`, MSG_TYPES.odometry, (m) => this.handleOdom(k, m))
    this.client.subscribe<BatteryState>(`/${ns}/battery_state`, MSG_TYPES.batteryState, (m) => this.handleBattery(k, m))
    this.client.advertise(`/${ns}/goal_pose`, MSG_TYPES.poseStamped)
    this.client.advertise(`/${ns}/emergency_stop`, MSG_TYPES.bool)
    this.appendEvent('SIM', `Discovered ${id} on the bridge (/${ns}) — waiting for odometry`, id)
    this.onChange()
  }

  private handleOdom(k: KnownRobot, msg: Odometry): void {
    const pos = msg.pose.pose.position
    const g = worldToGrid(this.transform, pos.x, pos.y)
    const inBounds = g.x >= 0 && g.x <= GRID_W - 1 && g.y >= 0 && g.y <= GRID_H - 1
    if (!inBounds && !k.warnedOffGrid) {
      k.warnedOffGrid = true
      this.appendEvent(
        'TRAFFIC',
        `${k.id} odometry (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)} m) maps outside the warehouse grid — adjust the scale/offset transform (docs/ROS2.md)`,
        k.id,
      )
    }
    const cx = Math.min(GRID_W - 2, Math.max(1, g.x))
    const cy = Math.min(GRID_H - 2, Math.max(1, g.y))

    let r = this.sim.robots.find((x) => x.id === k.id)
    if (!r) {
      const admitted = this.admitRobot(k, cx, cy)
      if (!admitted) return // holding for first battery_state
      r = admitted
    }

    // Keep rendered motion continuous: fold the in-flight interpolation into
    // prev before adopting the new fix (per-robot smoothing independent of
    // the shared alpha reset below).
    const alphaNow = Math.min(this.sinceOdomMs / ODOM_PERIOD_MS, 1)
    r.prevX = r.prevX + (r.x - r.prevX) * alphaNow
    r.prevY = r.prevY + (r.y - r.prevY) * alphaNow
    r.x = cx
    r.y = cy
    r.gx = Math.round(cx)
    r.gy = Math.round(cy)

    const speed = Math.hypot(msg.twist.twist.linear.x, msg.twist.twist.linear.y)
    if (r.state !== 'estopped') {
      r.state = speed > MOVING_EPS ? 'moving' : 'idle'
    }

    // Goal-arrival presentation: a published goal is "reached" when the robot
    // reports itself stationary at the goal cell. Nav2 owns the real result.
    if (r.mission && r.state === 'idle') {
      const d = Math.hypot(r.x - r.mission.target.x, r.y - r.mission.target.y)
      if (d <= ARRIVE_CELLS) {
        this.appendEvent('ARRIVAL', `${r.id} reached ${r.mission.label ?? 'its goal'} (reported by odometry)`, r.id)
        r.mission = null
      }
    }

    this.sinceOdomMs = 0
    this.onChange()
  }

  /** Roster admission: needs a position (have it) and ideally a battery fix.
   * If no battery_state shows up within BATTERY_WAIT_MS, admit anyway at 0%
   * with an explicit log line — never invent a charge level. */
  private admitRobot(k: KnownRobot, cx: number, cy: number): Robot | null {
    const now = Date.now()
    if (k.battery === null) {
      if (k.firstOdomAtMs === null) {
        k.firstOdomAtMs = now
        return null
      }
      if (now - k.firstOdomAtMs < BATTERY_WAIT_MS) return null
      if (!k.warnedNoBattery) {
        k.warnedNoBattery = true
        this.appendEvent('BATTERY', `No /${k.ns}/battery_state received — ${k.id} battery shown as 0% until data arrives`, k.id)
      }
    }
    const r = this.sim.addExternalRobot(k.id, k.cls, cx, cy, k.battery ?? 0)
    if (this.sim.globalEstop) {
      // Fleet-wide e-stop is latched: new arrivals get halted too.
      this.publishEstop(k.id, true)
      this.sim.estopRobot(k.id, true)
    }
    return r
  }

  private handleBattery(k: KnownRobot, msg: BatteryState): void {
    k.battery = normalizeBatteryPct(msg.percentage)
    const r = this.sim.robots.find((x) => x.id === k.id)
    if (r) {
      r.battery = k.battery
      this.onChange()
    }
  }

  // --- Outgoing ------------------------------------------------------------

  private publishGoal(k: KnownRobot, cellX: number, cellY: number): void {
    const w = gridToWorld(this.transform, cellX, cellY)
    const goal: PoseStamped = {
      header: { stamp: rosNow(), frame_id: 'map' },
      pose: { position: { x: w.x, y: w.y, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
    }
    this.client.publish(`/${k.ns}/goal_pose`, goal)
  }

  private publishEstop(robotId: string, engaged: boolean): void {
    const k = this.byId.get(robotId)
    if (!k) return
    if (!this.client.isConnected()) {
      this.appendEvent(
        'OPERATOR_ACTION',
        `${robotId} ${engaged ? 'e-stop' : 'release'} latched locally — bridge disconnected, /${k.ns}/emergency_stop NOT published`,
        robotId,
      )
      return
    }
    const msg: BoolMsg = { data: engaged }
    this.client.publish(`/${k.ns}/emergency_stop`, msg)
  }

  /** Reason a command cannot be published right now, or null. */
  private publishBlockReason(r: Robot): string | null {
    if (r.state === 'estopped') return `${r.id} is e-stopped — release it before commanding`
    if (!this.client.isConnected()) return `Bridge is ${this.status} — command not sent`
    return null
  }

  private nearestBay(r: Robot): string {
    let best: string = CHARGER_NAMES[0]
    let bestDist = Infinity
    for (const name of CHARGER_NAMES) {
      const dock = getStation(name).dock
      const d = Math.abs(r.gx - dock.x) + Math.abs(r.gy - dock.y)
      if (d < bestDist) {
        best = name
        bestDist = d
      }
    }
    return best
  }

  // --- Bookkeeping (same commandLog/event shape as the sim's command API) --

  private accepted(robotId: string, command: OperatorCommand['command'], target: string, source: CommandSource, summary: string): CommandResult {
    this.sim.commandLog.push({ tick: this.sim.tick, robotId, command, target, source, ok: true })
    this.appendEvent('OPERATOR_ACTION', `Operator [${source}]: ${summary}`, robotId)
    this.onChange()
    return { ok: true }
  }

  private rejected(robotId: string, command: OperatorCommand['command'], target: string, source: CommandSource, reason: string): CommandResult {
    this.sim.commandLog.push({ tick: this.sim.tick, robotId, command, target, source, ok: false, reason })
    this.appendEvent('OPERATOR_ACTION', `Operator [${source}]: command refused — ${reason}`, robotId)
    this.onChange()
    return { ok: false, reason }
  }

  private appendEvent(type: 'SIM' | 'TRAFFIC' | 'ARRIVAL' | 'BATTERY' | 'OPERATOR_ACTION', message: string, robotId?: string): void {
    this.sim.events.append(this.sim.tick, type, message, robotId !== undefined ? { robotId } : undefined)
  }

  private warnBadStatusPayload(): void {
    if (this.warnedBadStatusPayload) return
    this.warnedBadStatusPayload = true
    this.appendEvent('SIM', `Malformed ${FLEET_STATUS_TOPIC} payload — expected JSON {"robots":[{"ns":"amr_6"}, …]}`)
  }
}
