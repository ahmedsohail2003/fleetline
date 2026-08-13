/**
 * Grammar parser: intent coverage, fuzzy station matching, ambiguity ->
 * clarification, unknown references, and honest "unknown" for non-commands.
 */

import { describe, expect, it } from 'vitest'
import { makeParserContext, matchStation, parseCommand } from '../parser'
import type { Command, ParseResult } from '../types'

const ctx = makeParserContext(['AMR-1', 'AMR-2', 'AMR-3', 'AMR-4', 'AMR-5'])

function expectCommand(result: ParseResult): Command {
  expect(result.type).toBe('command')
  if (result.type !== 'command') throw new Error('not a command')
  return result.command
}

describe('parseCommand: send', () => {
  it('parses "send AMR-3 to receiving"', () => {
    const c = expectCommand(parseCommand('send AMR-3 to receiving', ctx))
    expect(c).toEqual({ kind: 'send', robotIds: ['AMR-3'], station: 'RECEIVING' })
  })

  it('tolerates loose robot spelling: "send amr 2 to receiving"', () => {
    const c = expectCommand(parseCommand('send amr 2 to receiving', ctx))
    expect(c).toEqual({ kind: 'send', robotIds: ['AMR-2'], station: 'RECEIVING' })
  })

  it('accepts "robot 4" and alternate verbs', () => {
    const c = expectCommand(parseCommand('move robot 4 to staging', ctx))
    expect(c).toEqual({ kind: 'send', robotIds: ['AMR-4'], station: 'STAGING' })
  })

  it('parses multi-robot dispatch: "send amr-1 and amr-3 to staging"', () => {
    const c = expectCommand(parseCommand('send amr-1 and amr-3 to staging', ctx))
    expect(c).toEqual({ kind: 'send', robotIds: ['AMR-1', 'AMR-3'], station: 'STAGING' })
  })

  it('resolves station aliases: "take amr-2 back to the dock"', () => {
    const c = expectCommand(parseCommand('take amr-2 back to the dock', ctx))
    expect(c).toEqual({ kind: 'send', robotIds: ['AMR-2'], station: 'RECEIVING' })
  })

  it('forgives typos within the fuzzy budget: "send amr-2 to recieving"', () => {
    const c = expectCommand(parseCommand('send amr-2 to recieving', ctx))
    expect(c).toEqual({ kind: 'send', robotIds: ['AMR-2'], station: 'RECEIVING' })
  })

  it('parses a numbered packing station: "send AMR-1 to pack 2"', () => {
    const c = expectCommand(parseCommand('send AMR-1 to pack 2', ctx))
    expect(c).toEqual({ kind: 'send', robotIds: ['AMR-1'], station: 'PACK-2' })
  })

  it('is case- and whitespace-insensitive', () => {
    const c = expectCommand(parseCommand('  SEND   AMR-2   TO   RECEIVING. ', ctx))
    expect(c).toEqual({ kind: 'send', robotIds: ['AMR-2'], station: 'RECEIVING' })
  })
})

describe('parseCommand: clarification (ambiguity is a question, not a guess)', () => {
  it('"send AMR-3 to packing" asks which packing station', () => {
    const r = parseCommand('send AMR-3 to packing', ctx)
    expect(r.type).toBe('clarify')
    if (r.type !== 'clarify') return
    expect(r.options.map((o) => o.label)).toEqual(['PACK-1', 'PACK-2'])
    // Options are complete sentences that re-enter the same parser.
    const resolved = expectCommand(parseCommand(r.options[0].input, ctx))
    expect(resolved).toEqual({ kind: 'send', robotIds: ['AMR-3'], station: 'PACK-1' })
  })

  it('"go to pack-1" without a robot asks which robot', () => {
    const r = parseCommand('go to pack-1', ctx)
    expect(r.type).toBe('clarify')
    if (r.type !== 'clarify') return
    expect(r.options).toHaveLength(5)
    expect(r.options[1].input).toBe('send AMR-2 to PACK-1')
  })

  it('rejects robots that are not in the fleet', () => {
    const r = parseCommand('send amr-9 to staging', ctx)
    expect(r.type).toBe('clarify')
    if (r.type !== 'clarify') return
    expect(r.question).toContain('AMR-9')
    expect(r.question).toContain('AMR-1')
  })

  it('rejects aisles that do not exist', () => {
    const r = parseCommand('pause robots in aisle 7', ctx)
    expect(r.type).toBe('clarify')
    if (r.type !== 'clarify') return
    expect(r.question).toContain('Aisle 7')
  })

  it('unknown destinations list what it can do', () => {
    const r = parseCommand('send amr-2 to the cafeteria', ctx)
    expect(r.type).toBe('clarify')
    if (r.type !== 'clarify') return
    expect(r.question).toContain('cafeteria')
    expect(r.options.some((o) => o.label === 'STAGING')).toBe(true)
  })
})

