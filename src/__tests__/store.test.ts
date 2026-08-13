/**
 * FleetStore: the fixed-timestep driver, pub/sub versioning, selection
 * state, and the operator-action wrappers the console UI calls.
 */

import { describe, expect, it } from 'vitest'
import { FleetStore } from '../store'
import { TICK_MS } from '../sim/sim'

/** A store over a noise-free sim (no auto tasks, no random help events). */
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

describe('fixed-timestep driver', () => {
  it('steps whole ticks and returns the interpolation alpha', () => {
    const store = quietStore()
    const a1 = store.advance(TICK_MS / 2) // 50 ms: no tick yet
    expect(store.sim.tick).toBe(0)
    expect(a1).toBeCloseTo(0.5, 5)
    const a2 = store.advance(TICK_MS * 0.6) // 110 ms total: one tick + 10 ms
    expect(store.sim.tick).toBe(1)
    expect(a2).toBeCloseTo(0.1, 5)
  })

  it('scales by the speed multiplier', () => {
    const store = quietStore()
    store.setSpeed(4)
    store.advance(TICK_MS) // 100 ms real = 400 ms sim
    expect(store.sim.tick).toBe(4)
  })

  it('does not advance while paused', () => {
    const store = quietStore()
    store.setPaused(true)
    store.advance(1000)
    expect(store.sim.tick).toBe(0)
    store.setPaused(false)
    store.advance(1000)
    expect(store.sim.tick).toBe(10)
  })

  it('clamps runaway frames instead of spiraling', () => {
    const store = quietStore()
    store.advance(60_000) // one 60 s frame
    expect(store.sim.tick).toBeLessThanOrEqual(40)
  })
})

describe('pub/sub and snapshots', () => {
  it('notifies subscribers once per advance that stepped, and bumps the snapshot', () => {
    const store = quietStore()
    let calls = 0
    const unsub = store.subscribe(() => {
      calls++
    })
    const v0 = store.getSnapshot()
    store.advance(TICK_MS / 2) // no tick -> no notify
    expect(calls).toBe(0)
    store.advance(TICK_MS * 3) // several ticks -> one notify
    expect(calls).toBe(1)
    expect(store.getSnapshot()).toBeGreaterThan(v0)
    unsub()
    store.advance(TICK_MS * 3)
    expect(calls).toBe(1)
  })

  it('notifies on pure-UI changes (selection) and no-ops on repeats', () => {
    const store = quietStore()
    let calls = 0
    store.subscribe(() => {
      calls++
    })
    store.selectRobot('AMR-2')
    expect(store.selectedRobotId).toBe('AMR-2')
    expect(store.selectedRobot()?.id).toBe('AMR-2')
    expect(calls).toBe(1)
    store.selectRobot('AMR-2') // same id: no notify
    expect(calls).toBe(1)
    store.selectRobot(null)
    expect(store.selectedRobotId).toBeNull()
    expect(calls).toBe(2)
    expect(() => store.selectRobot('AMR-99')).toThrow()
  })

  it('no-ops on repeated speed/pause values', () => {
    const store = quietStore()
    let calls = 0
    store.subscribe(() => {
      calls++
    })
    store.setSpeed(1)
    store.setPaused(false)
    expect(calls).toBe(0)
    store.setSpeed(2)
    store.setPaused(true)
    expect(calls).toBe(2)
  })
})

describe('operator-action wrappers', () => {
  it('commandStation dispatches and notifies; refusals surface the reason', () => {
    const store = quietStore()
    let calls = 0
    store.subscribe(() => {
      calls++
    })
    const ok = store.commandStation('AMR-1', 'PACK-2')
    expect(ok.ok).toBe(true)
    expect(store.sim.getRobot('AMR-1').mission?.kind).toBe('goto')
    expect(calls).toBe(1)

    store.estopRobot('AMR-3')
    const refused = store.commandStation('AMR-3', 'PACK-2')
    expect(refused.ok).toBe(false)
    expect(refused.reason).toBeTruthy()
  })

  it('commandCharge respects a preferred bay', () => {
    const store = quietStore()
    const res = store.commandCharge('AMR-1', 'direct-manipulation', 'CHARGE-3')
    expect(res.ok).toBe(true)
    expect(store.sim.getRobot('AMR-1').chargerName).toBe('CHARGE-3')
  })

  it('resolveHelp resolves through the store', () => {
    const store = quietStore()
    addTestTask(store)
    store.sim.step()
    const r = store.sim.getRobot('AMR-1')
    for (let i = 0; i < 200 && !(r.state === 'moving' && r.path.length - r.pathIndex > 5); i++) {
      store.sim.step()
    }
    const help = store.sim.injectHelpRequest('AMR-1', 'PATH_BLOCKED')!
    store.resolveHelp(help.id, 'reroute')
    expect(help.state).toBe('resolved')
    expect(r.state).toBe('moving')
  })

  it('estopAll / resumeAll round-trips the whole fleet', () => {
    const store = quietStore()
    store.estopAll()
    expect(store.sim.globalEstop).toBe(true)
    expect(store.sim.robots.every((r) => r.state === 'estopped')).toBe(true)
    store.resumeAll()
    expect(store.sim.globalEstop).toBe(false)
    expect(store.sim.robots.every((r) => r.state !== 'estopped')).toBe(true)
  })

  it('setAutoGenerate toggles the sim generator', () => {
    const store = quietStore()
    store.setAutoGenerate(false)
    expect(store.sim.autoGenerate).toBe(false)
    store.setAutoGenerate(true)
    expect(store.sim.autoGenerate).toBe(true)
  })
})
