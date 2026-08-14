/**
 * Command executor + safety layer: destructive-command gating, scope
 * resolution (all / aisle / named robots), chat-modality instrumentation,
 * and the new sim commands (reroute, abort task) the console drives.
 */

import { describe, expect, it } from 'vitest'
import { FleetStore } from '../../store'
import {
  confirmationPrompt,
  describeCommand,
  effectiveCommand,
  executeCommand,
  isDestructive,
  robotsInAisle,
} from '../executor'

/** A quiet fleet: no auto tasks, no random help events. */
function quietStore(seed = 7): FleetStore {
  return new FleetStore(seed, {
    autoGenerate: false,
    helpRates: { pathBlocked: 0, lowConfidence: 0, stuckAtPick: 0 },
  })
}

function addTestTask(store: FleetStore) {
  return store.sim.enqueueTask({
    pickRack: { x: 8, y: 4 },
    pickApproach: { x: 8, y: 5 },
    rackRow: 'R1',
    stationName: 'PACK-1',
    requiredClass: '100kg',
    priority: 2,
  })
}

describe('safety gate', () => {
  it('flags exactly the destructive commands', () => {
    expect(isDestructive({ kind: 'estop_all' })).toBe(true)
    expect(isDestructive({ kind: 'clear_estop' })).toBe(true)
    expect(isDestructive({ kind: 'abort_task', robotIds: ['AMR-1'] })).toBe(true)
    expect(isDestructive({ kind: 'send', robotIds: ['AMR-1'], station: 'PACK-1' })).toBe(false)
    expect(isDestructive({ kind: 'pause', scope: { type: 'all' } })).toBe(false)
    expect(isDestructive({ kind: 'status', robotIds: [] })).toBe(false)
  })

  it('writes consequence-first confirmation prompts', () => {
    const store = quietStore()
    expect(confirmationPrompt(store, { kind: 'estop_all' })).toContain('halts all 5 robots')
    expect(confirmationPrompt(store, { kind: 'clear_estop' })).toContain('resume')
    const task = addTestTask(store)
    store.sim.step()
    expect(confirmationPrompt(store, { kind: 'abort_task', robotIds: ['AMR-1'] })).toContain(task.id)
  })

  it('rewrites "resume all" into the confirm-gated clear_estop while the global e-stop is latched', () => {
    const store = quietStore()
    const resumeAll = { kind: 'resume', scope: { type: 'all' } } as const
    expect(effectiveCommand(store, resumeAll)).toEqual(resumeAll)
    store.estopAll()
    expect(effectiveCommand(store, resumeAll)).toEqual({ kind: 'clear_estop' })
  })
})

describe('estop_all / clear_estop execution', () => {
  it('halts and releases the whole fleet, and is idempotent-safe', () => {
    const store = quietStore()
    const halted = executeCommand(store, { kind: 'estop_all' })
    expect(halted.lines[0].ok).toBe(true)
    expect(store.sim.globalEstop).toBe(true)
    expect(store.sim.robots.every((r) => r.state === 'estopped')).toBe(true)

    const again = executeCommand(store, { kind: 'estop_all' })
    expect(again.lines[0].ok).toBe(false)
    expect(again.lines[0].text).toContain('already')

    const released = executeCommand(store, { kind: 'clear_estop' })
    expect(released.lines[0].ok).toBe(true)
    expect(store.sim.globalEstop).toBe(false)

    const notEngaged = executeCommand(store, { kind: 'clear_estop' })
    expect(notEngaged.lines[0].ok).toBe(false)
  })

  it('names the robots an individual e-stop holds through the release', () => {
    const store = quietStore()
    store.sim.estopRobot('AMR-4')
    executeCommand(store, { kind: 'estop_all' })
    expect(confirmationPrompt(store, { kind: 'clear_estop' })).toContain('AMR-4')
    const released = executeCommand(store, { kind: 'clear_estop' })
    expect(released.lines[0].ok).toBe(true)
    expect(released.lines[1].ok).toBe(false)
    expect(released.lines[1].text).toContain('resume AMR-4')
    expect(store.sim.getRobot('AMR-4').state).toBe('estopped')
    expect(store.sim.robots.filter((r) => r.state === 'estopped')).toHaveLength(1)
  })
})

