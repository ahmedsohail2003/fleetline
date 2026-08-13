/**
 * Optional LLM interpretation mode for the command console (bring your own
 * Gemini API key; without one the console is 100% grammar-parser and fully
 * usable offline).
 *
 * Trust model — the LLM is never allowed to act directly. It only proposes a
 * JSON object against a strict schema; a hand-rolled validator checks every
 * field against the warehouse vocabulary before anything reaches the
 * executor. The recovery loop is:
 *
 *   1. call the model (temperature 0, JSON response mode)
 *   2. validate the reply against the schema
 *   3. on failure: ONE corrective re-prompt quoting the exact validation
 *      error back to the model
 *   4. on a second failure (or any network/HTTP error): fall back to the
 *      deterministic grammar parser
 *
 * This validate -> corrective-reprompt -> deterministic-fallback pattern is
 * carried over from my earlier ai-alert-triage project, where the same loop
 * kept an LLM-assisted pipeline honest: model output is data to check, not
 * instructions to trust, and the system must degrade to a fully predictable
 * path.
 */

import type { ClarifyOption, Command, ParseResult, ParserContext } from './types'

export const DEFAULT_MODEL = 'gemini-2.5-flash'
const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const TIMEOUT_MS = 12000

export interface LlmSettings {
  apiKey: string
  model: string
}

export type LlmOutcome =
  | { source: 'llm'; result: ParseResult; retried: boolean }
  | { source: 'fallback'; reason: string }

// ---------------------------------------------------------------------------
// System prompt: warehouse vocabulary + strict JSON schema
// ---------------------------------------------------------------------------

export function buildSystemPrompt(ctx: ParserContext): string {
  return [
    'You translate one operator utterance for a simulated warehouse AMR (autonomous mobile robot) fleet-control console into exactly ONE JSON object. Reply with the JSON object only — no prose, no markdown fences.',
    '',
    `Fleet robots: ${ctx.robotIds.join(', ')} (operators may say "amr 3", "robot 3", "unit 3").`,
    `Stations: ${ctx.stationNames.join(', ')}. RECEIVING is the inbound dock ("dock", "inbound"). PACK-1 and PACK-2 are packing stations — "packing" alone is ambiguous between them. STAGING is a holding area.`,
    `Charge bays: ${ctx.chargerNames.join(', ')} — charging always uses the "charge" intent (never "send").`,
    `Aisles are numbered 1 to ${ctx.aisleCount}.`,
    '',
    'Schema — the object has an "intent" field with exactly one of these values, plus the listed fields:',
    '  {"intent":"send","robots":["AMR-2"],"station":"PACK-1"}            // station: one of ' + ctx.stationNames.join(' | '),
    '  {"intent":"charge","robots":["AMR-4"]}                              // optional "bay": one of ' + ctx.chargerNames.join(' | '),
    '  {"intent":"pause","scope":"all"}                                    // or {"scope":"aisle","aisle":2} or {"scope":"robots","robots":[...]}',
    '  {"intent":"resume","scope":"all"}                                   // same scope forms as pause',
    '  {"intent":"reroute","robots":["AMR-2"]}',
    '  {"intent":"status","robots":[]}                                     // empty robots = whole fleet',
    '  {"intent":"abort_task","robots":["AMR-2"]}',
    '  {"intent":"estop_all"}                                              // ONLY for explicit emergency-stop language',
    '  {"intent":"clear_estop"}',
    '  {"intent":"help"}',
    '  {"intent":"clarify","question":"Which packing station?","options":["send AMR-3 to PACK-1","send AMR-3 to PACK-2"]}',
    '  {"intent":"unknown"}',
    '',
    'Rules:',
    '- Robot ids must be exact (e.g. "AMR-3") and must exist in the fleet list above.',
    '- Use "clarify" when the utterance is a plausible fleet command but ambiguous or underspecified (unclear robot, "packing" without a number). Each option must be a complete replacement command sentence.',
    '- "pause" is a reversible soft stop; reserve "estop_all" for explicit emergency wording ("e-stop", "emergency stop").',
    '- Use "unknown" when the utterance is not a fleet command at all. Never invent robots, stations, or intents.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Hand-rolled validator: wire JSON -> ParseResult, or a specific error
// ---------------------------------------------------------------------------

export type ValidationOutcome = { ok: true; result: ParseResult } | { ok: false; error: string }

const INTENTS = [
  'send',
  'charge',
  'pause',
  'resume',
  'reroute',
  'status',
  'abort_task',
  'estop_all',
  'clear_estop',
  'help',
  'clarify',
  'unknown',
] as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function invalid(error: string): ValidationOutcome {
  return { ok: false, error }
}

function validRobots(v: unknown, ctx: ParserContext, allowEmpty: boolean): { ids: string[] } | { error: string } {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    return { error: '"robots" must be an array of robot id strings' }
  }
  const ids = (v as string[]).map((s) => s.toUpperCase().trim())
  if (!allowEmpty && ids.length === 0) return { error: '"robots" must name at least one robot' }
  for (const id of ids) {
    if (!ctx.robotIds.includes(id)) {
      return { error: `"${id}" is not in the fleet — robots are ${ctx.robotIds.join(', ')}` }
    }
  }
  return { ids }
}

/** Strip optional markdown fences some models wrap around JSON. */
export function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
}

