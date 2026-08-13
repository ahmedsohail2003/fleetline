/**
 * Pure UI derivations: battery levels, task-progress estimation, event
 * categories/filters, formatters, and the map hit-testing geometry.
 */

import { describe, expect, it } from 'vitest'
import {
  batteryLevel,
  eventCategory,
  EVENT_META,
  formatDurationS,
  formatElapsedTicks,
  matchesFilter,
  ROBOT_STATE_META,
  taskProgress,
} from '../derive'
import type { SimEventType } from '../sim/events'
import { FleetSim } from '../sim/sim'
import { computeLayout, robotAtPoint, stationAtPoint } from '../canvas'
import { getStation } from '../sim/warehouse'

function quietSim(seed = 7): FleetSim {
  return new FleetSim({
    seed,
    autoGenerate: false,
    helpRates: { pathBlocked: 0, lowConfidence: 0, stuckAtPick: 0 },
  })
}

describe('batteryLevel', () => {
  it('follows the console thresholds (amber < 30, red < 15)', () => {
    expect(batteryLevel(100)).toBe('ok')
    expect(batteryLevel(30)).toBe('ok')
    expect(batteryLevel(29.9)).toBe('warn')
    expect(batteryLevel(15)).toBe('warn')
    expect(batteryLevel(14.9)).toBe('danger')
    expect(batteryLevel(0)).toBe('danger')
  })
})

describe('robot state chips', () => {
  it('gives every state a text label (state is never color-only)', () => {
    for (const meta of Object.values(ROBOT_STATE_META)) {
      expect(meta.label.length).toBeGreaterThan(0)
    }
  })
})

describe('taskProgress', () => {
  it('is null without a task and monotonically non-decreasing across one task', () => {
    const sim = quietSim()
    const r = sim.getRobot('AMR-1')
    expect(taskProgress(r)).toBeNull()

    const task = sim.enqueueTask({
      pickRack: { x: 8, y: 4 },
      pickApproach: { x: 8, y: 5 },
      rackRow: 'R1',
      stationName: 'PACK-1',
      requiredClass: '100kg',
      priority: 2,
    })
    let prev = -1
    let sawMid = false
    for (let i = 0; i < 20000 && task.state !== 'completed'; i++) {
      sim.step()
      const p = taskProgress(r)
      if (p !== null) {
        expect(p).toBeGreaterThanOrEqual(0)
        expect(p).toBeLessThanOrEqual(1)
        expect(p).toBeGreaterThanOrEqual(prev - 1e-9)
        prev = p
        if (p > 0.5) sawMid = true
      }
    }
    expect(task.state).toBe('completed')
    expect(sawMid).toBe(true)
    expect(prev).toBeGreaterThan(0.9)
    expect(taskProgress(r)).toBeNull() // task released after completion
  })
})

describe('event categories and filters', () => {
  it('maps every event type to a category and presentation meta', () => {
    const expected: Record<SimEventType, string> = {
      SIM: 'system',
      STATE_CHANGE: 'tasks',
      TASK_CREATED: 'tasks',
      TASK_ASSIGNED: 'tasks',
      TASK_COMPLETED: 'tasks',
      TASK_ABORTED: 'tasks',
      TASK_REQUEUED: 'tasks',
      ARRIVAL: 'tasks',
      HELP_REQUEST: 'alerts',
      HELP_RESOLVED: 'operator',
      OPERATOR_ACTION: 'operator',
      BATTERY: 'alerts',
      TRAFFIC: 'alerts',
    }
    for (const [type, cat] of Object.entries(expected)) {
      expect(eventCategory(type as SimEventType)).toBe(cat)
      expect(EVENT_META[type as SimEventType].tag.trim().length).toBeGreaterThan(0)
    }
  })

  it('matchesFilter: "all" passes everything, others match their category', () => {
    const sim = quietSim()
    sim.estopAll() // logs OPERATOR_ACTION
    const ev = sim.events.events.find((e) => e.type === 'OPERATOR_ACTION')!
    const simEv = sim.events.events.find((e) => e.type === 'SIM')!
    expect(matchesFilter(ev, 'all')).toBe(true)
    expect(matchesFilter(ev, 'operator')).toBe(true)
    expect(matchesFilter(ev, 'tasks')).toBe(false)
    expect(matchesFilter(simEv, 'all')).toBe(true)
    expect(matchesFilter(simEv, 'operator')).toBe(false)
  })
})

describe('formatters', () => {
  it('formatDurationS', () => {
    expect(formatDurationS(0)).toBe('0s')
    expect(formatDurationS(42.4)).toBe('42s')
    expect(formatDurationS(102.4)).toBe('1m 42s')
    expect(formatDurationS(119.7)).toBe('2m 00s')
    expect(formatDurationS(Number.NaN)).toBe('0s')
  })

  it('formatElapsedTicks', () => {
    expect(formatElapsedTicks(0)).toBe('0:00')
    expect(formatElapsedTicks(125)).toBe('0:12')
    expect(formatElapsedTicks(725)).toBe('1:12')
  })
})

describe('map hit-testing', () => {
  const L = computeLayout(1100, 700)

  it('finds a robot at its own center and misses far away', () => {
    const sim = quietSim()
    const r = sim.getRobot('AMR-1') // at cell (4, 2)
    const px = L.ox + (r.x + 0.5) * L.cell
    const py = L.oy + (r.y + 0.5) * L.cell
    expect(robotAtPoint(sim, 0, L, px, py)).toBe('AMR-1')
    expect(robotAtPoint(sim, 0, L, px + L.cell * 3, py + L.cell * 3)).toBeNull()
  })

  it('finds stations by their footprint and returns null on open floor', () => {
    const st = getStation('PACK-1')
    const cx = L.ox + (st.cells[0].x + 0.5) * L.cell
    const cy = L.oy + (st.cells[0].y + 0.5) * L.cell
    expect(stationAtPoint(L, cx, cy)).toBe('PACK-1')
    // Aisle 1 interior, x=10,y=5 — walkable floor, not a station.
    expect(stationAtPoint(L, L.ox + 10.5 * L.cell, L.oy + 5.5 * L.cell)).toBeNull()
  })

  it('reserves bottom inset for the detail drawer', () => {
    const full = computeLayout(1100, 700, 0)
    const inset = computeLayout(1100, 700, 244)
    expect(inset.cell).toBeLessThan(full.cell)
  })
})