describe('parseCommand: pause / resume', () => {
  it('parses "pause all robots"', () => {
    const c = expectCommand(parseCommand('pause all robots', ctx))
    expect(c).toEqual({ kind: 'pause', scope: { type: 'all' } })
  })

  it('parses "pause robots in aisle 2"', () => {
    const c = expectCommand(parseCommand('pause robots in aisle 2', ctx))
    expect(c).toEqual({ kind: 'pause', scope: { type: 'aisle', aisle: 2 } })
  })

  it('parses "stop amr 3" as a per-robot soft stop', () => {
    const c = expectCommand(parseCommand('stop amr 3', ctx))
    expect(c).toEqual({ kind: 'pause', scope: { type: 'robots', ids: ['AMR-3'] } })
  })

  it('"stop everything" is a soft stop, not an e-stop', () => {
    const c = expectCommand(parseCommand('stop everything', ctx))
    expect(c.kind).toBe('pause')
  })

  it('parses "resume AMR-1"', () => {
    const c = expectCommand(parseCommand('resume AMR-1', ctx))
    expect(c).toEqual({ kind: 'resume', scope: { type: 'robots', ids: ['AMR-1'] } })
  })
})

describe('parseCommand: charge', () => {
  it('parses "send AMR-4 to charge" (nearest free bay)', () => {
    const c = expectCommand(parseCommand('send AMR-4 to charge', ctx))
    expect(c).toEqual({ kind: 'charge', robotIds: ['AMR-4'] })
  })

  it('parses a named bay: "charge amr 4 at charge 2"', () => {
    const c = expectCommand(parseCommand('charge amr 4 at charge 2', ctx))
    expect(c).toEqual({ kind: 'charge', robotIds: ['AMR-4'], bay: 'CHARGE-2' })
  })

  it('rejects bays that do not exist', () => {
    const r = parseCommand('charge amr-1 at charge bay 9', ctx)
    expect(r.type).toBe('clarify')
    if (r.type !== 'clarify') return
    expect(r.question).toContain('CHARGE-9')
  })
})

describe('parseCommand: status / reroute / abort', () => {
  it('parses "status of AMR-5"', () => {
    const c = expectCommand(parseCommand('status of AMR-5', ctx))
    expect(c).toEqual({ kind: 'status', robotIds: ['AMR-5'] })
  })

  it('parses question forms: "where is amr 2"', () => {
    const c = expectCommand(parseCommand('where is amr 2', ctx))
    expect(c).toEqual({ kind: 'status', robotIds: ['AMR-2'] })
  })

  it('"is amr-4 charging" is a status query, not a charge command', () => {
    const c = expectCommand(parseCommand('is amr-4 charging', ctx))
    expect(c.kind).toBe('status')
  })

  it('bare "status" reports on the whole fleet', () => {
    const c = expectCommand(parseCommand('status', ctx))
    expect(c).toEqual({ kind: 'status', robotIds: [] })
  })

  it('parses "reroute AMR-2"', () => {
    const c = expectCommand(parseCommand('reroute AMR-2', ctx))
    expect(c).toEqual({ kind: 'reroute', robotIds: ['AMR-2'] })
  })

  it('parses "abort task on amr-2"', () => {
    const c = expectCommand(parseCommand('abort task on amr-2', ctx))
    expect(c).toEqual({ kind: 'abort_task', robotIds: ['AMR-2'] })
  })

  it('"abort" without a robot asks which one', () => {
    const r = parseCommand('abort the task', ctx)
    expect(r.type).toBe('clarify')
  })
})

describe('parseCommand: e-stop family', () => {
  it('parses "e-stop all"', () => {
    expect(expectCommand(parseCommand('e-stop all', ctx)).kind).toBe('estop_all')
  })

  it('parses "emergency stop"', () => {
    expect(expectCommand(parseCommand('emergency stop', ctx)).kind).toBe('estop_all')
  })

  it('parses "clear e-stop" and "release the e-stop"', () => {
    expect(expectCommand(parseCommand('clear e-stop', ctx)).kind).toBe('clear_estop')
    expect(expectCommand(parseCommand('release the e-stop', ctx)).kind).toBe('clear_estop')
  })

  it('"cancel the e-stop" must never engage the e-stop', () => {
    expect(expectCommand(parseCommand('cancel the e-stop', ctx)).kind).toBe('clear_estop')
  })

  it('"e-stop amr-3" halts one robot instead of the fleet', () => {
    const c = expectCommand(parseCommand('e-stop amr-3', ctx))
    expect(c).toEqual({ kind: 'pause', scope: { type: 'robots', ids: ['AMR-3'] } })
  })
})

