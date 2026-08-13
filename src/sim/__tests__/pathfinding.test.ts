import { describe, expect, it } from 'vitest'
import { findPath, ReservationTable } from '../pathfinding'
import { GRID_H, GRID_W, isWalkable } from '../warehouse'
import { cellKey } from '../types'

const open = () => true

describe('A* pathfinding', () => {
  it('finds the shortest path on an open grid', () => {
    const path = findPath(open, 20, 20, { x: 1, y: 1 }, { x: 8, y: 1 })
    expect(path).not.toBeNull()
    // Manhattan distance 7 => 8 cells including start and goal.
    expect(path!.length).toBe(8)
    expect(path![0]).toEqual({ x: 1, y: 1 })
    expect(path![path!.length - 1]).toEqual({ x: 8, y: 1 })
  })

  it('returns null when the goal is unreachable', () => {
    // Goal sealed in by unwalkable ring.
    const walls = new Set(['4,4', '5,4', '6,4', '4,5', '6,5', '4,6', '5,6', '6,6'])
    const walkable = (x: number, y: number) => !walls.has(cellKey(x, y))
    const path = findPath(walkable, 10, 10, { x: 1, y: 1 }, { x: 5, y: 5 })
    expect(path).toBeNull()
  })

  it('routes through the warehouse without crossing racks or walls', () => {
    // Aisle 1 to Aisle 5, across all rack rows.
    const path = findPath(isWalkable, GRID_W, GRID_H, { x: 10, y: 5 }, { x: 30, y: 18 })
    expect(path).not.toBeNull()
    for (const c of path!) {
      expect(isWalkable(c.x, c.y)).toBe(true)
    }
  })

  it('detours around avoided cells and returns a longer path', () => {
    const direct = findPath(open, 20, 20, { x: 1, y: 5 }, { x: 10, y: 5 })
    // Vertical fence with a gap far from the straight line.
    const avoid = new Set<string>()
    for (let y = 0; y < 12; y++) avoid.add(cellKey(5, y))
    const detour = findPath(open, 20, 20, { x: 1, y: 5 }, { x: 10, y: 5 }, avoid)
    expect(detour).not.toBeNull()
    expect(detour!.length).toBeGreaterThan(direct!.length)
    for (const c of detour!) {
      expect(avoid.has(cellKey(c.x, c.y))).toBe(false)
    }
  })
})

describe('ReservationTable', () => {
  it('tracks reservations per robot and blocks others', () => {
    const table = new ReservationTable()
    table.reserve('AMR-1', [
      { x: 2, y: 2 },
      { x: 3, y: 2 },
    ])
    expect(table.reservedBy(2, 2)).toBe('AMR-1')
    expect(table.isBlockedFor('AMR-2', 3, 2)).toBe(true)
    expect(table.isBlockedFor('AMR-1', 3, 2)).toBe(false)
  })

  it('replaces a robot reservation wholesale on re-reserve', () => {
    const table = new ReservationTable()
    table.reserve('AMR-1', [{ x: 2, y: 2 }])
    table.reserve('AMR-1', [{ x: 5, y: 5 }])
    expect(table.reservedBy(2, 2)).toBeUndefined()
    expect(table.reservedBy(5, 5)).toBe('AMR-1')
  })

  it('does not let a robot steal a cell already held by another', () => {
    const table = new ReservationTable()
    table.reserve('AMR-1', [{ x: 4, y: 4 }])
    table.reserve('AMR-2', [
      { x: 4, y: 4 },
      { x: 5, y: 4 },
    ])
    expect(table.reservedBy(4, 4)).toBe('AMR-1')
    expect(table.reservedBy(5, 4)).toBe('AMR-2')
  })

  it('releases all cells held by a robot', () => {
    const table = new ReservationTable()
    table.reserve('AMR-1', [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ])
    table.release('AMR-1')
    expect(table.reservedBy(1, 1)).toBeUndefined()
    expect(table.reservedBy(2, 1)).toBeUndefined()
  })

  it('reports cells reserved by other robots', () => {
    const table = new ReservationTable()
    table.reserve('AMR-1', [{ x: 1, y: 1 }])
    table.reserve('AMR-2', [{ x: 9, y: 9 }])
    const others = table.cellsReservedByOthers('AMR-1')
    expect(others.has('9,9')).toBe(true)
    expect(others.has('1,1')).toBe(false)
  })
})
