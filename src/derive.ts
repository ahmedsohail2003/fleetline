/**
 * Pure derivations from sim state for the console UI.
 *
 * No React, no DOM: everything here is a plain function over sim objects so
 * it can be unit-tested alongside the engine. Components call these instead
 * of embedding presentation logic inline.
 */

import type { Robot, RobotState } from './sim/robot'
import type { SimEvent, SimEventType } from './sim/events'
import { DROP_TICKS, PICK_TICKS } from './sim/sim'

// ---------------------------------------------------------------------------
// Battery
// ---------------------------------------------------------------------------

export type BatteryLevel = 'ok' | 'warn' | 'danger'

/** Console battery thresholds: amber below 30%, red below 15%. */
export function batteryLevel(pct: number): BatteryLevel {
  if (pct < 15) return 'danger'
  if (pct < 30) return 'warn'
  return 'ok'
}

// ---------------------------------------------------------------------------
// Robot state chips (color is always paired with a text label)
// ---------------------------------------------------------------------------

export interface StateMeta {
  label: string
  /** CSS suffix: .chip-<tone>, matching the shared state palette. */
  tone: 'idle' | 'moving' | 'executing' | 'help' | 'estop' | 'charging'
}

export const ROBOT_STATE_META: Record<RobotState, StateMeta> = {
  idle: { label: 'IDLE', tone: 'idle' },
  moving: { label: 'MOVING', tone: 'moving' },
  executing: { label: 'EXECUTING', tone: 'executing' },
  blocked: { label: 'BLOCKED', tone: 'help' },
  awaiting_help: { label: 'NEEDS HELP', tone: 'help' },
  charging: { label: 'CHARGING', tone: 'charging' },
  estopped: { label: 'E-STOPPED', tone: 'estop' },
}

// ---------------------------------------------------------------------------
// Task progress
// ---------------------------------------------------------------------------

/** Fraction of the robot's current path leg already traveled, in [0, 1]. */
function legFraction(r: Robot): number {
  const legs = r.path.length - 1
  if (legs <= 0) return 1
  return Math.min(1, (r.pathIndex + r.progress) / legs)
}

/**
 * Coarse progress estimate for the robot's current task in [0, 1], or null
 * when it has no task. Phase weights: transit-to-pick 35%, pick 20%,
 * transit-to-drop 35%, drop 10%. An estimate for the roster progress bar —
 * not a physical quantity.
 */
export function taskProgress(r: Robot): number | null {
  if (!r.taskId) return null
  let p: number
  if (r.phase === 'picking') {
    p = 0.35 + 0.2 * (1 - r.actionTicks / PICK_TICKS)
  } else if (r.phase === 'to_drop') {
    p = 0.55 + 0.35 * legFraction(r)
  } else if (r.phase === 'dropping') {
    p = 0.9 + 0.1 * (1 - r.actionTicks / DROP_TICKS)
  } else {
    // En route to the pick face (phase not yet set).
    p = 0.35 * legFraction(r)
  }
  return Math.min(1, Math.max(0, p))
}

// ---------------------------------------------------------------------------
// Event log: categories, filters, and per-type presentation
// ---------------------------------------------------------------------------

export type EventCategory = 'tasks' | 'alerts' | 'operator' | 'system'

export function eventCategory(t: SimEventType): EventCategory {
  switch (t) {
    case 'TASK_CREATED':
    case 'TASK_ASSIGNED':
    case 'TASK_COMPLETED':
    case 'TASK_ABORTED':
    case 'TASK_REQUEUED':
    case 'ARRIVAL':
    case 'STATE_CHANGE':
      return 'tasks'
    case 'HELP_REQUEST':
    case 'BATTERY':
    case 'TRAFFIC':
      return 'alerts'
    case 'OPERATOR_ACTION':
    case 'HELP_RESOLVED':
      return 'operator'
    case 'SIM':
      return 'system'
  }
}

export type EventFilter = 'all' | 'tasks' | 'alerts' | 'operator'

export const EVENT_FILTERS: ReadonlyArray<{ id: EventFilter; label: string }> = [
  { id: 'all', label: 'ALL' },
  { id: 'tasks', label: 'TASKS' },
  { id: 'alerts', label: 'ALERTS' },
  { id: 'operator', label: 'OPERATOR' },
]

export function matchesFilter(ev: SimEvent, filter: EventFilter): boolean {
  return filter === 'all' || eventCategory(ev.type) === filter
}

export type EventTone = 'dim' | 'ok' | 'warn' | 'danger' | 'info' | 'brand' | 'charge'

export interface EventMeta {
  /** Short fixed-width tag rendered before the message. */
  tag: string
  tone: EventTone
}

export const EVENT_META: Record<SimEventType, EventMeta> = {
  SIM: { tag: 'SIM ', tone: 'dim' },
  STATE_CHANGE: { tag: 'FLOW', tone: 'dim' },
  ARRIVAL: { tag: 'FLOW', tone: 'dim' },
  TASK_CREATED: { tag: 'TASK', tone: 'info' },
  TASK_ASSIGNED: { tag: 'TASK', tone: 'info' },
  TASK_COMPLETED: { tag: 'TASK', tone: 'ok' },
  TASK_ABORTED: { tag: 'TASK', tone: 'danger' },
  TASK_REQUEUED: { tag: 'TASK', tone: 'warn' },
  HELP_REQUEST: { tag: 'HELP', tone: 'warn' },
  HELP_RESOLVED: { tag: 'HELP', tone: 'ok' },
  OPERATOR_ACTION: { tag: 'OPER', tone: 'brand' },
  BATTERY: { tag: 'BATT', tone: 'charge' },
  TRAFFIC: { tag: 'TRFC', tone: 'info' },
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** "42s" / "1m 42s" for KPI durations. Non-finite or negative -> "0s". */
export function formatDurationS(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return '0s'
  const total = Math.round(s)
  const m = Math.floor(total / 60)
  const sec = total % 60
  return m > 0 ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`
}

/** "m:ss" elapsed time from a tick count (10 ticks = 1 s). */
export function formatElapsedTicks(ticks: number): string {
  const s = Math.max(0, Math.floor(ticks / 10))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
