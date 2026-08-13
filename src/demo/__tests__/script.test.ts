/**
 * Guided-demo script tests: schedule invariants, plus a full replay of the
 * script against the real simulation (same pattern as the HandSignal
 * guided-demo test) — the demo must tell its story through the real operator
 * APIs, from the exact seed the app boots with, without a single skipped or
 * refused beat.
 */

import { describe, expect, it } from 'vitest'
import {
  applyDemoAction,
  chatSentence,
  CHAT_STATION,
  DEMO_STEPS,
  DEMO_TOTAL_MS,
  PREFERRED_CHAT_ROBOT,
  stepStartMs,
  TYPE_MS_PER_CHAR,
  TYPE_SUBMIT_PAUSE_MS,
} from '../script'
import type { DemoRunContext } from '../script'
import { APP_SEED, FleetStore } from '../../store'
import { makeParserContext, parseCommand } from '../../command/parser'
import { executeCommand } from '../../command/executor'

const actionIndex = (kind: string): number => DEMO_STEPS.findIndex((s) => s.action === kind)

describe('guided demo schedule invariants', () => {
  it('runs about 60 seconds', () => {
    expect(DEMO_TOTAL_MS).toBeGreaterThanOrEqual(55_000)
    expect(DEMO_TOTAL_MS).toBeLessThanOrEqual(70_000)
  })

  it('tells the story in order, each beat exactly once', () => {
    const order = ['spawn-tasks', 'inject-help', 'resolve-help', 'chat', 'estop-all', 'release-estop']
    const indices = order.map(actionIndex)
    for (const i of indices) expect(i).toBeGreaterThanOrEqual(0)
    expect([...indices].sort((a, b) => a - b)).toEqual(indices)
    for (const kind of order) {
      expect(DEMO_STEPS.filter((s) => s.action === kind)).toHaveLength(1)
    }
  })

  it('opens with a hand-over promise and closes with an invitation', () => {
    expect(DEMO_STEPS[0].action).toBeUndefined()
    expect(DEMO_STEPS[0].caption).toMatch(/Esc/i)
    const last = DEMO_STEPS[DEMO_STEPS.length - 1]
    expect(last.action).toBeUndefined()
    expect(last.caption).toMatch(/yours/i)
  })

  it('gives the fleet time to be visibly moving before the help request', () => {
    // The injection needs a robot mid-path; two-plus seconds of driving after
    // task spawn guarantees dispatch has happened and motion is on screen.
    const spawnAt = stepStartMs(actionIndex('spawn-tasks'))
    const helpAt = stepStartMs(actionIndex('inject-help'))
    expect(helpAt - spawnAt).toBeGreaterThanOrEqual(5_000)
  })

  it('leaves the intervention card on screen long enough to read before auto-resolving', () => {
    const helpAt = stepStartMs(actionIndex('inject-help'))
    const resolveAt = stepStartMs(actionIndex('resolve-help'))
    expect(resolveAt - helpAt).toBeGreaterThanOrEqual(4_000)
  })

  it('fits the auto-typed chat command (typing + pause + execution) inside its step', () => {
    const chatStep = DEMO_STEPS[actionIndex('chat')]
    // Longest sentence the script can produce given any fleet robot id.
    const sentence = `send ${PREFERRED_CHAT_ROBOT} to ${CHAT_STATION}`
    const typedMs = sentence.length * TYPE_MS_PER_CHAR + TYPE_SUBMIT_PAUSE_MS
    expect(typedMs + 2_000).toBeLessThan(chatStep.durMs)
  })

  it('holds the e-stop long enough to register before releasing', () => {
    const stopAt = stepStartMs(actionIndex('estop-all'))
    const releaseAt = stepStartMs(actionIndex('release-estop'))
    expect(releaseAt - stopAt).toBeGreaterThanOrEqual(3_000)
  })
})

describe('guided demo target selection', () => {
  it('prefers the canonical "send AMR-2 to PACK-1" whenever AMR-2 can take it', () => {
    // Fresh shift: every robot is idle, so the preference must win.
    const store = new FleetStore(APP_SEED)
    expect(chatSentence(store.sim)).toBe(`send ${PREFERRED_CHAT_ROBOT} to ${CHAT_STATION}`)
  })

  it('adapts to another commandable robot instead of demoing a refusal', () => {
    const store = new FleetStore(APP_SEED)
    store.sim.estopRobot(PREFERRED_CHAT_ROBOT)
    const sentence = chatSentence(store.sim)
    expect(sentence).not.toContain(PREFERRED_CHAT_ROBOT)
    const result = parseCommand(sentence, makeParserContext(store.sim.robots.map((r) => r.id)))
    expect(result.type).toBe('command')
    if (result.type === 'command') {
      const outcome = executeCommand(store, result.command)
      expect(outcome.lines.every((l) => l.ok)).toBe(true)
    }
  })
})

