/**
 * Per-client sliding-window rate limit for `POST /api/chaos/*`.
 *
 * State is in-memory and per process (resets on restart). The window maths lives in
 * the pure `sliding-window.ts`; this service only owns the map and the clock.
 * Requirements: 9.1, 9.5, 9.6, 9.12
 */

import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock, ENGINE_CONFIG } from '../../config/config.module';
import type { EngineConfig } from '../../config/engine-config';
import { decide, prune } from './sliding-window';

/** Once the map holds more keys than this, keys with nothing in the window are swept. */
export const SWEEP_THRESHOLD = 10_000;

/** Proof that one slot was taken for `key` at `timestamp`; pass to `refund`. */
export interface ChaosReservation {
  key: string;
  timestamp: number;
}

export type ReserveResult =
  | { ok: true; reservation: ChaosReservation }
  | { ok: false; retryAfterSeconds: number };

@Injectable()
export class ChaosRateLimitService {
  private readonly hits = new Map<string, number[]>();

  constructor(
    @Inject(ENGINE_CONFIG) private readonly config: EngineConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Takes one slot for `key` if the window has room. A rejection records nothing. */
  reserve(key: string): ReserveResult {
    const now = this.clock.now();
    const { max, windowSeconds } = this.config.chaosRateLimit;
    const windowMs = windowSeconds * 1000;

    const current = prune(this.hits.get(key) ?? [], now, windowMs);
    const decision = decide(current, now, max, windowMs);

    if (!decision.allowed) {
      this.store(key, current);
      return { ok: false, retryAfterSeconds: decision.retryAfterSeconds };
    }

    this.store(key, [...current, now]);
    if (this.hits.size > SWEEP_THRESHOLD) {
      this.sweep(now, windowMs);
    }
    return { ok: true, reservation: { key, timestamp: now } };
  }

  /** Gives back a slot by removing one occurrence of the reserved timestamp. */
  refund(reservation: ChaosReservation): void {
    const timestamps = this.hits.get(reservation.key);
    if (!timestamps) {
      return;
    }
    const index = timestamps.indexOf(reservation.timestamp);
    if (index === -1) {
      return;
    }
    const remaining = [...timestamps.slice(0, index), ...timestamps.slice(index + 1)];
    this.store(reservation.key, remaining);
  }

  /** Writes the array, or deletes the key when it is empty. */
  private store(key: string, timestamps: number[]): void {
    if (timestamps.length === 0) {
      this.hits.delete(key);
    } else {
      this.hits.set(key, timestamps);
    }
  }

  /** Deletes every key with no timestamp inside the window, bounding memory. */
  private sweep(now: number, windowMs: number): void {
    for (const [key, timestamps] of this.hits) {
      if (prune(timestamps, now, windowMs).length === 0) {
        this.hits.delete(key);
      }
    }
  }
}
