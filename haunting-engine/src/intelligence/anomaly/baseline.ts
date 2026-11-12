// Pure EWMA baseline functions (R1.1, R1.3 to R1.9). No I/O, no state.
import type { Baseline } from '../intelligence-types';

export type { Baseline } from '../intelligence-types';

export const EMPTY_BASELINE: Baseline = Object.freeze({ mean: 0, variance: 0, count: 0 });

/**
 * Applies one Baseline_Sample. A null or non-finite sample, or a non-finite
 * result, returns the old Baseline unchanged. Never mutates the input.
 */
export function updateBaseline(b: Baseline, sample: number | null, alpha: number): Baseline {
  if (sample === null || !Number.isFinite(sample)) {
    return b;
  }
  if (b.count === 0) {
    return { mean: sample, variance: 0, count: 1 };
  }
  const diff = sample - b.mean;
  const mean = b.mean + alpha * diff;
  const variance = Math.max(0, (1 - alpha) * (b.variance + alpha * diff * diff));
  if (!Number.isFinite(mean) || !Number.isFinite(variance)) {
    return b;
  }
  return { mean, variance, count: b.count + 1 };
}

/** Returns a new value equal to EMPTY_BASELINE regardless of input. */
export function resetBaseline(_b: Baseline): Baseline {
  return { ...EMPTY_BASELINE };
}

/** True while fewer than `warmupPolls` samples have been applied. */
export function isWarmUp(b: Baseline, warmupPolls: number): boolean {
  return b.count < warmupPolls;
}

/** max(sqrt(variance), floor). */
export function effectiveStdDev(b: Baseline, floor: number): number {
  return Math.max(Math.sqrt(b.variance), floor);
}
