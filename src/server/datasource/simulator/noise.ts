/**
 * Deterministic noise for the Simulator_Source.
 *
 * Jitter is a pure function of (seed, key, tick) rather than a stateful RNG, so the
 * simulator's default values are a pure function of seed and time (design decision 3).
 */

/** Length of one simulator tick in milliseconds. */
export const TICK_MS = 5000;

/** The tick that contains the epoch-ms time `now`. */
export function tickOf(now: number): number {
  return Math.floor(now / TICK_MS);
}

const encoder = new TextEncoder();

/** 32-bit FNV-1a hash over the UTF-8 bytes of `text`. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (const byte of encoder.encode(text)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG. Returns a generator of floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deterministic generator for (seed, key, tick). Use when one draw is not enough. */
export function rngFor(seed: number, key: string, tick: number): () => number {
  return mulberry32(fnv1a(`${seed}|${key}|${tick}`));
}

/** Deterministic float in [0, 1) for (seed, key, tick). */
export function noise(seed: number, key: string, tick: number): number {
  return rngFor(seed, key, tick)();
}
