import { describe, expect, it } from 'vitest'
import {
  AISLES,
  cellAt,
  getStation,
  GRID_H,
  GRID_W,
  isWalkable,
  PICK_SPOTS,
  RACK_ROWS,
  STATIONS,
} from '../warehouse'

describe('warehouse map', () => {
  it('has the expected dimensions and a walled perimeter', () => {
    expect(GRID_W).toBe(44)
    expect(GRID_H).toBe(26)
    for (let x = 0; x < GRID_W; x++) {
      expect(cellAt(x, 0)).toBe('wall')
      expect(cellAt(x, GRID_H - 1)).toBe('wall')
    }
    for (let y = 0; y < GRID_H; y++) {
      expect(cellAt(0, y)).toBe('wall')
      expect(cellAt(GRID_W - 1, y)).toBe('wall')
    }
  })

  it('has five rack rows and five labeled aisles', () => {
    expect(RACK_ROWS.length).toBe(5)
    expect(AISLES.map((a) => a.name)).toEqual(['AISLE 1', 'AISLE 2', 'AISLE 3', 'AISLE 4', 'AISLE 5'])
  })

  it('defines all named stations with walkable docks', () => {
    const names = ['RECEIVING', 'PACK-1', 'PACK-2', 'STAGING', 'CHARGE-1', 'CHARGE-2', 'CHARGE-3']
    expect(STATIONS.map((s) => s.name).sort()).toEqual([...names].sort())
    for (const name of names) {
      const st = getStation(name)
      expect(isWalkable(st.dock.x, st.dock.y)).toBe(true)
    }
    expect(cellAt(getStation('CHARGE-1').dock.x, getStation('CHARGE-1').dock.y)).toBe('charger')
  })

  it('gives every pick spot a rack cell and a walkable approach', () => {
    expect(PICK_SPOTS.length).toBeGreaterThan(100)
    for (const spot of PICK_SPOTS) {
      expect(cellAt(spot.rack.x, spot.rack.y)).toBe('rack')
      expect(isWalkable(spot.approach.x, spot.approach.y)).toBe(true)
    }
  })
})
