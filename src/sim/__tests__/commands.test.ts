/**
 * Operator command API: manual goto / charge dispatch, the modality labels
 * used by the direct-manipulation vs chat comparison, task history, and
 * decision-latency logging.
 */

import { describe, expect, it } from 'vitest'
import { FleetSim } from '../sim'
import { getStation } from '../warehouse'

/** A sim with no random noise: no auto tasks, no random help events. */
function quietSim(seed = 7): FleetSim {
  return new FleetSim({
    seed,
    autoGenerate: false,
    helpRates: { pathBlocked: 0, lowConfidence: 0, stuckAtPick: 0 },
  })
}

function stepUntil(sim: FleetSim, cond: () => boolean, maxTicks = 20000): boolean {
  for (let i = 0; i < maxTicks; i++) {
    if (cond()) return true
    sim.step()
  }
  return cond()
}

function addTestTask(sim: FleetSim) {
  return sim.enqueueTask({
    pickRack: { x: 8, y: 4 },
    pickApproach: { x: 8, y: 5 },
    rackRow: 'R1',
    stationName: 'PACK-1',
    requiredClass: '100kg',
    priority: 2,
  })
}

describe('commandGoto', () => {
  it('dispatches an idle robot to a station and idles it on arrival', () => {
    const sim = quietSim()
    const r = sim.getRobot('AMR-1')
    const res = sim.commandGoto('AMR-1', 'PACK-1', 'direct-manipulation')
    expect(res.ok).toBe(true)
    expect(r.state).toBe('moving')
    expect(r.mission?.kind).toBe('goto')
    const dock = getStation('PACK-1').dock
    expect(stepUntil(sim, () => r.state === 'idle' && r.gx === dock.x && r.gy === dock.y, 5000)).toBe(true)
    expect(sim.events.events.some((e) => e.type === 'ARRIVAL' && e.message.includes('PACK-1'))).toBe(true)
  })

  it('records the command with its modality in the command log and event log', () => {
    const sim = quietSim()
    sim.commandGoto('AMR-1', 'STAGING', 'chat')
    expect(sim.commandLog).toHaveLength(1)
    expect(sim.commandLog[0]).toMatchObject({
      robotId: 'AMR-1',
      command: 'goto',
      target: 'STAGING',
      source: 'chat',
      ok: true,
    })
    expect(sim.events.events.some((e) => e.type === 'OPERATOR_ACTION' && e.message.includes('[chat]'))).toBe(true)
  })

  it('returns an in-flight (not yet picked) task to the queue', () => {
    const sim = quietSim()
    const task = addTestTask(sim)
    sim.step()
    const r = sim.getRobot('AMR-1')
    expect(r.state).toBe('moving')
    const res = sim.commandGoto('AMR-1', 'RECEIVING')
    expect(res.ok).toBe(true)
    expect(task.state).toBe('queued')
    expect(task.assignedTo).toBeNull()
    expect(r.taskId).toBeNull()
    expect(r.mission?.kind).toBe('goto')
    expect(r.history.at(-1)).toMatchObject({ taskId: task.id, outcome: 'requeued' })
  })

  it('refuses while carrying a load, executing, e-stopped, or awaiting help', () => {
    const sim = quietSim()
    const r = sim.getRobot('AMR-1')

    // executing (mid-pick)
    addTestTask(sim)
    sim.step()
    stepUntil(sim, () => r.state === 'executing', 2000)
    expect(sim.commandGoto('AMR-1', 'PACK-2').ok).toBe(false)

    // carrying (to_drop)
    stepUntil(sim, () => r.phase === 'to_drop', 2000)
    const carrying = sim.commandGoto('AMR-1', 'PACK-2')
    expect(carrying.ok).toBe(false)
    expect(carrying.reason).toContain('carrying')

    // awaiting help
    const help = sim.injectHelpRequest('AMR-1', 'PATH_BLOCKED')
    expect(help).not.toBeNull()
    expect(sim.commandGoto('AMR-1', 'PACK-2').ok).toBe(false)
    sim.resolveHelp(help!.id, 'abort')

    // e-stopped
    sim.estopRobot('AMR-1')
    const stopped = sim.commandGoto('AMR-1', 'PACK-2')
    expect(stopped.ok).toBe(false)
    expect(stopped.reason).toContain('e-stopped')

    // refusals are instrumentation too
    expect(sim.commandLog.filter((c) => !c.ok).length).toBeGreaterThanOrEqual(4)
  })

  it('rejects unknown stations', () => {
    const sim = quietSim()
    const res = sim.commandGoto('AMR-1', 'PACK-9')
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('Unknown station')
  })

  it('delegates charge-bay targets to commandCharge', () => {
    const sim = quietSim()
    const r = sim.getRobot('AMR-1')
    const res = sim.commandGoto('AMR-1', 'CHARGE-2')
    expect(res.ok).toBe(true)
    expect(r.mission?.kind).toBe('charge')
    expect(r.chargerName).toBe('CHARGE-2')
    expect(sim.chargerAssignments.get('CHARGE-2')).toBe('AMR-1')
  })
})