export function validateLlmReply(text: string, ctx: ParserContext): ValidationOutcome {
  let data: unknown
  try {
    data = JSON.parse(stripFences(text))
  } catch {
    return invalid('reply is not parseable JSON')
  }
  if (!isRecord(data)) return invalid('reply must be a single JSON object')

  const intent = data.intent
  if (typeof intent !== 'string' || !(INTENTS as readonly string[]).includes(intent)) {
    return invalid(`"intent" must be one of ${INTENTS.join(', ')}`)
  }

  const asCommand = (command: Command): ValidationOutcome => ({ ok: true, result: { type: 'command', command } })

  switch (intent) {
    case 'send': {
      const robots = validRobots(data.robots, ctx, false)
      if ('error' in robots) return invalid(robots.error)
      const station = typeof data.station === 'string' ? data.station.toUpperCase().trim() : ''
      if (!ctx.stationNames.includes(station)) {
        return invalid(
          `"station" must be one of ${ctx.stationNames.join(', ')} — for charge bays use intent "charge" with "bay"`,
        )
      }
      return asCommand({ kind: 'send', robotIds: robots.ids, station })
    }
    case 'charge': {
      const robots = validRobots(data.robots, ctx, false)
      if ('error' in robots) return invalid(robots.error)
      if (data.bay !== undefined) {
        const bay = typeof data.bay === 'string' ? data.bay.toUpperCase().trim() : ''
        if (!ctx.chargerNames.includes(bay)) {
          return invalid(`"bay" must be one of ${ctx.chargerNames.join(', ')}`)
        }
        return asCommand({ kind: 'charge', robotIds: robots.ids, bay })
      }
      return asCommand({ kind: 'charge', robotIds: robots.ids })
    }
    case 'pause':
    case 'resume': {
      const scope = data.scope
      if (scope === 'all') return asCommand({ kind: intent, scope: { type: 'all' } })
      if (scope === 'aisle') {
        const aisle = data.aisle
        if (typeof aisle !== 'number' || !Number.isInteger(aisle) || aisle < 1 || aisle > ctx.aisleCount) {
          return invalid(`"aisle" must be an integer from 1 to ${ctx.aisleCount}`)
        }
        return asCommand({ kind: intent, scope: { type: 'aisle', aisle } })
      }
      if (scope === 'robots') {
        const robots = validRobots(data.robots, ctx, false)
        if ('error' in robots) return invalid(robots.error)
        return asCommand({ kind: intent, scope: { type: 'robots', ids: robots.ids } })
      }
      return invalid('"scope" must be "all", "aisle", or "robots"')
    }
    case 'reroute':
    case 'abort_task': {
      const robots = validRobots(data.robots, ctx, false)
      if ('error' in robots) return invalid(robots.error)
      return asCommand({ kind: intent, robotIds: robots.ids })
    }
    case 'status': {
      const robots = validRobots(data.robots ?? [], ctx, true)
      if ('error' in robots) return invalid(robots.error)
      return asCommand({ kind: 'status', robotIds: robots.ids })
    }
    case 'estop_all':
      return asCommand({ kind: 'estop_all' })
    case 'clear_estop':
      return asCommand({ kind: 'clear_estop' })
    case 'help':
      return asCommand({ kind: 'help' })
    case 'clarify': {
      const question = data.question
      if (typeof question !== 'string' || question.trim() === '') {
        return invalid('"clarify" requires a non-empty "question" string')
      }
      const options = data.options
      if (!Array.isArray(options) || options.length === 0 || options.length > 6 || options.some((o) => typeof o !== 'string' || o.trim() === '')) {
        return invalid('"clarify" requires "options": 1-6 non-empty command strings')
      }
      const opts: ClarifyOption[] = (options as string[]).map((o) => ({ label: o, input: o }))
      return { ok: true, result: { type: 'clarify', question: question.trim(), options: opts } }
    }
    case 'unknown':
      return { ok: true, result: { type: 'unknown' } }
    default:
      return invalid('unreachable intent')
  }
}

