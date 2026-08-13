/**
 * FleetStore: a small pub/sub wrapper around the FleetSim used by the React
 * layer. Components subscribe via useSyncExternalStore; the canvas renderer
 * reads the sim directly each animation frame.
 *
 * The store owns:
 * - the fixed-timestep driver: the map's requestAnimationFrame loop calls
 *   advance(dtMs) and gets back the interpolation alpha (fraction of a tick
 *   elapsed) for smooth 60 fps rendering between 10 Hz sim ticks;
 * - console UI state that the sim must not know about (robot selection);
 * - thin wrappers for every operator action, so all mutation flows through
 *   one seam and every mutation notifies subscribers.
 *
 * getSnapshot returns a monotonic version counter (bumped on every notify),
 * so both sim ticks and pure-UI changes (selection) invalidate renders.
 */

import { FleetSim } from './sim/sim'
import type { CommandResult, CommandSource, SimOptions } from './sim/sim'
import { TICK_MS } from './sim/sim'
import { DEFAULT_BRIDGE_URL, RosFleetBridge } from './ros/fleet'
import type { GridTransform } from './ros/transform'
import { DEFAULT_TRANSFORM } from './ros/transform'

export type SimSpeed = 1 | 2 | 4

/**
 * Where fleet data comes from:
 * - 'simulation': the built-in deterministic engine (default) — full feature
 *   set (tasks, help requests, KPIs), honestly badged SIMULATION.
 * - 'ros': a rosbridge websocket — poses/battery/motion state are live from
 *   ROS topics; goto/e-stop publish real messages; sim-only features (task
 *   generation, exception detection, KPIs) are disabled and say why.
 */
export type DataSource = 'simulation' | 'ros'

const MAX_STEPS_PER_FRAME = 40

/**
 * In ROS mode the event log and top-bar clock show real wall time (live data
 * is not the deterministic sim). formatSimClock renders `tick` as seconds
 * since 06:00:00, so this maps the current local time onto that scale.
 */
function wallClockTick(): number {
  const d = new Date()
  const secs = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000
  return Math.floor(((secs - 6 * 3600 + 86400) % 86400) * 10)
}

export class FleetStore {
  paused = false
  speed: SimSpeed = 1
  /** Robot selected in the console (map ring + roster highlight + drawer). */
  selectedRobotId: string | null = null

  dataSource: DataSource = 'simulation'
  /** Bridge adapter while dataSource === 'ros' (UI reads status/lastError). */
  ros: RosFleetBridge | null = null
  rosUrl = DEFAULT_BRIDGE_URL
  rosTransform: GridTransform = DEFAULT_TRANSFORM
  /** Namespaces to pre-register on connect (bypasses /fleet/status discovery). */
  rosPresetRobots: string[] = []

  private simEngine: FleetSim
  private _sim: FleetSim
  private listeners = new Set<() => void>()
  private acc = 0
  private version = 0

  constructor(seed: number, opts: Omit<SimOptions, 'seed'> = {}) {
    this.simEngine = new FleetSim({ seed, ...opts })
    this._sim = this.simEngine
  }

  /** The active fleet model: the simulation engine, or the ROS-mode roster
   * (a never-stepped FleetSim fed by the bridge). */
  get sim(): FleetSim {
    return this._sim
  }

  // Data source ------------------------------------------------------------

  setDataSource(source: DataSource, url?: string): void {
    if (url !== undefined) this.rosUrl = url
    if (source === this.dataSource) {
      if (source === 'ros' && url !== undefined && this.ros && this.ros.url !== url) this.connectRos()
      return
    }
    this.dataSource = source
    this.paused = false
    this.selectedRobotId = null
    if (source === 'ros') {
      this.connectRos()
    } else {
      this.disposeRos()
      this._sim = this.simEngine
      this.notify()
    }
  }

