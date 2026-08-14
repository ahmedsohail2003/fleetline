import { describe, expect, it } from 'vitest'
import { FleetSim } from '../sim'
import type { Robot } from '../robot'
import { CHARGE_RESUME } from '../robot'
import { cellKey } from '../types'

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

/** Standard test task: pick in R1 near the top-left, deliver to PACK-1. */
function addTestTask(sim: FleetSim, requiredClass: '100kg' | '600kg' | '1500kg' = '100kg') {
  return sim.enqueueTask({
    pickRack: { x: 8, y: 4 },
    pickApproach: { x: 8, y: 5 },
    rackRow: 'R1',
    stationName: 'PACK-1',
    requiredClass,
    priority: 2,
  })
}

describe('task assignment policy', () => {
  it('assigns the nearest idle robot of sufficient class', () => {
    const sim = quietSim()
    // AMR-1 (100kg) starts at (4,2): distance 7 to the pick approach (8,5).
    // Every other robot is farther away.
    const task = addTestTask(sim)
    sim.step()
    expect(task.state).toBe('assigned')
    expect(task.assignedTo).toBe('AMR-1')
    expect(sim.getRobot('AMR-1').state).toBe('moving')
  })

  it('skips under-capacity robots for heavy loads', () => {
    const sim = quietSim()
    const task = addTestTask(sim, '1500kg')
    sim.step()
    // Only AMR-5 is a 1500 kg unit, so it must win despite being farthest.
    expect(task.assignedTo).toBe('AMR-5')
  })

  it('leaves a task queued when no robot qualifies', () => {
    const sim = quietSim()
    sim.getRobot('AMR-5').battery = 10 // below assignment floor
    const task = addTestTask(sim, '1500kg')
    sim.step()
    expect(task.state).toBe('queued')
    expect(task.assignedTo).toBeNull()
  })
})

describe('battery and charging', () => {
  it('drains battery while working a task', () => {
    const sim = quietSim()
    addTestTask(sim)
    sim.step()
    const r = sim.getRobot('AMR-1')
    const before = r.battery
    for (let i = 0; i < 50; i++) sim.step()
    expect(r.battery).toBeLessThan(before)
  })

  it('sends a low-battery idle robot to a charge bay, charges it, and returns it to service', () => {
    const sim = quietSim()
    const r = sim.getRobot('AMR-2')
    r.battery = 15
    expect(stepUntil(sim, () => r.state === 'charging', 3000)).toBe(true)
    expect(r.chargerName).not.toBeNull()
    const docked = r.battery
    sim.step()
    expect(r.battery).toBeGreaterThan(docked)
    expect(stepUntil(sim, () => r.state === 'idle', 5000)).toBe(true)
    expect(r.battery).toBeGreaterThanOrEqual(CHARGE_RESUME)
  })

  it('finishes its current task before self-dispatching to charge', () => {
    const sim = quietSim()
    const task = addTestTask(sim)
    sim.step()
    const r = sim.getRobot('AMR-1')
    r.battery = 19 // below the charge threshold, mid-task
    expect(stepUntil(sim, () => task.state === 'completed', 20000)).toBe(true)
    // Task finished first; only then does the robot head for a charger.
    expect(stepUntil(sim, () => r.state === 'charging', 3000)).toBe(true)
  })
})

describe('task lifecycle', () => {
  it('completes a pick-and-deliver task and updates KPIs', () => {
    const sim = quietSim()
    const task = addTestTask(sim)
    expect(stepUntil(sim, () => task.state === 'completed', 20000)).toBe(true)
    const k = sim.kpis()
    expect(k.tasksCompleted).toBe(1)
    expect(k.avgTaskTimeS).toBeGreaterThan(0)
    expect(k.utilizationPct).toBeGreaterThan(0)
    const r = sim.getRobot('AMR-1')
    expect(r.taskId).toBeNull()
    expect(sim.events.events.some((e) => e.type === 'TASK_COMPLETED')).toBe(true)
  })
})

