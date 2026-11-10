import type { Parameters } from "fast-check";

/** Minimum number of runs for every property test in this repo. */
export const PBT_MIN_RUNS = 100;

/** Shared fast-check parameters: `fc.assert(prop, pbtParams)`. */
export const pbtParams: Parameters<unknown> = { numRuns: PBT_MIN_RUNS };

/**
 * Shared parameters with per-test overrides. `numRuns` never drops below PBT_MIN_RUNS.
 * Example: `fc.assert(prop, pbt({ numRuns: 200, seed: 42 }))`.
 */
export function pbt<T = unknown>(overrides: Parameters<T> = {}): Parameters<T> {
  return {
    ...overrides,
    numRuns: Math.max(PBT_MIN_RUNS, overrides.numRuns ?? PBT_MIN_RUNS),
  };
}