describe('send / charge via chat', () => {
  it('dispatches with the chat modality label', () => {
    const store = quietStore()
    const out = executeCommand(store, { kind: 'send', robotIds: ['AMR-2'], station: 'RECEIVING' })
    expect(out.lines).toEqual([{ ok: true, text: 'AMR-2 dispatched to RECEIVING' }])
    expect(store.sim.commandLog.at(-1)).toMatchObject({ robotId: 'AMR-2', command: 'goto', source: 'chat', ok: true })
  })

  it('reports refusals per robot instead of failing the batch', () => {
    const store = quietStore()
    store.sim.estopRobot('AMR-1')
    const out = executeCommand(store, { kind: 'send', robotIds: ['AMR-1', 'AMR-2'], station: 'STAGING' })
    expect(out.lines[0].ok).toBe(false)
    expect(out.lines[0].text).toContain('e-stopped')
    expect(out.lines[1]).toEqual({ ok: true, text: 'AMR-2 dispatched to STAGING' })
    expect(out.speech).toContain('1 refused')
  })

  it('sends robots to a named charge bay', () => {
    const store = quietStore()
    const out = executeCommand(store, { kind: 'charge', robotIds: ['AMR-4'], bay: 'CHARGE-2' })
    expect(out.lines[0].ok).toBe(true)
    expect(store.sim.chargerAssignments.get('CHARGE-2')).toBe('AMR-4')
  })
})

describe('pause / resume scopes', () => {
  it('pause all soft-stops every robot and logs the chat action', () => {
    const store = quietStore()
    const out = executeCommand(store, { kind: 'pause', scope: { type: 'all' } })
    expect(out.lines).toHaveLength(5)
    expect(store.sim.robots.every((r) => r.state === 'estopped')).toBe(true)
    expect(store.sim.globalEstop).toBe(false) // soft stop, not the global latch
    expect(
      store.sim.events.events.some(
        (e) => e.type === 'OPERATOR_ACTION' && e.message.includes('[chat]') && e.message.includes('soft-stop'),
      ),
    ).toBe(true)
  })

  it('aisle scope only touches robots inside that aisle corridor', () => {
    const store = quietStore()
    // At tick 0 the seeded fleet parks AMR-2 (10,18) and AMR-3 (30,18) in Aisle 5.
    const inAisle5 = robotsInAisle(store.sim, 5).map((r) => r.id)
    expect(inAisle5).toEqual(['AMR-2', 'AMR-3'])
    const out = executeCommand(store, { kind: 'pause', scope: { type: 'aisle', aisle: 5 } })
    expect(out.lines.map((l) => l.ok)).toEqual([true, true])
    expect(store.sim.getRobot('AMR-2').state).toBe('estopped')
    expect(store.sim.getRobot('AMR-3').state).toBe('estopped')
    expect(store.sim.getRobot('AMR-1').state).not.toBe('estopped')
  })

  it('an empty aisle answers honestly instead of doing nothing silently', () => {
    const store = quietStore()
    const out = executeCommand(store, { kind: 'pause', scope: { type: 'aisle', aisle: 1 } })
    expect(out.lines).toEqual([{ ok: false, text: 'No robots are currently in Aisle 1' }])
  })

  it('resume restarts a soft-stopped robot but never bypasses the global e-stop', () => {
    const store = quietStore()
    executeCommand(store, { kind: 'pause', scope: { type: 'robots', ids: ['AMR-1'] } })
    const out = executeCommand(store, { kind: 'resume', scope: { type: 'robots', ids: ['AMR-1'] } })
    expect(out.lines[0]).toEqual({ ok: true, text: 'AMR-1 resuming' })
    expect(store.sim.getRobot('AMR-1').state).not.toBe('estopped')

    store.estopAll()
    const blocked = executeCommand(store, { kind: 'resume', scope: { type: 'robots', ids: ['AMR-1'] } })
    expect(blocked.lines[0].ok).toBe(false)
    expect(blocked.lines[0].text).toContain('clear e-stop')
    expect(store.sim.getRobot('AMR-1').state).toBe('estopped')
  })

  it('a soft-stop is an individual lockout: it survives the global cycle until resumed by name', () => {
    const store = quietStore()
    executeCommand(store, { kind: 'pause', scope: { type: 'robots', ids: ['AMR-2'] } })
    executeCommand(store, { kind: 'estop_all' })
    executeCommand(store, { kind: 'clear_estop' })
    expect(store.sim.getRobot('AMR-2').state).toBe('estopped')
    const out = executeCommand(store, { kind: 'resume', scope: { type: 'robots', ids: ['AMR-2'] } })
    expect(out.lines[0]).toEqual({ ok: true, text: 'AMR-2 resuming' })
    expect(store.sim.getRobot('AMR-2').state).not.toBe('estopped')
  })
})

