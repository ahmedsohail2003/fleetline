/**
 * Shared primitive types for the Fleetline simulation engine.
 * Pure TypeScript — no React, no DOM, no wall-clock time.
 */

export interface Vec2 {
  x: number
  y: number
}

/** Stable string key for a grid cell, used by reservation tables and obstacle maps. */
export function cellKey(x: number, y: number): string {
  return `${x},${y}`
}

export function manhattan(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by)
}
