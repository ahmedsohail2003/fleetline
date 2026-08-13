/**
 * Deterministic seeded RNG (mulberry32).
 * All randomness in the simulation flows through one of these streams so a
 * given seed always reproduces the exact same shift — critical for unit tests
 * and for replaying scenarios during usability sessions.
 */

export type Rng = () => number

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Pick a uniformly random element from a non-empty array. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]
}

/** Integer in [min, max] inclusive. */
export function rangeInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}