describe('help requests', () => {
  function movingRobotWithTask(sim: FleetSim): Robot {
    addTestTask(sim)
    sim.step()
    const r = sim.getRobot('AMR-1')
    stepUntil(sim, () => r.state === 'moving' && r.path.length - r.pathIndex > 5, 200)
    return r
  }

  it('PATH_BLOCKED: places an obstacle and "reroute" plans around it', () => {
    const sim = quietSim()
    const r = movingRobotWithTask(sim)
    const help = sim.injectHelpRequest('AMR-1', 'PATH_BLOCKED')
    expect(help).not.toBeNull()
    expect(r.state).toBe('awaiting_help')
    const obstacleKey = help!.data.obstacleKey
    expect(sim.obstacles.has(obstacleKey)).toBe(true)

    sim.resolveHelp(help!.id, 'reroute')
    expect(r.state).toBe('moving')
    // New path must avoid the obstacle cell.
    const onPath = r.path.some((c) => cellKey(c.x, c.y) === obstacleKey)
    expect(onPath).toBe(false)
    expect(help!.state).toBe('resolved')
    expect(sim.kpis().interventions).toBe(1)
  })

  it('PATH_BLOCKED: "wait" holds the robot until the obstruction clears', () => {
    const sim = quietSim()
    const r = movingRobotWithTask(sim)
    const help = sim.injectHelpRequest('AMR-1', 'PATH_BLOCKED')!
    sim.resolveHelp(help.id, 'wait')
    expect(r.state).toBe('blocked')
    const key = help.data.obstacleKey
    // Obstruction expires (wait TTL is 150 ticks), then the robot resumes.
    expect(stepUntil(sim, () => !sim.obstacles.has(key), 400)).toBe(true)
    expect(stepUntil(sim, () => r.state === 'moving', 10)).toBe(true)
  })

  it('PATH_BLOCKED: "abort" cancels the task and idles the robot', () => {
    const sim = quietSim()
    const r = movingRobotWithTask(sim)
    const task = sim.queue.get(r.taskId!)!
    const help = sim.injectHelpRequest('AMR-1', 'PATH_BLOCKED')!
    sim.resolveHelp(help.id, 'abort')
    expect(task.state).toBe('aborted')
    expect(r.taskId).toBeNull()
    expect(r.state).toBe('idle')
    expect(sim.kpis().tasksAborted).toBe(1)
  })

  it('LOW_CONFIDENCE: "confirm" resumes the mission', () => {
    const sim = quietSim()
    const r = movingRobotWithTask(sim)
    const help = sim.injectHelpRequest('AMR-1', 'LOW_CONFIDENCE')!
    expect(r.state).toBe('awaiting_help')
    sim.resolveHelp(help.id, 'confirm')
    expect(r.state).toBe('moving')
    expect(r.taskId).not.toBeNull()
  })

  it('LOW_CONFIDENCE: "send to staging" requeues the task and re-routes the robot', () => {
    const sim = quietSim()
    const r = movingRobotWithTask(sim)
    const task = sim.queue.get(r.taskId!)!
    const help = sim.injectHelpRequest('AMR-1', 'LOW_CONFIDENCE')!
    sim.resolveHelp(help.id, 'staging')
    expect(task.state).toBe('queued')
    expect(task.assignedTo).toBeNull()
    expect(r.taskId).toBeNull()
    expect(r.mission?.kind).toBe('staging')
  })

  it('STUCK_AT_PICK: "retry" restarts the pick; "skip" requeues the task', () => {
    const sim = quietSim()
    const task = addTestTask(sim)
    sim.step()
    const r = sim.getRobot('AMR-1')
    expect(stepUntil(sim, () => r.state === 'executing', 2000)).toBe(true)
    const help = sim.injectHelpRequest('AMR-1', 'STUCK_AT_PICK')!
    expect(r.state).toBe('awaiting_help')
    sim.resolveHelp(help.id, 'retry')
    expect(r.state).toBe('executing')

    const help2 = sim.injectHelpRequest('AMR-1', 'STUCK_AT_PICK')!
    sim.resolveHelp(help2.id, 'skip')
    expect(task.state).toBe('queued')
    expect(r.state).toBe('idle')
  })
})

