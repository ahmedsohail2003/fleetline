/**
 * World <-> grid coordinate transform for ROS mode.
 *
 * ROS 2 poses arrive in meters in a world frame that follows REP-103: x grows
 * "east", y grows "north" (counter-clockwise-positive, z up). The Fleetline
 * warehouse grid is screen-oriented: x grows east in cell units, but y grows
 * SOUTH (down the screen). The transform is therefore a uniform scale plus an
 * offset, with the y axis flipped:
 *
 *   gridX = originCellX + worldX / metersPerCell
 *   gridY = originCellY - worldY / metersPerCell
 *
 * `originCellX/Y` is the grid cell (in continuous cell units) where the ROS
 * world origin (0, 0) lands. The default puts the world origin at the center
 * of the 44 x 26 warehouse, with 0.5 m per cell — so the drawable floor spans
 * roughly x in [-11, +11] m and y in [-6.5, +6.5] m in world coordinates.
 *
 * All three numbers are configurable per deployment (URL params `cellm`,
 * `originx`, `originy` — see docs/ROS2.md) because a real map's origin and
 * resolution come from its map.yaml, not from this console.
 */

export interface GridTransform {
  /** World meters represented by one grid cell (must be > 0). */
  metersPerCell: number
  /** Grid x (continuous cell units) where world x = 0 lands. */
  originCellX: number
  /** Grid y (continuous cell units) where world y = 0 lands. */
  originCellY: number
}

export const DEFAULT_TRANSFORM: GridTransform = {
  metersPerCell: 0.5,
  originCellX: 22,
  originCellY: 13,
}

export function worldToGrid(t: GridTransform, worldX: number, worldY: number): { x: number; y: number } {
  return {
    x: t.originCellX + worldX / t.metersPerCell,
    y: t.originCellY - worldY / t.metersPerCell,
  }
}

export function gridToWorld(t: GridTransform, gridX: number, gridY: number): { x: number; y: number } {
  return {
    x: (gridX - t.originCellX) * t.metersPerCell,
    y: (t.originCellY - gridY) * t.metersPerCell,
  }
}
