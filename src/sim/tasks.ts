/**
 * Task model and queue for the Fleetline simulation.
 *
 * A task is PICK from a rack cell -> DELIVER to a named station. Tasks carry
 * a priority (1 = highest) and a minimum payload class. The auto-generator is
 * toggleable and driven entirely by the seeded RNG passed in, so a given seed
 * reproduces the exact same order stream.
 */

import type { Vec2 } from './types'
import { manhattan } from './types'
import type { Rng } from './rng'
import type { Robot, RobotClass } from './robot'
import { canCarry, MIN_ASSIGN_BATTERY } from './robot'
import { DELIVERY_STATIONS, getStation, PICK_SPOTS } from './warehouse'

export type TaskPriority = 1 | 2 | 3

export type TaskState = 'queued' | 'assigned' | 'completed' | 'aborted'

export interface Task {
  id: string
  /** Rack cell holding the load. */
  pickRack: Vec2
  /** Walkable cell the robot stands on to pick. */
  pickApproach: Vec2
  /** Which rack row the pick is in (e.g. "R3") — for operator-facing text. */
  rackRow: string
  /** Destination station name (e.g. "PACK-1"). */
  stationName: string
  /** Walkable dock cell of the destination station. */
  dropCell: Vec2
  /** Minimum payload class required to carry this load. */
  requiredClass: RobotClass
  priority: TaskPriority
  state: TaskState
  createdTick: number
  /** Tick at which the task was (last) assigned. */
  startedTick: number | null
  completedTick: number | null
  assignedTo: string | null
}

export interface TaskParams {
  id: string
  pickRack: Vec2
  pickApproach: Vec2
  rackRow: string
  stationName: string
  requiredClass: RobotClass
  priority: TaskPriority
  createdTick: number
}

export function makeTask(p: TaskParams): Task {
  return {
    id: p.id,
    pickRack: { ...p.pickRack },
    pickApproach: { ...p.pickApproach },
    rackRow: p.rackRow,
    stationName: p.stationName,
    dropCell: { ...getStation(p.stationName).dock },
    requiredClass: p.requiredClass,
    priority: p.priority,
    state: 'queued',
    createdTick: p.createdTick,
    startedTick: null,
    completedTick: null,
    assignedTo: null,
  }
}

/** Generate a random task from the seeded RNG. */
export function generateTask(rng: Rng, tick: number, seq: number): Task {
  const spot = PICK_SPOTS[Math.floor(rng() * PICK_SPOTS.length)]

  const stationRoll = rng()
  const stationName =
    stationRoll < 0.4 ? DELIVERY_STATIONS[0] : stationRoll < 0.8 ? DELIVERY_STATIONS[1] : DELIVERY_STATIONS[2]

  const classRoll = rng()
  const requiredClass: RobotClass = classRoll < 0.6 ? '100kg' : classRoll < 0.85 ? '600kg' : '1500kg'

  const prioRoll = rng()
  const priority: TaskPriority = prioRoll < 0.15 ? 1 : prioRoll < 0.6 ? 2 : 3

  return makeTask({
    id: `T-${String(seq).padStart(3, '0')}`,
    pickRack: spot.rack,
    pickApproach: spot.approach,
    rackRow: spot.rackRow,
    stationName,
    requiredClass,
    priority,
    createdTick: tick,
  })
}

/**
 * Priority queue over tasks. Ordering: priority ascending (1 first), then
 * creation tick ascending (older first).
 */
export class TaskQueue {
  readonly tasks: Task[] = []

  add(task: Task): void {
    this.tasks.push(task)
  }

  get(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id)
  }

  /** Queued tasks in assignment order. */
  queued(): Task[] {
    return this.tasks
      .filter((t) => t.state === 'queued')
      .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.createdTick - b.createdTick))
  }

  countByState(state: TaskState): number {
    return this.tasks.reduce((n, t) => n + (t.state === state ? 1 : 0), 0)
  }
}

/**
 * Assignment policy: the nearest idle robot (Manhattan distance to the pick
 * approach) whose payload class is sufficient and whose battery is above the
 * assignment floor. Returns null when no robot qualifies.
 */
export function selectRobotForTask(task: Task, robots: ReadonlyArray<Robot>): Robot | null {
  let best: Robot | null = null
  let bestDist = Infinity
  for (const r of robots) {
    if (r.state !== 'idle') continue
    if (r.battery < MIN_ASSIGN_BATTERY) continue
    if (r.waitingForCharger) continue
    if (!canCarry(r, task.requiredClass)) continue
    const d = manhattan(r.gx, r.gy, task.pickApproach.x, task.pickApproach.y)
    if (d < bestDist) {
      best = r
      bestDist = d
    }
  }
  return best
}