describe('e-stop', () => {
  it('global e-stop freezes all movement; resume restores it', () => {
    const sim = quietSim()
    addTestTask(sim)
    sim.step()
    const r = sim.getRobot('AMR-1')
    stepUntil(sim, () => r.state === 'moving' && (r.progress > 0 || r.pathIndex > 0), 200)

    sim.estopAll()
    expect(sim.robots.every((x) => x.state === 'estopped')).toBe(true)
    const frozen = sim.robots.map((x) => ({ x: x.x, y: x.y, battery: x.battery }))
    for (let i = 0; i < 20; i++) sim.step()
    sim.robots.forEach((x, i) => {
      expect(x.x).toBe(frozen[i].x)
      expect(x.y).toBe(frozen[i].y)
      expect(x.battery).toBe(frozen[i].battery)
    })

    sim.resumeAll()
    expect(r.state).toBe('moving')
    const beforeX = r.x
    const beforeY = r.y
    for (let i = 0; i < 20; i++) sim.step()
    expect(r.x !== beforeX || r.y !== beforeY).toBe(true)
  })

  it('per-robot e-stop halts only that robot', () => {
    const sim = quietSim()
    addTestTask(sim)
    sim.step()
    const r = sim.getRobot('AMR-1')
    stepUntil(sim, () => r.state === 'moving', 200)
    sim.estopRobot('AMR-1')
    expect(r.state).toBe('estopped')
    expect(sim.getRobot('AMR-2').state).not.toBe('estopped')
    sim.resumeRobot('AMR-1')
    expect(r.state).toBe('moving')
  })

  it('an individually e-stopped robot survives the global release; swept robots resume', () => {
    const sim = quietSim()
    const locked = sim.getRobot('AMR-2')
    sim.estopRobot('AMR-2')
    sim.estopAll()
    expect(sim.robots.every((x) => x.state === 'estopped')).toBe(true)
    sim.resumeAll()
    expect(sim.globalEstop).toBe(false)
    expect(locked.state).toBe('estopped')
    for (const x of sim.robots) {
      if (x.id !== 'AMR-2') expect(x.state).not.toBe('estopped')
    }
  })

  it('the global release logs which robots it left stopped', () => {
    const sim = quietSim()
    sim.estopRobot('AMR-2')
    sim.estopAll()
    sim.resumeAll()
    const line = sim.events.events.find((e) => e.type === 'OPERATOR_ACTION' && e.message.includes('held'))
    expect(line).toBeDefined()
    expect(line!.message).toContain('AMR-2')
    expect(line!.message).not.toContain('AMR-1')
  })

  it('a per-robot release still clears an individual lockout after a global cycle', () => {
    const sim = quietSim()
    sim.estopRobot('AMR-2')
    sim.estopAll()
    sim.resumeAll()
    expect(sim.getRobot('AMR-2').state).toBe('estopped')
    sim.resumeRobot('AMR-2')
    expect(sim.getRobot('AMR-2').state).not.toBe('estopped')
  })

  it('an e-stop engaged on one robot during a global stop also survives the release', () => {
    const sim = quietSim()
    sim.estopAll()
    sim.estopRobot('AMR-3') // operator latches this one individually while all are down
    sim.resumeAll()
    expect(sim.getRobot('AMR-3').state).toBe('estopped')
    for (const x of sim.robots) {
      if (x.id !== 'AMR-3') expect(x.state).not.toBe('estopped')
    }
    sim.resumeRobot('AMR-3')
    expect(sim.getRobot('AMR-3').state).not.toBe('estopped')
  })
})

describe('determinism', () => {
  it('two sims with the same seed evolve identically', () => {
    const a = new FleetSim({ seed: 123 })
    const b = new FleetSim({ seed: 123 })
    for (let i = 0; i < 1500; i++) {
      a.step()
      b.step()
    }
    expect(a.events.totalAppended).toBe(b.events.totalAppended)
    expect(a.kpis()).toEqual(b.kpis())
    a.robots.forEach((ra, i) => {
      expect(ra.x).toBe(b.robots[i].x)
      expect(ra.y).toBe(b.robots[i].y)
      expect(ra.state).toBe(b.robots[i].state)
      expect(ra.battery).toBeCloseTo(b.robots[i].battery, 10)
    })
  })
})
