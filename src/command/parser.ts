/**
 * Deterministic grammar parser for the command console.
 *
 * Pure TypeScript, no network, no randomness: the same sentence always parses
 * to the same result, which is why this is the console's default (and the
 * fallback when the optional LLM mode misbehaves). The grammar is intent
 * patterns over a normalized sentence plus a fuzzy station matcher — small
 * enough to unit-test exhaustively, honest enough to say "I didn't catch
 * that" instead of guessing.
 *
 * Ambiguity is a first-class outcome, not an error: "send AMR-3 to packing"
 * returns a clarification question with clickable options (PACK-1 / PACK-2),
 * and each option is a complete sentence that re-enters this same parser.
 */

import { AISLES, CHARGER_NAMES, STATIONS } from '../sim/warehouse'
import type { ClarifyOption, Command, ParseResult, ParserContext, RobotScope } from './types'

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** Build the vocabulary context from the live fleet's robot ids. */
export function makeParserContext(robotIds: string[]): ParserContext {
  return {
    robotIds: [...robotIds],
    aisleCount: AISLES.length,
    chargerNames: [...CHARGER_NAMES],
    stationNames: STATIONS.filter((s) => s.kind !== 'charger').map((s) => s.name),
  }
}

// ---------------------------------------------------------------------------
// Normalization + small string tools
// ---------------------------------------------------------------------------

