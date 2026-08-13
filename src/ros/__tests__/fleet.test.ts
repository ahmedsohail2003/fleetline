/**
 * Integration: RosFleetBridge (the console-facing adapter) against the mock
 * rosbridge server — the full ROS-mode data path the UI sits on top of:
 *
 *   /fleet/status discovery -> roster admission on first odom + battery
 *   odometry -> grid pose + MOVING/IDLE state
 *   commandGoto -> goal_pose publish -> mock robot converges -> ARRIVAL event
 *   e-stop -> emergency_stop publish -> mock freezes + local state mirrors
 *   reroute/abort -> honest refusals (no fleet manager behind the bridge)
 *
 * Plus the FleetSim external-roster API the bridge relies on.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { startMockRosbridge } from '../../../tools/mock-rosbridge.mjs'
import type { MockRosbridge } from '../../../tools/mock-rosbridge.mjs'
import { FleetSim } from '../../sim/sim'
import { GRID_H, GRID_W, getStation } from '../../sim/warehouse'
import { RosFleetBridge, normalizeBatteryPct, nsToRobotId } from '../fleet'
import { DEFAULT_TRANSFORM, gridToWorld } from '../transform'

async function until<T>(fn: () => T, timeoutMs = 5000, label = 'condition'): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v) return v as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function emptySim(): FleetSim {
  return new FleetSim({
    seed: 1,
    fleet: [],
    autoGenerate: false,
    helpRates: { pathBlocked: 0, lowConfidence: 0, stuckAtPick: 0 },
  })
}

describe('FleetSim external-roster API', () => {
  it('supports an empty starting fleet', () => {
    const sim = emptySim()
    expect(sim.robots).toHaveLength(0)
    expect(sim.events.events[0].message).toContain('no robots registered')
  })

  it('addExternalRobot preserves continuous position and appends an event', () => {
    const sim = emptySim()
    const r = sim.addExternalRobot('AMR-6', '100kg', 10.4, 8.7, 84)
    expect(r.x).toBeCloseTo(10.4)
    expect(r.gx).toBe(10)
    expect(r.gy).toBe(9)
    expect(r.battery).toBe(84)
    expect(sim.robots).toHaveLength(1)
    expect(sim.events.events.at(-1)!.message).toContain('AMR-6 joined the fleet')
  })

  it('rejects duplicate robot ids', () => {
    const sim = emptySim()
    sim.addExternalRobot('AMR-6', '100kg', 5, 5, 50)
    expect(() => sim.addExternalRobot('AMR-6', '600kg', 6, 6, 60)).toThrow(/Duplicate/)
  })
})

describe('helpers', () => {
  it('nsToRobotId maps namespaces to roster ids', () => {
    expect(nsToRobotId('amr_6')).toBe('AMR-6')
    expect(nsToRobotId('/amr_12')).toBe('AMR-12')
    expect(nsToRobotId('tugbot')).toBe('TUGBOT')
  })

  it('normalizeBatteryPct handles [0,1] spec values and 0-100 outliers', () => {
    expect(normalizeBatteryPct(0.84)).toBeCloseTo(84)
    expect(normalizeBatteryPct(1)).toBe(100)
    expect(normalizeBatteryPct(67)).toBe(67) // driver already sent percent
    expect(normalizeBatteryPct(140)).toBe(100)
    expect(normalizeBatteryPct(Number.NaN)).toBe(0)
  })
})

describe('RosFleetBridge <-> mock server', () => {
  let server: MockRosbridge | null = null
  let bridge: RosFleetBridge | null = null

  afterEach(async () => {
    bridge?.dispose()
    bridge = null
    await server?.close()
    server = null
  })

  async function connectedBridge(opts: { tickMs?: number; speedFactor?: number } = {}): Promise<{
    server: MockRosbridge
    bridge: RosFleetBridge
    sim: FleetSim
  }> {
    server = await startMockRosbridge({ port: 0, tickMs: 20, ...opts })
    const sim = emptySim()
    bridge = new RosFleetBridge(sim, { url: server.url, initialBackoffMs: 150 })
    bridge.connect()
    await until(() => bridge!.status === 'connected', 5000, 'bridge connected')
    return { server, bridge, sim }
  }

  it('discovers robots from /fleet/status and admits them with live pose + battery', async () => {
    const { sim } = await connectedBridge()
    await until(() => sim.robots.length === 2, 5000, 'two robots in the roster')

    const ids = sim.robots.map((r) => r.id).sort()
    expect(ids).toEqual(['AMR-6', 'AMR-7'])
    for (const r of sim.robots) {
      // Battery came from BatteryState.percentage in [0,1] -> percent
      expect(r.battery).toBeGreaterThan(0)
      expect(r.battery).toBeLessThanOrEqual(100)
      // Pose landed inside the warehouse grid via the default transform
      expect(r.x).toBeGreaterThan(0)
      expect(r.x).toBeLessThan(GRID_W - 1)
      expect(r.y).toBeGreaterThan(0)
      expect(r.y).toBeLessThan(GRID_H - 1)
      expect(['moving', 'idle']).toContain(r.state)
    }
    // Model classes flowed through the fleet status payload
    expect(sim.getRobot('AMR-6').cls).toBe('100kg')
    expect(sim.getRobot('AMR-7').cls).toBe('600kg')
  })

  it('odometry keeps the grid pose moving while the robot patrols', async () => {
    const { sim } = await connectedBridge()
    const r = await until(() => sim.robots.find((x) => x.id === 'AMR-6'), 5000, 'AMR-6 admitted')
    const p0 = { x: r.x, y: r.y }
    await until(() => Math.hypot(r.x - p0.x, r.y - p0.y) > 0.3, 5000, 'grid pose changed')
    expect(r.state).toBe('moving')
  })

  it('commandGoto publishes a goal_pose; the mock converges near the station dock', async () => {
    const { server, bridge, sim } = await connectedBridge({ speedFactor: 25 })
    await until(() => sim.robots.length === 2, 5000, 'roster complete')

    const res = bridge.commandGoto('AMR-6', 'PACK-1', 'chat')
    expect(res.ok).toBe(true)

    const dock = getStation('PACK-1').dock
    const world = gridToWorld(DEFAULT_TRANSFORM, dock.x, dock.y)
    const bot = server.robots.find((b) => b.ns === 'amr_6')!
    await until(() => bot.goal !== null || bot.holding, 3000, 'mock accepted the goal')
    await until(
      () => Math.hypot(bot.x - world.x, bot.y - world.y) < 0.2,
      10_000,
      'mock robot at the dock in world coordinates',
    )
    // ...and the console sees it arrive at the dock cell over odometry.
    const r = sim.getRobot('AMR-6')
    await until(() => Math.hypot(r.x - dock.x, r.y - dock.y) < 1.0, 5000, 'grid pose at the dock')
    await until(() => r.mission === null, 5000, 'arrival clears the mission label')
    expect(sim.events.events.some((e) => e.type === 'ARRIVAL' && e.message.includes('PACK-1'))).toBe(true)
    // Command instrumentation matches the sim contract
    const logged = sim.commandLog.at(-1)!
    expect(logged).toMatchObject({ robotId: 'AMR-6', command: 'goto', target: 'PACK-1', source: 'chat', ok: true })
  })

  it('commandCharge publishes a goal at a charge bay dock', async () => {
    const { server, bridge, sim } = await connectedBridge()
    await until(() => sim.robots.length === 2, 5000, 'roster complete')
    const res = bridge.commandCharge('AMR-7', 'direct-manipulation', 'CHARGE-2')
    expect(res.ok).toBe(true)
    const world = gridToWorld(DEFAULT_TRANSFORM, getStation('CHARGE-2').dock.x, getStation('CHARGE-2').dock.y)
    const bot = server.robots.find((b) => b.ns === 'amr_7')!
    await until(() => bot.goal !== null, 3000, 'goal received')
    expect(bot.goal!.x).toBeCloseTo(world.x, 5)
    expect(bot.goal!.y).toBeCloseTo(world.y, 5)
  })

  it('e-stop publishes emergency_stop, freezes the mock, and mirrors state; resume releases it', async () => {
    const { server, bridge, sim } = await connectedBridge()
    await until(() => sim.robots.length === 2, 5000, 'roster complete')
    const r = sim.getRobot('AMR-6')
    const bot = server.robots.find((b) => b.ns === 'amr_6')!

    bridge.estopRobot('AMR-6')
    expect(r.state).toBe('estopped')
    await until(() => bot.frozen, 3000, 'mock frozen')
    const frozenAt = { x: bot.x, y: bot.y }
    await sleep(250)
    expect(bot.x).toBe(frozenAt.x)
    expect(bot.y).toBe(frozenAt.y)
    // Odometry keeps flowing but must not flip the estopped state
    expect(r.state).toBe('estopped')

    bridge.resumeRobot('AMR-6')
    await until(() => !bot.frozen, 3000, 'mock released')
    await until(() => r.state === 'moving', 5000, 'state recovers from odometry')
  })

  it('global e-stop halts every robot on the bridge', async () => {
    const { server, bridge, sim } = await connectedBridge()
    await until(() => sim.robots.length === 2, 5000, 'roster complete')
    bridge.estopAll()
    expect(sim.globalEstop).toBe(true)
    await until(() => server.robots.every((b) => b.frozen), 3000, 'both mocks frozen')
    expect(sim.robots.every((r) => r.state === 'estopped')).toBe(true)
    bridge.resumeAll()
    expect(sim.globalEstop).toBe(false)
    await until(() => server.robots.every((b) => !b.frozen), 3000, 'both mocks released')
  })

  it('refuses commands with honest reasons when the capability is not on the bridge', async () => {
    const { bridge, sim } = await connectedBridge()
    await until(() => sim.robots.length === 2, 5000, 'roster complete')

    const reroute = bridge.commandReroute('AMR-6', 'chat')
    expect(reroute.ok).toBe(false)
    expect(reroute.reason).toMatch(/Nav2/)

    const abort = bridge.commandAbortTask('AMR-6', 'chat')
    expect(abort.ok).toBe(false)
    expect(abort.reason).toMatch(/fleet-manager/)

    const estopped = sim.getRobot('AMR-7')
    bridge.estopRobot('AMR-7')
    const goto = bridge.commandGoto('AMR-7', 'PACK-2', 'chat')
    expect(goto.ok).toBe(false)
    expect(goto.reason).toMatch(/e-stopped/)
    expect(estopped.state).toBe('estopped')
    // Refusals are logged — interaction data, not silent no-ops.
    expect(sim.commandLog.filter((c) => !c.ok).length).toBeGreaterThanOrEqual(3)
  })
})
