/**
 * Grid pathfinding for the Fleetline simulation.
 *
 * - A* over a 4-connected grid with Manhattan heuristic.
 * - A cell-reservation table for traffic deconfliction: each robot reserves
 *   its current cell plus the next few cells of its path. A robot whose next
 *   cell is reserved by another robot waits, and after a patience window
 *   replans around the other robot's reserved cells.
 */

import type { Vec2 } from './types'
import { cellKey, manhattan } from './types'

export type WalkableFn = (x: number, y: number) => boolean

interface AStarNode {
  x: number
  y: number
  g: number
  f: number
  parent: AStarNode | null
}

const NEIGHBORS: ReadonlyArray<Vec2> = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
]

/**
 * A* shortest path from start to goal (both inclusive in the result).
 * `avoid` is a set of cell keys treated as unwalkable (obstacles, cells
 * reserved by other robots). The start cell is always allowed so a robot
 * standing on an avoided cell can still plan its way out.
 * Returns null when no path exists.
 */
export function findPath(
  walkable: WalkableFn,
  width: number,
  height: number,
  start: Vec2,
  goal: Vec2,
  avoid?: ReadonlySet<string>,
): Vec2[] | null {
  if (!walkable(goal.x, goal.y)) return null
  if (start.x === goal.x && start.y === goal.y) return [{ x: start.x, y: start.y }]

  const startKey = cellKey(start.x, start.y)
  const blocked = (x: number, y: number): boolean => {
    const k = cellKey(x, y)
    if (k === startKey) return false
    return avoid !== undefined && avoid.has(k)
  }

  const open: AStarNode[] = [
    { x: start.x, y: start.y, g: 0, f: manhattan(start.x, start.y, goal.x, goal.y), parent: null },
  ]
  const gScore = new Map<string, number>([[startKey, 0]])
  const closed = new Set<string>()

  while (open.length > 0) {
    // Extract lowest-f node. Grid is small (44x26), linear scan is fine.
    let bestIdx = 0
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[bestIdx].f) bestIdx = i
    }
    const current = open.splice(bestIdx, 1)[0]
    const curKey = cellKey(current.x, current.y)
    if (closed.has(curKey)) continue
    closed.add(curKey)

    if (current.x === goal.x && current.y === goal.y) {
      const path: Vec2[] = []
      let n: AStarNode | null = current
      while (n) {
        path.push({ x: n.x, y: n.y })
        n = n.parent
      }
      path.reverse()
      return path
    }

    for (const d of NEIGHBORS) {
      const nx = current.x + d.x
      const ny = current.y + d.y
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      if (!walkable(nx, ny)) continue
      if (blocked(nx, ny)) continue
      const nKey = cellKey(nx, ny)
      if (closed.has(nKey)) continue
      const g = current.g + 1
      const known = gScore.get(nKey)
      if (known !== undefined && known <= g) continue
      gScore.set(nKey, g)
      open.push({ x: nx, y: ny, g, f: g + manhattan(nx, ny, goal.x, goal.y), parent: current })
    }
  }
  return null
}

/**
 * Cell-reservation table. Each robot holds a set of reserved cells
 * (its current cell + the next few path cells). Reservations are replaced
 * wholesale each time a robot re-reserves, so stale claims cannot linger.
 */
export class ReservationTable {
  private byCell = new Map<string, string>()
  private byRobot = new Map<string, string[]>()

  /** Replace all of `robotId`'s reservations with `cells`. */
  reserve(robotId: string, cells: ReadonlyArray<Vec2>): void {
    this.release(robotId)
    const keys: string[] = []
    for (const c of cells) {
      const k = cellKey(c.x, c.y)
      // First-come-first-served: do not steal a cell another robot holds.
      const holder = this.byCell.get(k)
      if (holder !== undefined && holder !== robotId) continue
      this.byCell.set(k, robotId)
      keys.push(k)
    }
    this.byRobot.set(robotId, keys)
  }

  /** Drop all reservations held by `robotId`. */
  release(robotId: string): void {
    const keys = this.byRobot.get(robotId)
    if (keys) {
      for (const k of keys) {
        if (this.byCell.get(k) === robotId) this.byCell.delete(k)
      }
    }
    this.byRobot.delete(robotId)
  }

  /** Which robot (if any) holds this cell. */
  reservedBy(x: number, y: number): string | undefined {
    return this.byCell.get(cellKey(x, y))
  }

  /** True when the cell is held by a robot other than `robotId`. */
  isBlockedFor(robotId: string, x: number, y: number): boolean {
    const holder = this.byCell.get(cellKey(x, y))
    return holder !== undefined && holder !== robotId
  }

  /** Snapshot of every cell key held by robots other than `robotId`. */
  cellsReservedByOthers(robotId: string): Set<string> {
    const out = new Set<string>()
    for (const [k, holder] of this.byCell) {
      if (holder !== robotId) out.add(k)
    }
    return out
  }
}
