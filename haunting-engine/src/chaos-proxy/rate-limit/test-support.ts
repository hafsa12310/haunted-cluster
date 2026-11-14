/**
 * Test-only helpers for the chaos rate limit property tests.
 * Never imported by production code.
 */

import * as fc from 'fast-check';
import type { Clock } from '../../config/config.module';
import type { EngineConfig } from '../../config/engine-config';
import { ChaosRateLimitService } from './chaos-rate-limit.service';

export const NUM_RUNS = 100;

/** Controllable clock: tests move time by hand. */
export class FakeClock implements Clock {
  constructor(private current = 1_000_000) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export function makeService(
  clock: Clock,
  max: number,
  windowSeconds: number,
): ChaosRateLimitService {
  // The service reads only `chaosRateLimit`, so a partial config is cast.
  const config = { chaosRateLimit: { max, windowSeconds } } as EngineConfig;
  return new ChaosRateLimitService(config, clock);
}

/** Reads the private map; the stored timestamps are only observable there. */
export function timestampsOf(service: ChaosRateLimitService, key: string): number[] | undefined {
  return (service as unknown as { hits: Map<string, number[]> }).hits.get(key);
}

export const maxArb = fc.integer({ min: 1, max: 10 });
export const windowSecondsArb = fc.integer({ min: 10, max: 600 });
export const requestCountArb = fc.integer({ min: 0, max: 40 });
export const clientKeyArb = fc.stringOf(fc.constantFrom('a', 'b', 'c', '1', '2', '.', ':'), {
  minLength: 1,
  maxLength: 8,
});

/** Millisecond gaps between requests; the caller keeps the total inside one window. */
export function gapsArb(count: number, windowSeconds: number): fc.Arbitrary<number[]> {
  const maxGap = Math.max(0, Math.floor((windowSeconds * 1000 - 1) / Math.max(1, count + 1)));
  return fc.array(fc.integer({ min: 0, max: maxGap }), { minLength: count, maxLength: count });
}