// ---------------------------------------------------------------------------
// The call: request, validate, one corrective re-prompt, then fall back
// ---------------------------------------------------------------------------

interface GeminiPart {
  text?: string
}
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>
}

function extractText(data: GeminiResponse): string {
  const parts = data.candidates?.[0]?.content?.parts ?? []
  return parts.map((p) => p.text ?? '').join('')
}

async function callModel(
  settings: LlmSettings,
  systemPrompt: string,
  turns: Array<{ role: 'user' | 'model'; text: string }>,
  fetchFn: typeof fetch,
): Promise<{ text: string } | { fail: string }> {
  const url = `${ENDPOINT_BASE}/${encodeURIComponent(settings.model)}:generateContent`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey },
      signal: controller.signal,
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      }),
    })
    if (!res.ok) return { fail: `HTTP ${res.status} from the model endpoint` }
    const data = (await res.json()) as GeminiResponse
    const text = extractText(data)
    if (text.trim() === '') return { fail: 'empty model reply' }
    return { text }
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError'
    return { fail: aborted ? 'model request timed out' : 'network error reaching the model endpoint' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Interpret one utterance via the LLM. Returns the validated ParseResult, or
 * a 'fallback' outcome telling the console to use the grammar parser instead.
 */
export async function interpretWithLlm(
  input: string,
  settings: LlmSettings,
  ctx: ParserContext,
  fetchFn: typeof fetch = fetch,
): Promise<LlmOutcome> {
  const systemPrompt = buildSystemPrompt(ctx)
  const firstTurns: Array<{ role: 'user' | 'model'; text: string }> = [{ role: 'user', text: input }]

  const first = await callModel(settings, systemPrompt, firstTurns, fetchFn)
  if ('fail' in first) return { source: 'fallback', reason: first.fail }

  const v1 = validateLlmReply(first.text, ctx)
  if (v1.ok) return { source: 'llm', result: v1.result, retried: false }

  // One corrective re-prompt, quoting the specific validation failure.
  const second = await callModel(
    settings,
    systemPrompt,
    [
      ...firstTurns,
      { role: 'model', text: first.text },
      {
        role: 'user',
        text: `Your previous reply was rejected by schema validation: ${v1.error}. Respond again to the original utterance with ONLY one corrected JSON object matching the schema.`,
      },
    ],
    fetchFn,
  )
  if ('fail' in second) return { source: 'fallback', reason: second.fail }

  const v2 = validateLlmReply(second.text, ctx)
  if (v2.ok) return { source: 'llm', result: v2.result, retried: true }

  return { source: 'fallback', reason: `model output failed validation twice (${v2.error})` }
}
