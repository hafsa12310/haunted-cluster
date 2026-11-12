// Pure least-squares trend fit over an RSS window. No I/O, no mutation (R9.1, R9.2).
import type { RssSample } from '../intelligence-types';

export type { RssSample } from '../intelligence-types';

export interface TrendFit {
  readonly slopeMbPerSecond: number;
  readonly r2: number;
}

/**
 * Fits mb = a + slope * seconds through the window.
 * Returns null for fewer than minSamples samples, equal timestamps, or a
 * non-finite slope or R2 (R5.4, R5.6, R5.7).
 *
 * Seconds are relative to the first sample and both axes are centered before
 * summing, so epoch-ms timestamps stay accurate (R5.8).
 */
export function fitTrend(window: readonly RssSample[], minSamples: number): TrendFit | null {
  const n = window.length;
  if (n < minSamples || n < 2) {
    return null;
  }

  const t0 = window[0].t;
  let sumX = 0;
  let sumY = 0;
  for (const s of window) {
    sumX += (s.t - t0) / 1000;
    sumY += s.mb;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const s of window) {
    const dx = (s.t - t0) / 1000 - meanX;
    const dy = s.mb - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  if (!(sxx > 0)) {
    return null;
  }
  // Compare raw values: meanY = sumY / n is not exactly the repeated value, so syy can be tiny but nonzero.
  if (syy === 0 || window.every((s) => s.mb === window[0].mb)) {
    return { slopeMbPerSecond: 0, r2: 0 };
  }

  const slope = sxy / sxx;
  const r2raw = (sxy * sxy) / (sxx * syy);
  if (!Number.isFinite(slope) || !Number.isFinite(r2raw)) {
    return null;
  }
  const r2 = Math.min(1, Math.max(0, r2raw));
  return { slopeMbPerSecond: slope, r2 };
}