  /** (Re)connect the bridge — RETRY button, or APPLY with a new URL. */
  reconnectRos(url?: string): void {
    if (url !== undefined) this.rosUrl = url
    if (this.dataSource !== 'ros') {
      this.setDataSource('ros')
      return
    }
    if (this.ros && url === undefined) {
      // Same endpoint: skip the backoff wait instead of rebuilding the roster.
      this.ros.retryNow()
      this.notify()
      return
    }
    this.connectRos()
  }

  private connectRos(): void {
    this.disposeRos()
    this.selectedRobotId = null
    // A fresh, empty, never-stepped FleetSim is the ROS-mode roster + event
    // log; all robot state in it is written by the bridge.
    const rosSim = new FleetSim({
      seed: 1,
      fleet: [],
      autoGenerate: false,
      helpRates: { pathBlocked: 0, lowConfidence: 0, stuckAtPick: 0 },
      initialTick: wallClockTick(),
    })
    this._sim = rosSim
    this.ros = new RosFleetBridge(rosSim, {
      url: this.rosUrl,
      transform: this.rosTransform,
      robots: this.rosPresetRobots,
      onChange: () => this.notify(),
    })
    this.ros.connect()
    this.notify()
  }

  private disposeRos(): void {
    if (this.ros) {
      this.ros.dispose()
      this.ros = null
    }
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** Snapshot version for useSyncExternalStore: bumps on every notify. */
  getSnapshot = (): number => this.version

  /**
   * Advance sim time by dtMs of real time (scaled by the speed multiplier),
   * stepping the fixed-timestep loop as many whole ticks as fit. Returns the
   * interpolation alpha in [0, 1) for rendering.
   */
  advance(dtMs: number): number {
    if (this.dataSource === 'ros') {
      // The ROS-mode "sim" is never stepped — robot state arrives over the
      // bridge. The tick tracks wall time so the clock and event timestamps
      // are real, and its 10 Hz change is the UI heartbeat in this mode.
      const t = wallClockTick()
      if (t !== this._sim.tick) {
        this._sim.tick = t
        this.notify()
      }
      return this.ros ? this.ros.renderAlpha(dtMs) : 0
    }
    if (this.paused) return Math.min(this.acc / TICK_MS, 0.999)
    this.acc += dtMs * this.speed
    let steps = 0
    while (this.acc >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
      this.sim.step()
      this.acc -= TICK_MS
      steps++
    }
    if (this.acc >= TICK_MS) this.acc = 0 // dropped frames: don't spiral
    if (steps > 0) this.notify()
    return Math.min(this.acc / TICK_MS, 0.999)
  }

  setPaused(p: boolean): void {
    if (this.paused === p) return
    this.paused = p
    this.notify()
  }

  setSpeed(s: SimSpeed): void {
    if (this.speed === s) return
    this.speed = s
    this.notify()
  }

  // Selection (console UI state — never seen by the sim)

  selectRobot(id: string | null): void {
    if (this.selectedRobotId === id) return
    if (id !== null) this.sim.getRobot(id) // validate: throws on unknown id
    this.selectedRobotId = id
    this.notify()
  }

  selectedRobot() {
    return this.selectedRobotId ? this.sim.getRobot(this.selectedRobotId) : null
  }

  // Operator actions (thin wrappers; every one notifies). In ROS mode the
  // same calls route to the bridge, which publishes real messages — the
  // command consumers (map, drawer, chat executor) never know the difference.

  resolveHelp(helpId: string, optionId: string): void {
    if (this.dataSource === 'ros') return // no help requests exist in ROS mode
    this.sim.resolveHelp(helpId, optionId)
    this.notify()
  }

  /**
   * Send a robot to a named station. `source` labels the input modality
   * ('direct-manipulation' for map click / drawer controls, 'chat' for the
   * conversational agent) — see CommandSource in sim.ts.
   */
  commandStation(robotId: string, stationName: string, source: CommandSource = 'direct-manipulation'): CommandResult {
    const res = this.ros
      ? this.ros.commandGoto(robotId, stationName, source)
      : this.sim.commandGoto(robotId, stationName, source)
    this.notify()
    return res
  }

  commandCharge(robotId: string, source: CommandSource = 'direct-manipulation', preferredBay?: string): CommandResult {
    const res = this.ros
      ? this.ros.commandCharge(robotId, source, preferredBay)
      : this.sim.commandCharge(robotId, source, preferredBay)
    this.notify()
    return res
  }

  commandReroute(robotId: string, source: CommandSource = 'chat'): CommandResult {
    const res = this.ros ? this.ros.commandReroute(robotId, source) : this.sim.commandReroute(robotId, source)
    this.notify()
    return res
  }

  commandAbortTask(robotId: string, source: CommandSource = 'chat'): CommandResult {
    const res = this.ros ? this.ros.commandAbortTask(robotId, source) : this.sim.commandAbortTask(robotId, source)
    this.notify()
    return res
  }

  /**
   * Append an operator-tagged event for chat-modality actions that have no
   * sim-level command seam of their own (soft stops, status queries,
   * destructive-command confirmations). Keeps the event log a complete
   * command + confirmation trace for the modality study.
   */
  logOperator(message: string, robotId?: string): void {
    this.sim.events.append(
      this.sim.tick,
      'OPERATOR_ACTION',
      `Operator [chat]: ${message}`,
      robotId !== undefined ? { robotId } : undefined,
    )
    this.notify()
  }

  estopAll(): void {
    if (this.ros) this.ros.estopAll()
    else this.sim.estopAll()
    this.notify()
  }

  resumeAll(): void {
    if (this.ros) this.ros.resumeAll()
    else this.sim.resumeAll()
    this.notify()
  }

  estopRobot(id: string): void {
    if (this.ros) this.ros.estopRobot(id)
    else this.sim.estopRobot(id)
    this.notify()
  }

  resumeRobot(id: string): void {
    if (this.ros) this.ros.resumeRobot(id)
    else this.sim.resumeRobot(id)
    this.notify()
  }

  setAutoGenerate(on: boolean): void {
    this.sim.setAutoGenerate(on)
    this.notify()
  }

  private notify(): void {
    this.version++
    for (const fn of this.listeners) fn()
  }
}

/** The shift seed. Changing it produces a different (but equally repeatable)
 * shift; the guided-demo test replays its script against this exact seed. */
export const APP_SEED = 20260704

/** App-wide store instance. Seed chosen once; change it to see a new shift. */
export const fleetStore = new FleetStore(APP_SEED)

/**
 * URL-driven startup so demos and scripted runs are reproducible:
 *   ?source=ros                     start in ROS BRIDGE mode
 *   ?bridge=ws://host:9090          rosbridge websocket URL
 *   ?robots=amr_1,amr_2             pre-register namespaces (skip /fleet/status)
 *   ?cellm=0.5&originx=22&originy=13  world->grid transform (see docs/ROS2.md)
 */
function applyUrlParams(store: FleetStore): void {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.search)
  const bridge = params.get('bridge')
  if (bridge !== null && bridge !== '') store.rosUrl = bridge
  const robots = params.get('robots')
  if (robots !== null && robots !== '') {
    store.rosPresetRobots = robots.split(',').map((s) => s.trim()).filter((s) => s !== '')
  }
  const cellm = Number(params.get('cellm'))
  const originx = Number(params.get('originx'))
  const originy = Number(params.get('originy'))
  store.rosTransform = {
    metersPerCell: Number.isFinite(cellm) && cellm > 0 ? cellm : store.rosTransform.metersPerCell,
    originCellX: params.get('originx') !== null && Number.isFinite(originx) ? originx : store.rosTransform.originCellX,
    originCellY: params.get('originy') !== null && Number.isFinite(originy) ? originy : store.rosTransform.originCellY,
  }
  if (params.get('source') === 'ros') store.setDataSource('ros')
}
applyUrlParams(fleetStore)

// Debug hook for browser automation and manual poking during development.
declare global {
  interface Window {
    __fleetStore?: FleetStore
  }
}
if (typeof window !== 'undefined') {
  window.__fleetStore = fleetStore
}
