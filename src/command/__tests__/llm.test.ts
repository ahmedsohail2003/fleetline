/**
 * LLM interpretation mode: the hand-rolled schema validator, the
 * validate -> corrective-reprompt -> grammar-fallback loop (with a mocked
 * fetch), and the failure paths (HTTP errors, network errors, double
 * validation failure). No real network calls anywhere in this file.
 */

import { describe, expect, it, vi } from 'vitest'
import { buildSystemPrompt, interpretWithLlm, stripFences, validateLlmReply } from '../llm'
import type { LlmSettings } from '../llm'
import { makeParserContext } from '../parser'

const ctx = makeParserContext(['AMR-1', 'AMR-2', 'AMR-3', 'AMR-4', 'AMR-5'])
const settings: LlmSettings = { apiKey: 'test-key', model: 'gemini-2.5-flash' }

/** Wrap a model reply the way the generateContent endpoint does. */
function geminiBody(text: string): string {
  return JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })
}

function okResponse(text: string): Response {
  return new Response(geminiBody(text), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('validateLlmReply', () => {
  it('accepts a valid send command', () => {
    const v = validateLlmReply('{"intent":"send","robots":["AMR-2"],"station":"PACK-1"}', ctx)
    expect(v).toEqual({
      ok: true,
      result: { type: 'command', command: { kind: 'send', robotIds: ['AMR-2'], station: 'PACK-1' } },
    })
  })

  it('accepts pause with an aisle scope', () => {
    const v = validateLlmReply('{"intent":"pause","scope":"aisle","aisle":2}', ctx)
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.result).toEqual({ type: 'command', command: { kind: 'pause', scope: { type: 'aisle', aisle: 2 } } })
  })

  it('accepts a clarify reply and turns options into clickable sentences', () => {
    const v = validateLlmReply(
      '{"intent":"clarify","question":"Which packing station?","options":["send AMR-3 to PACK-1","send AMR-3 to PACK-2"]}',
      ctx,
    )
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.result.type).toBe('clarify')
    if (v.result.type !== 'clarify') return
    expect(v.result.options[1]).toEqual({ label: 'send AMR-3 to PACK-2', input: 'send AMR-3 to PACK-2' })
  })

  it('tolerates markdown fences around the JSON', () => {
    const v = validateLlmReply('```json\n{"intent":"estop_all"}\n```', ctx)
    expect(v.ok).toBe(true)
  })

  it('rejects non-JSON, non-object, and unknown intents with specific errors', () => {
    expect(validateLlmReply('go to pack one!', ctx)).toMatchObject({ ok: false, error: expect.stringContaining('JSON') })
    expect(validateLlmReply('[1,2]', ctx)).toMatchObject({ ok: false })
    expect(validateLlmReply('{"intent":"launch_missiles"}', ctx)).toMatchObject({
      ok: false,
      error: expect.stringContaining('"intent"'),
    })
  })

  it('rejects robots outside the fleet', () => {
    const v = validateLlmReply('{"intent":"reroute","robots":["AMR-9"]}', ctx)
    expect(v).toMatchObject({ ok: false, error: expect.stringContaining('AMR-9') })
  })

  it('rejects a charger name in the "station" field and says why', () => {
    const v = validateLlmReply('{"intent":"send","robots":["AMR-4"],"station":"CHARGE-2"}', ctx)
    expect(v).toMatchObject({ ok: false, error: expect.stringContaining('charge') })
  })

  it('rejects out-of-range aisles and malformed scopes', () => {
    expect(validateLlmReply('{"intent":"pause","scope":"aisle","aisle":9}', ctx)).toMatchObject({ ok: false })
    expect(validateLlmReply('{"intent":"pause","scope":"warehouse"}', ctx)).toMatchObject({ ok: false })
  })

  it('rejects clarify without options', () => {
    expect(validateLlmReply('{"intent":"clarify","question":"Which?"}', ctx)).toMatchObject({ ok: false })
  })

  it('normalizes robot/station case', () => {
    const v = validateLlmReply('{"intent":"send","robots":["amr-2"],"station":"receiving"}', ctx)
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.result).toEqual({
      type: 'command',
      command: { kind: 'send', robotIds: ['AMR-2'], station: 'RECEIVING' },
    })
  })
})

