/**
 * World <-> grid coordinate transform: scale, offset, and the y-axis flip
 * between REP-103 world coordinates (y north/up) and the screen-oriented
 * warehouse grid (y south/down).
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_TRANSFORM, gridToWorld, worldToGrid } from '../transform'
import type { GridTransform } from '../transform'

describe('grid transform', () => {
  it('maps the world origin to the configured origin cell', () => {
    const g = worldToGrid(DEFAULT_TRANSFORM, 0, 0)
    expect(g.x).toBe(DEFAULT_TRANSFORM.originCellX)
    expect(g.y).toBe(DEFAULT_TRANSFORM.originCellY)
  })

  it('flips the y axis: world +y (north) decreases grid y', () => {
    const g = worldToGrid(DEFAULT_TRANSFORM, 0, 2)
    expect(g.y).toBeLessThan(DEFAULT_TRANSFORM.originCellY)
    // 2 m at 0.5 m/cell = 4 cells north of the origin cell
    expect(g.y).toBeCloseTo(DEFAULT_TRANSFORM.originCellY - 4, 10)
    // and world +x (east) increases grid x
    const gx = worldToGrid(DEFAULT_TRANSFORM, 1, 0)
    expect(gx.x).toBeCloseTo(DEFAULT_TRANSFORM.originCellX + 2, 10)
  })

  it('gridToWorld inverts worldToGrid (round trip)', () => {
    const t: GridTransform = { metersPerCell: 0.25, originCellX: 10, originCellY: 20 }
    for (const [wx, wy] of [
      [0, 0],
      [3.7, -1.2],
      [-5.5, 4.25],
    ]) {
      const g = worldToGrid(t, wx, wy)
      const w = gridToWorld(t, g.x, g.y)
      expect(w.x).toBeCloseTo(wx, 10)
      expect(w.y).toBeCloseTo(wy, 10)
    }
  })

  it('station docks land at plausible world coordinates under the default transform', () => {
    // PACK-1 dock is grid (41, 5): east side, north half of the warehouse.
    const w = gridToWorld(DEFAULT_TRANSFORM, 41, 5)
    expect(w.x).toBeCloseTo(9.5, 10)
    expect(w.y).toBeCloseTo(4.0, 10)
  })
})