function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[.,!;:"()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Plain Levenshtein distance (small inputs only). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

/** Typo budget scales with word length: long words tolerate 2 edits. */
function fuzzyBudget(len: number): number {
  if (len >= 6) return 2
  if (len >= 4) return 1
  return 0
}

// ---------------------------------------------------------------------------
// Reference extraction: robots, aisles, "all"
// ---------------------------------------------------------------------------

const ROBOT_REF_RE = /\b(?:amr|robot|unit|bot)s?[\s-]?0*(\d{1,3})\b/g
const ALL_RE = /\b(all|every(?:one|thing|body)?|fleet)\b/
const AISLE_RE = /\baisles?[\s-]?0*(\d{1,3})\b/

interface RobotRefs {
  ids: string[]
  /** Referenced ids that are not in the fleet (e.g. "AMR-9"). */
  unknown: string[]
}

function extractRobots(input: string, ctx: ParserContext): RobotRefs {
  const ids: string[] = []
  const unknown: string[] = []
  for (const m of input.matchAll(ROBOT_REF_RE)) {
    const id = `AMR-${parseInt(m[1], 10)}`
    if (ctx.robotIds.includes(id)) {
      if (!ids.includes(id)) ids.push(id)
    } else if (!unknown.includes(id)) {
      unknown.push(id)
    }
  }
  return { ids, unknown }
}

// ---------------------------------------------------------------------------
// Station matching (fuzzy, alias-aware, honest about ambiguity)
// ---------------------------------------------------------------------------

const STATION_ALIASES: Record<string, string[]> = {
  RECEIVING: ['receiving', 'receive', 'receiving dock', 'the dock', 'dock', 'inbound', 'intake'],
  'PACK-1': ['pack-1', 'pack 1', 'pack1', 'packing 1', 'pack one', 'pack station 1', 'packing station 1'],
  'PACK-2': ['pack-2', 'pack 2', 'pack2', 'packing 2', 'pack two', 'pack station 2', 'packing station 2'],
  STAGING: ['staging', 'stage', 'staging area', 'holding', 'holding area', 'buffer'],
}

/** Phrases that mean "a packing station" without saying which. */
const PACK_FAMILY = ['pack', 'packing', 'pack station', 'packing station']

const CHARGE_PHRASE_RE = /^(?:a |the )?(?:re)?charg(?:e|er|ers|ing)?(?:\s*(?:bay|station|dock|point))?(?:[\s-]?0*(\d+))?$/
const CHARGE_WORD_RE = /\b(?:re)?charg(?:e|er|ers|ing)\b|\bcharge\b/
const CHARGE_BAY_RE = /\b(?:re)?charg(?:e|er|ing)?(?:\s*(?:bay|station|dock|point))?[\s-]0*(\d+)\b/

type StationMatch =
  | { kind: 'station'; name: string }
  | { kind: 'charge'; bayNumber?: number }
  | { kind: 'ambiguous'; names: string[] }
  | { kind: 'none' }

export function matchStation(phraseRaw: string): StationMatch {
  const phrase = phraseRaw.replace(/^(the|a) /, '').trim()
  if (phrase === '') return { kind: 'none' }

  const chargeM = CHARGE_PHRASE_RE.exec(phrase)
  if (chargeM) {
    return chargeM[1] !== undefined
      ? { kind: 'charge', bayNumber: parseInt(chargeM[1], 10) }
      : { kind: 'charge' }
  }

  // Exact alias hit wins outright.
  for (const [name, aliases] of Object.entries(STATION_ALIASES)) {
    if (aliases.includes(phrase)) return { kind: 'station', name }
  }
  if (PACK_FAMILY.includes(phrase)) return { kind: 'ambiguous', names: ['PACK-1', 'PACK-2'] }

  // Fuzzy pass: closest alias within the typo budget; ties across stations
  // are reported as ambiguity, never silently picked.
  let bestDist = Infinity
  let bestNames: string[] = []
  const consider = (name: string, alias: string): void => {
    const d = levenshtein(phrase, alias)
    if (d > fuzzyBudget(alias.length)) return
    if (d < bestDist) {
      bestDist = d
      bestNames = [name]
    } else if (d === bestDist && !bestNames.includes(name)) {
      bestNames.push(name)
    }
  }
  for (const [name, aliases] of Object.entries(STATION_ALIASES)) {
    for (const alias of aliases) consider(name, alias)
  }
  for (const alias of PACK_FAMILY) consider('PACK*', alias)

  if (bestNames.length === 1) {
    return bestNames[0] === 'PACK*'
      ? { kind: 'ambiguous', names: ['PACK-1', 'PACK-2'] }
      : { kind: 'station', name: bestNames[0] }
  }
  if (bestNames.length > 1) {
    const expanded = bestNames.flatMap((n) => (n === 'PACK*' ? ['PACK-1', 'PACK-2'] : [n]))
    return { kind: 'ambiguous', names: [...new Set(expanded)] }
  }
  return { kind: 'none' }
}

// ---------------------------------------------------------------------------
// Intent patterns
// ---------------------------------------------------------------------------

const HELP_RE = /^(help|\?|commands?|examples?|what can (you|i) (do|say)( here)?|what do you understand)$/
const ESTOP_RE = /\b(e-?stop|estop|emergency stop|emergency)\b/
const CLEAR_RE = /\b(clear|release|reset|lift|disengage|cancel)\b/
const STATUS_RE = /\b(status|state|report|battery|hows?|how is|wheres?|where is|whats?|what is)\b/
const REROUTE_RE = /\b(reroute|re-route|replan|re-plan)\b|\b(new|another|different|alternate)\s+(route|path)\b|\bfind (a )?(way|route|path) around\b/
const ABORT_RE = /\b(abort|cancel|scrap)\b/
const RESUME_RE = /\b(resume|continue|unpause|restart|carry on)\b|\brelease\b/
const PAUSE_RE = /\b(pause|hold|halt|stop|freeze|standby|stand down)\b/
const SEND_RE = /\b(send|move|dispatch|drive|take|bring|go|head|proceed|return|deliver)\b/

function cmd(command: Command): ParseResult {
  return { type: 'command', command }
}

function clarify(question: string, options: ClarifyOption[] = []): ParseResult {
  return { type: 'clarify', question, options }
}

function robotOptions(ctx: ParserContext, toInput: (id: string) => string): ClarifyOption[] {
  return ctx.robotIds.map((id) => ({ label: id, input: toInput(id) }))
}

function joinIds(ids: string[]): string {
  return ids.join(' and ')
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

export function parseCommand(rawInput: string, ctx: ParserContext): ParseResult {
  const input = normalize(rawInput)
  if (input === '') return { type: 'unknown' }

  if (HELP_RE.test(input)) return cmd({ kind: 'help' })

  const robots = extractRobots(input, ctx)
  if (robots.unknown.length > 0) {
    return clarify(
      `No ${robots.unknown.join(' or ')} in this fleet — the robots here are ${ctx.robotIds.join(', ')}.`,
    )
  }
  const ids = robots.ids
  const wantsAll = ALL_RE.test(input)

  const aisleM = AISLE_RE.exec(input)
  const aisle = aisleM ? parseInt(aisleM[1], 10) : null
  if (aisle !== null && (aisle < 1 || aisle > ctx.aisleCount)) {
    return clarify(`There is no Aisle ${aisle} — aisles here are numbered 1 to ${ctx.aisleCount}.`)
  }

  const scope = (): RobotScope => {
    if (ids.length > 0) return { type: 'robots', ids }
    if (aisle !== null) return { type: 'aisle', aisle }
    return { type: 'all' }
  }

  // --- Emergency stop family (checked first: safety wording is explicit) ---
  if (ESTOP_RE.test(input)) {
    if (CLEAR_RE.test(input)) return cmd({ kind: 'clear_estop' })
    if (ids.length > 0) return cmd({ kind: 'pause', scope: { type: 'robots', ids } })
    return cmd({ kind: 'estop_all' })
  }

  // --- Status (question forms first, so "is AMR-4 charging" is a query) ---
  if (STATUS_RE.test(input) || /^(is|are)\b/.test(input)) {
    return cmd({ kind: 'status', robotIds: ids })
  }

  // --- Reroute ---
  if (REROUTE_RE.test(input)) {
    if (ids.length > 0) return cmd({ kind: 'reroute', robotIds: ids })
    if (wantsAll) return cmd({ kind: 'reroute', robotIds: [...ctx.robotIds] })
    return clarify('Reroute which robot?', robotOptions(ctx, (id) => `reroute ${id}`))
  }

  // --- Abort task ---
  if (ABORT_RE.test(input)) {
    if (ids.length > 0) return cmd({ kind: 'abort_task', robotIds: ids })
    return clarify('Abort the task on which robot?', robotOptions(ctx, (id) => `abort task on ${id}`))
  }

  // --- Resume / pause (soft stop) ---
  if (RESUME_RE.test(input)) {
    return cmd({ kind: 'resume', scope: scope() })
  }
  if (PAUSE_RE.test(input)) {
    return cmd({ kind: 'pause', scope: scope() })
  }

  // --- Charge (before send, so "send AMR-4 to charge" lands here) ---
  if (CHARGE_WORD_RE.test(input)) {
    const bayM = CHARGE_BAY_RE.exec(input)
    let bay: string | undefined
    if (bayM) {
      const n = parseInt(bayM[1], 10)
      const name = `CHARGE-${n}`
      if (!ctx.chargerNames.includes(name)) {
        return clarify(`There is no ${name} — charge bays here are ${ctx.chargerNames.join(', ')}.`)
      }
      bay = name
    }
    const chargeIds = ids.length > 0 ? ids : wantsAll ? [...ctx.robotIds] : []
    if (chargeIds.length === 0) {
      return clarify(
        'Send which robot to charge?',
        robotOptions(ctx, (id) => `charge ${id}${bay ? ` at ${bay}` : ''}`),
      )
    }
    return cmd({ kind: 'charge', robotIds: chargeIds, ...(bay !== undefined ? { bay } : {}) })
  }

  // --- Send to station ---
  const toIdx = input.lastIndexOf(' to ')
  const destPhrase = toIdx >= 0 ? input.slice(toIdx + 4).trim() : null
  const sendVerb = SEND_RE.test(input)
  if (sendVerb || (destPhrase !== null && (ids.length > 0 || wantsAll))) {
    const sendIds = ids.length > 0 ? ids : wantsAll ? [...ctx.robotIds] : []

    if (destPhrase === null || destPhrase === '') {
      if (sendIds.length === 0) return { type: 'unknown' }
      return clarify(`Send ${joinIds(sendIds)} where?`, [
        ...ctx.stationNames.map((s) => ({ label: s, input: `send ${joinIds(sendIds)} to ${s}` })),
        { label: 'CHARGE', input: `send ${joinIds(sendIds)} to charge` },
      ])
    }

    const match = matchStation(destPhrase)
    if (match.kind === 'charge') {
      // Redundant with the charge branch for most phrasings; kept for safety.
      const bay = match.bayNumber !== undefined ? `CHARGE-${match.bayNumber}` : undefined
      if (bay !== undefined && !ctx.chargerNames.includes(bay)) {
        return clarify(`There is no ${bay} — charge bays here are ${ctx.chargerNames.join(', ')}.`)
      }
      if (sendIds.length === 0) {
        return clarify('Send which robot to charge?', robotOptions(ctx, (id) => `charge ${id}`))
      }
      return cmd({ kind: 'charge', robotIds: sendIds, ...(bay !== undefined ? { bay } : {}) })
    }
    if (match.kind === 'station') {
      if (sendIds.length === 0) {
        return clarify(
          `Send which robot to ${match.name}?`,
          robotOptions(ctx, (id) => `send ${id} to ${match.name}`),
        )
      }
      return cmd({ kind: 'send', robotIds: sendIds, station: match.name })
    }
    if (match.kind === 'ambiguous') {
      if (sendIds.length === 0) {
        return clarify(
          `Send which robot to ${destPhrase}?`,
          robotOptions(ctx, (id) => `send ${id} to ${destPhrase}`),
        )
      }
      return clarify(
        `"${destPhrase}" matches more than one station — which one?`,
        match.names.map((name) => ({ label: name, input: `send ${joinIds(sendIds)} to ${name}` })),
      )
    }
    // Unknown destination.
    return clarify(
      `I don't know a destination called "${destPhrase}". I can send robots to ${ctx.stationNames.join(', ')}, or a charge bay.`,
      sendIds.length > 0
        ? [
            ...ctx.stationNames.map((s) => ({ label: s, input: `send ${joinIds(sendIds)} to ${s}` })),
            { label: 'CHARGE', input: `send ${joinIds(sendIds)} to charge` },
          ]
        : [],
    )
  }

  // A bare robot reference reads as "how is it doing?".
  if (ids.length > 0) return cmd({ kind: 'status', robotIds: ids })

  return { type: 'unknown' }
}