describe('interpretWithLlm: happy path', () => {
  it('returns the validated command on the first try', async () => {
    const fetchMock = vi.fn(async () => okResponse('{"intent":"send","robots":["AMR-2"],"station":"PACK-1"}'))
    const out = await interpretWithLlm('send amr 2 to pack one', settings, ctx, fetchMock as unknown as typeof fetch)
    expect(out).toEqual({
      source: 'llm',
      retried: false,
      result: { type: 'command', command: { kind: 'send', robotIds: ['AMR-2'], station: 'PACK-1' } },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash')
    const body = JSON.parse(init.body as string)
    expect(body.generationConfig.temperature).toBe(0)
    expect(body.contents).toHaveLength(1)
    expect(body.system_instruction.parts[0].text).toContain('AMR-1')
  })
})

describe('interpretWithLlm: corrective re-prompt', () => {
  it('quotes the specific validation failure back to the model exactly once', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse('{"intent":"send","robots":["AMR-9"],"station":"PACK-1"}'))
      .mockResolvedValueOnce(okResponse('{"intent":"send","robots":["AMR-4"],"station":"PACK-1"}'))
    const out = await interpretWithLlm('send the big one to pack 1', settings, ctx, fetchMock as unknown as typeof fetch)
    expect(out).toEqual({
      source: 'llm',
      retried: true,
      result: { type: 'command', command: { kind: 'send', robotIds: ['AMR-4'], station: 'PACK-1' } },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The second request must carry the conversation + the quoted failure.
    const body2 = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
    expect(body2.contents).toHaveLength(3)
    expect(body2.contents[1].role).toBe('model')
    expect(body2.contents[2].parts[0].text).toContain('rejected by schema validation')
    expect(body2.contents[2].parts[0].text).toContain('AMR-9')
  })

  it('falls back to the grammar parser after a second invalid reply', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse('not json at all'))
      .mockResolvedValueOnce(okResponse('{"intent":"teleport"}'))
    const out = await interpretWithLlm('send amr 2 to receiving', settings, ctx, fetchMock as unknown as typeof fetch)
    expect(out.source).toBe('fallback')
    if (out.source !== 'fallback') return
    expect(out.reason).toContain('twice')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('interpretWithLlm: transport failures fall back', () => {
  it('falls back on HTTP errors', async () => {
    const fetchMock = vi.fn(async () => new Response('denied', { status: 403 }))
    const out = await interpretWithLlm('pause all robots', settings, ctx, fetchMock as unknown as typeof fetch)
    expect(out).toEqual({ source: 'fallback', reason: 'HTTP 403 from the model endpoint' })
  })

  it('falls back on network errors', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const out = await interpretWithLlm('pause all robots', settings, ctx, fetchMock as unknown as typeof fetch)
    expect(out.source).toBe('fallback')
    if (out.source !== 'fallback') return
    expect(out.reason).toContain('network')
  })

  it('falls back on an empty model reply', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }))
    const out = await interpretWithLlm('pause all robots', settings, ctx, fetchMock as unknown as typeof fetch)
    expect(out).toEqual({ source: 'fallback', reason: 'empty model reply' })
  })
})

describe('prompt and fence helpers', () => {
  it('the system prompt carries the full warehouse vocabulary', () => {
    const p = buildSystemPrompt(ctx)
    for (const id of ctx.robotIds) expect(p).toContain(id)
    for (const s of ctx.stationNames) expect(p).toContain(s)
    for (const c of ctx.chargerNames) expect(p).toContain(c)
    expect(p).toContain('"intent"')
  })

  it('stripFences removes markdown wrappers but leaves plain JSON alone', () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(stripFences('{"a":1}')).toBe('{"a":1}')
  })
})
