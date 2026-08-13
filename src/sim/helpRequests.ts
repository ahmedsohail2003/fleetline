/**
 * Supervised-autonomy help requests for the Fleetline simulation.
 *
 * Robots escalate to the operator when autonomy hits an exception it is not
 * confident resolving alone. Each request carries the robot id, a
 * human-readable reason, and a closed set of resolution options. Requests
 * fire probabilistically from the seeded RNG (rates configurable per sim),
 * and resolving one changes the robot's behavior accordingly (see sim.ts).
 */

import type { Rng } from './rng'

export type HelpKind = 'PATH_BLOCKED' | 'LOW_CONFIDENCE' | 'STUCK_AT_PICK'

export interface HelpOption {
  id: string
  label: string
  /** Short consequence description shown to the operator. */
  detail: string
}

export interface HelpRequest {
  id: string
  kind: HelpKind
  robotId: string
  reason: string
  options: HelpOption[]
  createdTick: number
  state: 'open' | 'resolved'
  resolvedTick: number | null
  /** Option id chosen by the operator, once resolved. */
  resolution: string | null
  /** Kind-specific payload (e.g. the obstacle cell key for PATH_BLOCKED). */
  data: Record<string, string>
}

export const HELP_OPTIONS: Record<HelpKind, HelpOption[]> = {
  PATH_BLOCKED: [
    { id: 'reroute', label: 'Reroute', detail: 'Plan a new path around the obstruction' },
    { id: 'wait', label: 'Wait', detail: 'Hold position until the obstruction clears' },
    { id: 'abort', label: 'Abort task', detail: 'Cancel the task; robot returns to idle' },
  ],
  LOW_CONFIDENCE: [
    { id: 'confirm', label: 'Confirm position', detail: 'Position verified; continue the mission' },
    { id: 'staging', label: 'Send to staging', detail: 'Requeue the task and hold at STAGING' },
  ],
  STUCK_AT_PICK: [
    { id: 'retry', label: 'Retry pick', detail: 'Attempt the pick again' },
    { id: 'skip', label: 'Skip', detail: 'Return the task to the queue for another robot' },
    { id: 'abort', label: 'Abort task', detail: 'Cancel the task; robot returns to idle' },
  ],
}

/** Per-tick firing probabilities. Overridable per sim; set to 0 in tests. */
export interface HelpRates {
  /** While a robot is moving: an obstruction appears on its path. */
  pathBlocked: number
  /** While a robot is moving: localization confidence drops. */
  lowConfidence: number
  /** While a robot is executing a pick: the pick fails. */
  stuckAtPick: number
}

export const DEFAULT_HELP_RATES: HelpRates = {
  pathBlocked: 0.0012,
  lowConfidence: 0.0008,
  stuckAtPick: 0.002,
}

export function createHelpRequest(
  seq: number,
  kind: HelpKind,
  robotId: string,
  reason: string,
  tick: number,
  data: Record<string, string> = {},
): HelpRequest {
  return {
    id: `H-${String(seq).padStart(3, '0')}`,
    kind,
    robotId,
    reason,
    options: HELP_OPTIONS[kind].map((o) => ({ ...o })),
    createdTick: tick,
    state: 'open',
    resolvedTick: null,
    resolution: null,
    data,
  }
}

/**
 * Roll for a help event on a moving robot. Consumes exactly one RNG sample
 * so the stream stays deterministic regardless of the outcome.
 */
export function rollMovingHelp(rng: Rng, rates: HelpRates): HelpKind | null {
  const r = rng()
  if (r < rates.pathBlocked) return 'PATH_BLOCKED'
  if (r < rates.pathBlocked + rates.lowConfidence) return 'LOW_CONFIDENCE'
  return null
}

/** Roll for a pick failure on an executing robot. One RNG sample. */
export function rollPickHelp(rng: Rng, rates: HelpRates): HelpKind | null {
  return rng() < rates.stuckAtPick ? 'STUCK_AT_PICK' : null
}

export function isValidOption(kind: HelpKind, optionId: string): boolean {
  return HELP_OPTIONS[kind].some((o) => o.id === optionId)
}
