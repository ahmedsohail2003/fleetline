/**
 * AMR (autonomous mobile robot) model for the Fleetline simulation.
 *
 * Three payload classes with different footprints and speeds, a battery
 * model, and a supervised-autonomy state machine:
 *
 *   idle -> moving -> executing -> moving -> executing -> idle
 *                \-> blocked (traffic / obstacle wait)
 *                \-> awaiting_help (operator decision required)
 *   any  -> estopped -> (resume) -> previous state
 *   idle -> moving(to charger) -> charging -> idle
 */

import type { Vec2 } from './types'

export type RobotClass = '100kg' | '600kg' | '1500kg'

export type RobotState =
  | 'idle'
  | 'moving'
  | 'executing'
  | 'blocked'
  | 'awaiting_help'
  | 'charging'
  | 'estopped'

export interface RobotClassSpec {
  /** Human-readable payload class label. */
  label: string
  capacityKg: number
  /** Cruise speed in grid cells per second. */
  speedCellsPerSec: number
  /** Visual footprint as a fraction of one cell (also used for draw size). */
  footprint: number
  /** Battery percent consumed per 100 ms tick in each mode. */
  drainMovingPerTick: number
  drainExecutingPerTick: number
  drainIdlePerTick: number
  /** Battery percent restored per tick while docked at a charge bay. */
  chargePerTick: number
}

export const ROBOT_CLASS_SPECS: Record<RobotClass, RobotClassSpec> = {
  '100kg': {
    label: '100 kg',
    capacityKg: 100,
    speedCellsPerSec: 3.0,
    footprint: 0.62,
    drainMovingPerTick: 0.05,
    drainExecutingPerTick: 0.03,
    drainIdlePerTick: 0.004,
    chargePerTick: 0.35,
  },
  '600kg': {
    label: '600 kg',
    capacityKg: 600,
    speedCellsPerSec: 2.1,
    footprint: 0.76,
    drainMovingPerTick: 0.06,
    drainExecutingPerTick: 0.035,
    drainIdlePerTick: 0.005,
    chargePerTick: 0.3,
  },
  '1500kg': {
    label: '1500 kg',
    capacityKg: 1500,
    speedCellsPerSec: 1.5,
    footprint: 0.9,
    drainMovingPerTick: 0.08,
    drainExecutingPerTick: 0.04,
    drainIdlePerTick: 0.006,
    chargePerTick: 0.25,
  },
}

/** Below this battery percent an idle robot dispatches itself to a charge bay. */
export const CHARGE_THRESHOLD = 20
/** Charging robots return to service at this battery percent. */
export const CHARGE_RESUME = 90
/** Robots below this battery percent are not assigned new tasks. */
export const MIN_ASSIGN_BATTERY = 25

export type MissionKind = 'pick' | 'drop' | 'charge' | 'staging' | 'goto'

export interface Mission {
  kind: MissionKind
  target: Vec2
  /** Operator-facing destination name (e.g. "PACK-1") for 'goto'/'charge'. */
  label?: string
}

/** One line of a robot's recent task record (shown in the detail drawer). */
export interface TaskHistoryEntry {
  taskId: string
  outcome: 'completed' | 'aborted' | 'requeued'
  tick: number
}

/** How many task-history entries each robot retains. */
export const HISTORY_MAX = 8

export interface Robot {
  id: string
  cls: RobotClass
  /** Current grid cell. */
  gx: number
  gy: number
  /** Continuous position in cell units (integer = center of that cell). */
  x: number
  y: number
  /** Position at the previous tick, for render interpolation. */
  prevX: number
  prevY: number
  /** 0..1 progress from (gx, gy) toward path[pathIndex + 1]. */
  progress: number
  path: Vec2[]
  pathIndex: number
  state: RobotState
  /** State to restore when an e-stop is released. */
  resumeState: RobotState | null
  /** Battery percent, 0..100. */
  battery: number
  taskId: string | null
  mission: Mission | null
  phase: 'to_pick' | 'picking' | 'to_drop' | 'dropping' | null
  /** Ticks remaining for the current pick/drop action. */
  actionTicks: number
  /** Ticks spent waiting on a traffic conflict. */
  waitTicks: number
  /** Obstacle cell key this robot is waiting out (operator chose "wait"). */
  waitingObstacle: string | null
  /** Open help request id, if any. */
  helpId: string | null
  /** Limits help events to at most one per path leg / action phase. */
  helpFiredThisLeg: boolean
  /** Charge bay this robot is assigned to or docked at. */
  chargerName: string | null
  /** True when battery is low but every charge bay is occupied. */
  waitingForCharger: boolean
  /** Recent task outcomes, oldest first (capped at HISTORY_MAX). */
  history: TaskHistoryEntry[]
}

export function createRobot(id: string, cls: RobotClass, x: number, y: number, battery = 100): Robot {
  return {
    id,
    cls,
    gx: x,
    gy: y,
    x,
    y,
    prevX: x,
    prevY: y,
    progress: 0,
    path: [],
    pathIndex: 0,
    state: 'idle',
    resumeState: null,
    battery,
    taskId: null,
    mission: null,
    phase: null,
    actionTicks: 0,
    waitTicks: 0,
    waitingObstacle: null,
    helpId: null,
    helpFiredThisLeg: false,
    chargerName: null,
    waitingForCharger: false,
    history: [],
  }
}

export function specOf(robot: Robot): RobotClassSpec {
  return ROBOT_CLASS_SPECS[robot.cls]
}

/** True when `robot` can carry a task that requires `required` class. */
export function canCarry(robot: Robot, required: RobotClass): boolean {
  return ROBOT_CLASS_SPECS[robot.cls].capacityKg >= ROBOT_CLASS_SPECS[required].capacityKg
}

export function drainBattery(robot: Robot, mode: 'moving' | 'executing' | 'idle'): void {
  const spec = specOf(robot)
  const amount =
    mode === 'moving'
      ? spec.drainMovingPerTick
      : mode === 'executing'
        ? spec.drainExecutingPerTick
        : spec.drainIdlePerTick
  robot.battery = Math.max(0, robot.battery - amount)
}

export function chargeBattery(robot: Robot): void {
  robot.battery = Math.min(100, robot.battery + specOf(robot).chargePerTick)
}

export function needsCharge(robot: Robot): boolean {
  return robot.battery < CHARGE_THRESHOLD
}