describe('status', () => {
  it('reports state, battery, and task without mutating the sim', () => {
    const store = quietStore()
    const before = store.sim.robots.map((r) => ({ id: r.id, state: r.state, battery: r.battery }))
    const out = executeCommand(store, { kind: 'status', robotIds: ['AMR-5'] })
    expect(out.lines).toHaveLength(1)
    expect(out.lines[0].text).toContain('AMR-5')
    expect(out.lines[0].text).toContain('battery 58%')
    expect(out.lines[0].text).toContain('cell (27, 21)')
    expect(store.sim.robots.map((r) => ({ id: r.id, state: r.state, battery: r.battery }))).toEqual(before)
  })

  it('empty robot list reports the whole fleet', () => {
    const store = quietStore()
    const out = executeCommand(store, { kind: 'status', robotIds: [] })
    expect(out.lines).toHaveLength(5)
  })
})

describe('reroute', () => {
  it('replans an active route', () => {
    const store = quietStore()
    addTestTask(store)
    store.sim.step()
    const r = store.sim.getRobot('AMR-1')
    expect(r.state).toBe('moving')
    const out = executeCommand(store, { kind: 'reroute', robotIds: ['AMR-1'] })
    expect(out.lines[0]).toEqual({ ok: true, text: 'AMR-1 replanning its route' })
    expect(store.sim.commandLog.at(-1)).toMatchObject({ command: 'reroute', source: 'chat', ok: true })
  })

  it('resolves an open PATH_BLOCKED help request the same way the intervention card does', () => {
    const store = quietStore()
    addTestTask(store)
    store.sim.step()
    const r = store.sim.getRobot('AMR-1')
    for (let i = 0; i < 2000 && !(r.state === 'moving' && r.path.length - r.pathIndex > 5); i++) store.sim.step()
    const help = store.sim.injectHelpRequest('AMR-1', 'PATH_BLOCKED')
    expect(help).not.toBeNull()
    const out = executeCommand(store, { kind: 'reroute', robotIds: ['AMR-1'] })
    expect(out.lines[0].ok).toBe(true)
    expect(help!.state).toBe('resolved')
    expect(help!.resolution).toBe('reroute')
  })

  it('refuses when there is nothing to replan', () => {
    const store = quietStore()
    const out = executeCommand(store, { kind: 'reroute', robotIds: ['AMR-3'] })
    expect(out.lines[0].ok).toBe(false)
    expect(out.lines[0].text).toContain('no active route')
  })
})

describe('abort_task (destructive, post-confirmation)', () => {
  it('aborts the active task and does not requeue it', () => {
    const store = quietStore()
    const task = addTestTask(store)
    store.sim.step()
    const out = executeCommand(store, { kind: 'abort_task', robotIds: ['AMR-1'] })
    expect(out.lines[0]).toEqual({ ok: true, text: 'Task aborted on AMR-1' })
    expect(task.state).toBe('aborted')
    expect(store.sim.getRobot('AMR-1').taskId).toBeNull()
    expect(store.sim.kpis().tasksAborted).toBe(1)
  })

  it('refuses when the robot has no task', () => {
    const store = quietStore()
    const out = executeCommand(store, { kind: 'abort_task', robotIds: ['AMR-2'] })
    expect(out.lines[0].ok).toBe(false)
    expect(out.lines[0].text).toContain('no active task')
  })
})

describe('descriptions (the "what was understood" sentence)', () => {
  it('restates every command kind as one human sentence', () => {
    expect(describeCommand({ kind: 'send', robotIds: ['AMR-2'], station: 'PACK-1' })).toBe('Send AMR-2 to PACK-1.')
    expect(describeCommand({ kind: 'charge', robotIds: ['AMR-4'] })).toBe('Send AMR-4 to the nearest free charge bay.')
    expect(describeCommand({ kind: 'pause', scope: { type: 'aisle', aisle: 2 } })).toBe(
      'Soft-stop all robots currently in Aisle 2.',
    )
    expect(describeCommand({ kind: 'resume', scope: { type: 'all' } })).toBe('Resume every robot.')
    expect(describeCommand({ kind: 'estop_all' })).toBe('EMERGENCY STOP the entire fleet.')
    expect(describeCommand({ kind: 'status', robotIds: [] })).toBe('Fleet status report.')
  })
})
