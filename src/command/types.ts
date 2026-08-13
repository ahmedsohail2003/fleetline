/**
 * Shared types for the Fleetline command console pipeline.
 *
 * A typed `Command` union is the contract between everything upstream
 * (deterministic grammar parser, optional LLM interpreter, clarification
 * clicks) and everything downstream (safety confirmation, executor, event
 * log). Both interpretation engines emit the same `ParseResult`, so the rest
 * of the pipeline never knows or cares which engine understood the sentence —
 * only the provenance chip in the UI does.
 */

/** Which robots a fleet-scoped command applies to. */
export type RobotScope =
  | { type: 'all' }
  | { type: 'robots'; ids: string[] }
  | { type: 'aisle'; aisle: number }

export type Command =
  /** Send robots to a named (non-charger) station. */
  | { kind: 'send'; robotIds: string[]; station: string }
  /** Send robots to charge: a named bay, or the nearest free one. */
  | { kind: 'charge'; robotIds: string[]; bay?: string }
  /** Soft-stop robots (per-robot halt latch; reversible with resume). */
  | { kind: 'pause'; scope: RobotScope }
  | { kind: 'resume'; scope: RobotScope }
  /** Replan the active route (also resolves an open PATH_BLOCKED request). */
  | { kind: 'reroute'; robotIds: string[] }
  /** Read-only status report. Empty robotIds = whole fleet. */
  | { kind: 'status'; robotIds: string[] }
  /** Cancel the active task outright (not requeued). Destructive. */
  | { kind: 'abort_task'; robotIds: string[] }
  /** Global emergency stop. Destructive. */
  | { kind: 'estop_all' }
  /** Release the global e-stop. Destructive (fleet starts moving). */
  | { kind: 'clear_estop' }
  /** Show what the console can do. */
  | { kind: 'help' }

/** A clickable answer to a clarification question. `input` is a complete
 * command sentence that is fed back through the parser when clicked. */
export interface ClarifyOption {
  label: string
  input: string
}

export type ParseResult =
  | { type: 'command'; command: Command }
  | { type: 'clarify'; question: string; options: ClarifyOption[] }
  | { type: 'unknown' }

/** Which engine produced a ParseResult (shown as a provenance chip). */
export type Engine = 'grammar' | 'llm'

/** Static vocabulary the parser and LLM validator check references against. */
export interface ParserContext {
  /** Fleet robot ids, e.g. ['AMR-1', …, 'AMR-5']. */
  robotIds: string[]
  /** Number of labeled aisles (1..aisleCount are valid). */
  aisleCount: number
  /** Canonical charge bay names, e.g. ['CHARGE-1', 'CHARGE-2', 'CHARGE-3']. */
  chargerNames: string[]
  /** Canonical non-charger destination names. */
  stationNames: string[]
}