describe('parseCommand: help and unknown', () => {
  it('parses "help" and "what can you do"', () => {
    expect(expectCommand(parseCommand('help', ctx)).kind).toBe('help')
    expect(expectCommand(parseCommand('what can you do', ctx)).kind).toBe('help')
  })

  it('a bare robot mention reads as a status query', () => {
    const c = expectCommand(parseCommand('amr-3', ctx))
    expect(c).toEqual({ kind: 'status', robotIds: ['AMR-3'] })
  })

  it('returns unknown for non-commands and empty input', () => {
    expect(parseCommand('make me a sandwich', ctx).type).toBe('unknown')
    expect(parseCommand('', ctx).type).toBe('unknown')
    expect(parseCommand('   ', ctx).type).toBe('unknown')
  })
})

describe('parseCommand: non-AMR rosters (literal id match)', () => {
  // Robots registered via `?robots=robot1,robot2` (docs/ROS2.md section 5.3)
  // carry their bridge namespaces as ids — no AMR-N pattern to lean on.
  const rosCtx = makeParserContext(['robot1', 'robot2'])

  it('addresses robots by their registered id: "send robot1 to PACK-1"', () => {
    const c = expectCommand(parseCommand('send robot1 to PACK-1', rosCtx))
    expect(c).toEqual({ kind: 'send', robotIds: ['robot1'], station: 'PACK-1' })
  })

  it('matches ids case- and separator-insensitively: "send mule 2 to receiving"', () => {
    const muleCtx = makeParserContext(['MULE-1', 'MULE-2'])
    const c = expectCommand(parseCommand('send mule 2 to receiving', muleCtx))
    expect(c).toEqual({ kind: 'send', robotIds: ['MULE-2'], station: 'RECEIVING' })
  })

  it('resolves underscore namespaces from the bridge: "send amr 6 to receiving"', () => {
    const mockCtx = makeParserContext(['amr_6', 'amr_7'])
    const c = expectCommand(parseCommand('send amr 6 to receiving', mockCtx))
    expect(c).toEqual({ kind: 'send', robotIds: ['amr_6'], station: 'RECEIVING' })
  })

  it('parses multi-robot dispatch: "send robot1 and robot2 to staging"', () => {
    const c = expectCommand(parseCommand('send robot1 and robot2 to staging', rosCtx))
    expect(c).toEqual({ kind: 'send', robotIds: ['robot1', 'robot2'], station: 'STAGING' })
  })

  it('keeps the AMR-N heuristic for AMR rosters: "send robot 3 to staging"', () => {
    const c = expectCommand(parseCommand('send robot 3 to staging', ctx))
    expect(c).toEqual({ kind: 'send', robotIds: ['AMR-3'], station: 'STAGING' })
  })

  it('clarification options round-trip: "send robot2 to packing"', () => {
    const r = parseCommand('send robot2 to packing', rosCtx)
    expect(r.type).toBe('clarify')
    if (r.type !== 'clarify') return
    expect(r.options.map((o) => o.label)).toEqual(['PACK-1', 'PACK-2'])
    const resolved = expectCommand(parseCommand(r.options[0].input, rosCtx))
    expect(resolved).toEqual({ kind: 'send', robotIds: ['robot2'], station: 'PACK-1' })
  })

  it('the console example commands all parse for a non-AMR roster', () => {
    // Mirrors the roster-derived examples in ui/CommandConsole.tsx.
    const examples: Array<[string, Command['kind']]> = [
      ['send robot1 to charge', 'charge'],
      ['resume robot1', 'resume'],
      ['status of robot2', 'status'],
      ['reroute robot1', 'reroute'],
      ['abort task on robot2', 'abort_task'],
    ]
    for (const [line, kind] of examples) {
      expect(expectCommand(parseCommand(line, rosCtx)).kind).toBe(kind)
    }
  })
})

describe('matchStation (fuzzy matcher)', () => {
  it('matches exact aliases and canonical names', () => {
    expect(matchStation('receiving')).toEqual({ kind: 'station', name: 'RECEIVING' })
    expect(matchStation('pack-2')).toEqual({ kind: 'station', name: 'PACK-2' })
    expect(matchStation('the staging area')).toEqual({ kind: 'station', name: 'STAGING' })
  })

  it('reports the pack family as ambiguous', () => {
    expect(matchStation('packing')).toEqual({ kind: 'ambiguous', names: ['PACK-1', 'PACK-2'] })
  })

  it('recognizes charge phrases with and without a bay number', () => {
    expect(matchStation('charge')).toEqual({ kind: 'charge' })
    expect(matchStation('charge bay 3')).toEqual({ kind: 'charge', bayNumber: 3 })
  })

  it('gives up rather than guess on distant strings', () => {
    expect(matchStation('mezzanine')).toEqual({ kind: 'none' })
  })
})
