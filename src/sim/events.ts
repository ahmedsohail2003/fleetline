/**
 * Timestamped event log for the Fleetline simulation.
 *
 * Every state change, task assignment, arrival, help request, and operator
 * action is appended here with a sim-clock timestamp (never wall-clock time),
 * so the log is deterministic for a given seed and readable by operators.
 */

export type SimEventType =
  | 'SIM'
  | 'STATE_CHANGE'
  | 'TASK_CREATED'
  | 'TASK_ASSIGNED'
  | 'TASK_COMPLETED'
  | 'TASK_ABORTED'
  | 'TASK_REQUEUED'
  | 'ARRIVAL'
  | 'HELP_REQUEST'
  | 'HELP_RESOLVED'
  | 'OPERATOR_ACTION'
  | 'BATTERY'
  | 'TRAFFIC'

export interface SimEvent {
  seq: number
  tick: number
  /** Formatted sim clock, e.g. "06:03:41". */
  clock: string
  type: SimEventType
  robotId?: string
  taskId?: string
  message: string
}

/** Sim clock starts at 06:00:00 (shift start). One tick = 100 ms sim time. */
const SHIFT_START_SECONDS = 6 * 3600

export function formatSimClock(tick: number): string {
  const total = Math.floor(SHIFT_START_SECONDS + tick / 10)
  const h = Math.floor(total / 3600) % 24
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

export class EventLog {
  readonly events: SimEvent[] = []
  private seq = 0
  private readonly max: number

  constructor(max = 500) {
    this.max = max
  }

  append(
    tick: number,
    type: SimEventType,
    message: string,
    ids?: { robotId?: string; taskId?: string },
  ): SimEvent {
    const ev: SimEvent = {
      seq: this.seq++,
      tick,
      clock: formatSimClock(tick),
      type,
      message,
      ...(ids?.robotId !== undefined ? { robotId: ids.robotId } : {}),
      ...(ids?.taskId !== undefined ? { taskId: ids.taskId } : {}),
    }
    this.events.push(ev)
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max)
    return ev
  }

  /** Total events ever appended (survives ring-buffer trimming). */
  get totalAppended(): number {
    return this.seq
  }

  latest(n: number): SimEvent[] {
    return this.events.slice(-n)
  }
}
