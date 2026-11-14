/**
 * Pure sliding-window helpers for the chaos rate limit.
 * No I/O, no clock reads: the caller passes `nowMs`. Inputs are never mutated.
 */

export interface WindowDecision {
  allowed: boolean;
  /** Whole seconds to wait before retrying; 0 when allowed. */
  retryAfterSeconds: number;
}

function isCounted(t: number, nowMs: number, windowMs: number): boolean {
  return nowMs - t < windowMs;
}

/** Returns the timestamps still inside the window, in their original order. */
export function prune(
  timestamps: readonly number[],
  nowMs: number,
  windowMs: number,
): number[] {
  return timestamps.filter((t) => isCounted(t, nowMs, windowMs));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Decides whether one more request fits in the window ending at `nowMs`. */
export function decide(
  timestamps: readonly number[],
  nowMs: number,
  max: number,
  windowMs: number,
): WindowDecision {
  const counted = prune(timestamps, nowMs, windowMs);
  if (counted.length < max) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  const oldest = Math.min(...counted);
  const maxSeconds = Math.max(1, Math.ceil(windowMs / 1000));
  const waitSeconds = Math.ceil((oldest + windowMs - nowMs) / 1000);
  return {
    allowed: false,
    retryAfterSeconds: clamp(waitSeconds, 1, maxSeconds),
  };
}
