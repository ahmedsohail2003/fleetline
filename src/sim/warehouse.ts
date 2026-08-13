/**
 * Warehouse map for the Fleetline simulation.
 *
 * A 44 x 26 grid: perimeter walls, five horizontal storage-rack rows that
 * create labeled aisles (Aisle 1-5), a RECEIVING dock on the west wall,
 * PACK-1 / PACK-2 stations on the east wall, a STAGING area in the south
 * zone, and three charging bays (CHARGE-1..3) along the south floor.
 *
 * Coordinates: x grows east (0..43), y grows south (0..25).
 * Continuous robot positions use cell units where integer (x, y) is the
 * center of that cell.
 */

import type { Vec2 } from './types'

export type CellType = 'floor' | 'wall' | 'rack' | 'station' | 'charger'

export const GRID_W = 44
export const GRID_H = 26

export type StationKind = 'receiving' | 'pack' | 'staging' | 'charger'

export interface Station {
  name: string
  kind: StationKind
  /** All cells the station occupies (walkable). */
  cells: Vec2[]
  /** The cell a robot navigates to when serving this station. */
  dock: Vec2
}

export interface RackSegment {
  x0: number
  x1: number
  y: number
}

export interface RackRow {
  name: string
  y: number
  segments: RackSegment[]
}

export interface Aisle {
  name: string
  /** Corridor spans rows y0..y1 inclusive. */
  y0: number
  y1: number
  x0: number
  x1: number
}

export interface PickSpot {
  /** The rack cell holding the load. */
  rack: Vec2
  /** The adjacent walkable cell a robot stands on to pick. */
  approach: Vec2
  /** Which rack row this spot belongs to (e.g. "R1"). */
  rackRow: string
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const RACK_YS = [4, 7, 10, 13, 16]
// Each rack row is split into two segments with a center cross-aisle at x=21..22.
const RACK_SEGMENTS: Array<[number, number]> = [
  [7, 20],
  [23, 36],
]

export const RACK_ROWS: RackRow[] = RACK_YS.map((y, i) => ({
  name: `R${i + 1}`,
  y,
  segments: RACK_SEGMENTS.map(([x0, x1]) => ({ x0, x1, y })),
}))

/** Aisle i is the corridor directly south of rack row i. */
export const AISLES: Aisle[] = [
  { name: 'AISLE 1', y0: 5, y1: 6, x0: 7, x1: 36 },
  { name: 'AISLE 2', y0: 8, y1: 9, x0: 7, x1: 36 },
  { name: 'AISLE 3', y0: 11, y1: 12, x0: 7, x1: 36 },
  { name: 'AISLE 4', y0: 14, y1: 15, x0: 7, x1: 36 },
  { name: 'AISLE 5', y0: 17, y1: 18, x0: 7, x1: 36 },
]

function rect(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  const out: Vec2[] = []
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ x, y })
  return out
}

export const STATIONS: Station[] = [
  { name: 'RECEIVING', kind: 'receiving', cells: rect(1, 10, 2, 13), dock: { x: 2, y: 11 } },
  { name: 'PACK-1', kind: 'pack', cells: rect(41, 4, 42, 6), dock: { x: 41, y: 5 } },
  { name: 'PACK-2', kind: 'pack', cells: rect(41, 11, 42, 13), dock: { x: 41, y: 12 } },
  { name: 'STAGING', kind: 'staging', cells: rect(18, 20, 25, 22), dock: { x: 21, y: 21 } },
  { name: 'CHARGE-1', kind: 'charger', cells: [{ x: 8, y: 23 }], dock: { x: 8, y: 23 } },
  { name: 'CHARGE-2', kind: 'charger', cells: [{ x: 12, y: 23 }], dock: { x: 12, y: 23 } },
  { name: 'CHARGE-3', kind: 'charger', cells: [{ x: 16, y: 23 }], dock: { x: 16, y: 23 } },
]

export const CHARGER_NAMES = ['CHARGE-1', 'CHARGE-2', 'CHARGE-3'] as const
export const DELIVERY_STATIONS = ['PACK-1', 'PACK-2', 'RECEIVING'] as const

// ---------------------------------------------------------------------------
// Grid construction
// ---------------------------------------------------------------------------

function buildGrid(): CellType[][] {
  const grid: CellType[][] = []
  for (let y = 0; y < GRID_H; y++) {
    const row: CellType[] = []
    for (let x = 0; x < GRID_W; x++) {
      const isWall = x === 0 || y === 0 || x === GRID_W - 1 || y === GRID_H - 1
      row.push(isWall ? 'wall' : 'floor')
    }
    grid.push(row)
  }
  for (const rowDef of RACK_ROWS) {
    for (const seg of rowDef.segments) {
      for (let x = seg.x0; x <= seg.x1; x++) grid[seg.y][x] = 'rack'
    }
  }
  for (const st of STATIONS) {
    const t: CellType = st.kind === 'charger' ? 'charger' : 'station'
    for (const c of st.cells) grid[c.y][c.x] = t
  }
  return grid
}

/** The warehouse grid, indexed grid[y][x]. */
export const GRID: CellType[][] = buildGrid()

const STATION_BY_NAME = new Map<string, Station>(STATIONS.map((s) => [s.name, s]))

export function getStation(name: string): Station {
  const st = STATION_BY_NAME.get(name)
  if (!st) throw new Error(`Unknown station: ${name}`)
  return st
}

export function cellAt(x: number, y: number): CellType {
  if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) return 'wall'
  return GRID[y][x]
}

/** Robots may occupy floor, station, and charger cells. */
export function isWalkable(x: number, y: number): boolean {
  const t = cellAt(x, y)
  return t === 'floor' || t === 'station' || t === 'charger'
}

/** Returns the aisle containing row y, or null (e.g. transit corridors). */
export function aisleAt(y: number): Aisle | null {
  return AISLES.find((a) => y >= a.y0 && y <= a.y1) ?? null
}

// ---------------------------------------------------------------------------
// Pick spots: every rack cell paired with its walkable approach cell.
// ---------------------------------------------------------------------------

function buildPickSpots(): PickSpot[] {
  const spots: PickSpot[] = []
  for (const rowDef of RACK_ROWS) {
    for (const seg of rowDef.segments) {
      for (let x = seg.x0; x <= seg.x1; x++) {
        // Prefer the aisle south of the rack; fall back to the north side.
        const south = { x, y: seg.y + 1 }
        const north = { x, y: seg.y - 1 }
        const approach = isWalkable(south.x, south.y) ? south : north
        if (isWalkable(approach.x, approach.y)) {
          spots.push({ rack: { x, y: seg.y }, approach, rackRow: rowDef.name })
        }
      }
    }
  }
  return spots
}

export const PICK_SPOTS: PickSpot[] = buildPickSpots()
