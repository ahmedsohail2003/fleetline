import { describe, expect, it } from 'vitest'
import { makeTask, TaskQueue } from '../tasks'
import type { TaskPriority } from '../tasks'

function task(id: string, priority: TaskPriority, createdTick: number) {
  return makeTask({
    id,
    pickRack: { x: 8, y: 4 },
    pickApproach: { x: 8, y: 5 },
    rackRow: 'R1',
    stationName: 'PACK-1',
    requiredClass: '100kg',
    priority,
    createdTick,
  })
}

describe('TaskQueue ordering', () => {
  it('orders by priority first, then by age', () => {
    const q = new TaskQueue()
    q.add(task('T-A', 3, 0))
    q.add(task('T-B', 1, 10))
    q.add(task('T-C', 2, 5))
    q.add(task('T-D', 1, 2))
    expect(q.queued().map((t) => t.id)).toEqual(['T-D', 'T-B', 'T-C', 'T-A'])
  })

  it('excludes non-queued tasks from assignment order', () => {
    const q = new TaskQueue()
    const a = task('T-A', 1, 0)
    q.add(a)
    q.add(task('T-B', 2, 0))
    a.state = 'assigned'
    expect(q.queued().map((t) => t.id)).toEqual(['T-B'])
    expect(q.countByState('assigned')).toBe(1)
  })
})