describe('commandCharge', () => {
  it('sends the robot to the nearest free bay and it docks', () => {
    const sim = quietSim()
    const r = sim.getRobot('AMR-2')
    const res = sim.commandCharge('AMR-2')
    expect(res.ok).toBe(true)
    expect(r.chargerName).not.toBeNull()
    expect(stepUntil(sim, () => r.state === 'charging', 3000)).toBe(true)
  })

  it('refuses a named bay that is already assigned to another robot', () => {
    const sim = quietSim()
    expect(sim.commandCharge('AMR-1', 'direct-manipulation', 'CHARGE-1').ok).toBe(true)
    const res = sim.commandCharge('AMR-2', 'direct-manipulation', 'CHARGE-1')
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('occupied')
  })

  it('refuses when the robot is already charging', () => {
    const sim = quietSim()
    const r = sim.getRobot('AMR-2')
    sim.commandCharge('AMR-2')
    stepUntil(sim, () => r.state === 'charging', 3000)
    const res = sim.commandCharge('AMR-2')
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('already charging')
  })
})

describe('task history', () => {
  it('records completed tasks', () => {
    const sim = quietSim()
    const task = addTestTask(sim)
    expect(stepUntil(sim, () => task.state === 'completed', 20000)).toBe(true)
    const r = sim.getRobot('AMR-1')
    expect(r.history.at(-1)).toMatchObject({ taskId: task.id, outcome: 'completed' })
  })

  it('records aborted tasks from a help resolution', () => {
    const sim = quietSim()
    const task = addTestTask(sim)
    sim.step()
    const r = sim.getRobot('AMR-1')
    stepUntil(sim, () => r.state === 'moving' && r.path.length - r.pathIndex > 5, 200)
    const help = sim.injectHelpRequest('AMR-1', 'PATH_BLOCKED')!
    sim.resolveHelp(help.id, 'abort')
    expect(r.history.at(-1)).toMatchObject({ taskId: task.id, outcome: 'aborted' })
  })
})

describe('decision latency', () => {
  it('logs how long the operator took to resolve a help request', () => {
    const sim = quietSim()
    addTestTask(sim)
    sim.step()
    const r = sim.getRobot('AMR-1')
    stepUntil(sim, () => r.state === 'moving' && r.path.length - r.pathIndex > 5, 200)
    const help = sim.injectHelpRequest('AMR-1', 'PATH_BLOCKED')!
    for (let i = 0; i < 42; i++) sim.step() // operator "thinks" for 4.2 s
    sim.resolveHelp(help.id, 'reroute')
    const line = sim.events.events.find(
      (e) => e.type === 'OPERATOR_ACTION' && e.message.includes('decided in'),
    )
    expect(line).toBeDefined()
    expect(line!.message).toContain('4.2 s')
    expect(help.resolvedTick! - help.createdTick).toBe(42)
  })
})