describe('guided demo replayed against the real sim (app seed)', () => {
  it('every beat lands: tasks assign, help fires and reroutes, chat executes, e-stop round-trips', () => {
    const store = new FleetStore(APP_SEED)
    const ctx: DemoRunContext = { helpId: null }
    const starts = DEMO_STEPS.map((_, i) => stepStartMs(i))

    let chatOk: boolean | null = null
    let chatRobot: string | null = null

    const runStep = (i: number): void => {
      const action = DEMO_STEPS[i].action
      if (!action) return
      if (action === 'chat') {
        // Mirror what the console does with the demo's sentence: the real
        // grammar parser, then the real executor (source: 'chat').
        const sentence = chatSentence(store.sim)
        chatRobot = sentence.split(' ')[1]
        const result = parseCommand(sentence, makeParserContext(store.sim.robots.map((r) => r.id)))
        expect(result.type).toBe('command')
        if (result.type !== 'command') return
        const outcome = executeCommand(store, result.command)
        chatOk = outcome.lines.length > 0 && outcome.lines.every((l) => l.ok)
        return
      }
      const applied = applyDemoAction(store, action, ctx)
      expect(applied, `demo action ${action} must not be skipped on the canonical run`).toBe(true)

      if (action === 'spawn-tasks') {
        expect(store.sim.queue.tasks.length).toBeGreaterThanOrEqual(3)
      }
      if (action === 'inject-help') {
        expect(ctx.helpId).not.toBeNull()
        const help = store.sim.help.find((h) => h.id === ctx.helpId)
        expect(help?.kind).toBe('PATH_BLOCKED')
        expect(help?.state).toBe('open')
        // The obstruction is on the map and the robot shows NEEDS HELP.
        expect(store.sim.obstacles.size).toBeGreaterThanOrEqual(1)
        expect(store.sim.getRobot(help!.robotId).state).toBe('awaiting_help')
      }
      if (action === 'resolve-help') {
        const help = store.sim.help.find((h) => h.id === ctx.helpId)
        expect(help?.state).toBe('resolved')
        expect(help?.resolution).toBe('reroute')
        expect(store.sim.getRobot(help!.robotId).state).not.toBe('awaiting_help')
      }
      if (action === 'estop-all') {
        expect(store.sim.globalEstop).toBe(true)
        for (const r of store.sim.robots) expect(r.state).toBe('estopped')
      }
      if (action === 'release-estop') {
        expect(store.sim.globalEstop).toBe(false)
        for (const r of store.sim.robots) expect(r.state).not.toBe('estopped')
      }
    }

    // Drive wall time in 100 ms frames exactly as the store's fixed-timestep
    // driver does, firing each step's action at its scheduled offset.
    let prev = -1
    for (let t = 0; t <= DEMO_TOTAL_MS; t += 100) {
      if (t > 0) store.advance(100)
      DEMO_STEPS.forEach((_, i) => {
        if (starts[i] > prev && starts[i] <= t) runStep(i)
      })
      prev = t
    }

    // The chat beat addressed a real robot and the command was ACCEPTED (the
    // script adapts the sentence to a commandable robot precisely so the demo
    // never narrates "executes" over a refusal), instrumented as chat-source.
    expect(store.sim.robots.some((r) => r.id === chatRobot)).toBe(true)
    expect(chatOk).toBe(true)
    const chatCmd = store.sim.commandLog.find(
      (c) => c.source === 'chat' && c.robotId === chatRobot && c.target === CHAT_STATION,
    )
    expect(chatCmd?.ok).toBe(true)

    // Demo-spawned tasks actually engaged the fleet.
    const demoTasks = store.sim.queue.tasks.filter((t) => ['PACK-1', 'PACK-2', 'RECEIVING'].includes(t.stationName))
    expect(demoTasks.some((t) => t.state === 'assigned' || t.state === 'completed')).toBe(true)

    // End state: the console is handed over in a sane state — no latched
    // e-stop, and the demo's own help request is not left dangling.
    expect(store.sim.globalEstop).toBe(false)
    expect(store.sim.help.find((h) => h.id === ctx.helpId)?.state).toBe('resolved')
  })

  it('is deterministic: two replays produce identical command and event traces', () => {
    const run = (): string => {
      const store = new FleetStore(APP_SEED)
      const ctx: DemoRunContext = { helpId: null }
      const starts = DEMO_STEPS.map((_, i) => stepStartMs(i))
      let prev = -1
      for (let t = 0; t <= DEMO_TOTAL_MS; t += 100) {
        if (t > 0) store.advance(100)
        DEMO_STEPS.forEach((step, i) => {
          if (starts[i] > prev && starts[i] <= t) {
            if (step.action === 'chat') {
              const result = parseCommand(chatSentence(store.sim), makeParserContext(store.sim.robots.map((r) => r.id)))
              if (result.type === 'command') executeCommand(store, result.command)
            } else if (step.action) {
              applyDemoAction(store, step.action, ctx)
            }
          }
        })
        prev = t
      }
      return JSON.stringify({
        commands: store.sim.commandLog,
        events: store.sim.events.events.map((e) => `${e.tick}:${e.type}:${e.message}`),
      })
    }
    expect(run()).toBe(run())
  })
})
