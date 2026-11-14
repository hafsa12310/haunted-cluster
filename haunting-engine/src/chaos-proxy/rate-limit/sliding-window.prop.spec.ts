import * as fc from 'fast-check';
import { decide, prune } from './sliding-window';

// Feature: haunted-house, Property 34: Retry-After is a whole number inside the window
// **Validates: Requirements 9.2, 9.3**

const NUM_RUNS = 100;

/** Window lengths: whole-second multiples, or arbitrary milliseconds. */
const windowMsArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 1, max: 120 }).map((s) => s * 1000),
  fc.integer({ min: 1, max: 120_000 }),
);

interface Scenario {
  max: number;
  windowMs: number;
  nowMs: number;
  timestamps: number[];
}

/** Timestamps are spread around `nowMs`, both inside and outside the window. */
const scenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    max: fc.integer({ min: 1, max: 20 }),
    windowMs: windowMsArb,
    nowMs: fc.integer({ min: 1_000_000, max: 2_000_000_000 }),
  })
  .chain(({ max, windowMs, nowMs }) =>
    fc
      .array(fc.integer({ min: 0, max: windowMs * 2 }), { maxLength: 40 })
      .map((ages) => ({
        max,
        windowMs,
        nowMs,
        timestamps: ages.map((age) => nowMs - age),
      })),
  );

describe('Property 34: Retry-After is a whole number inside the window', () => {
  it('reports an integer in [1, windowSeconds] when blocked, 0 when allowed, without mutating inputs', () => {
    fc.assert(
      fc.property(scenarioArb, ({ max, windowMs, nowMs, timestamps }) => {
        const before = [...timestamps];
        const decision = decide(timestamps, nowMs, max, windowMs);

        expect(timestamps).toEqual(before);

        const counted = prune(timestamps, nowMs, windowMs).length;
        expect(decision.allowed).toBe(counted < max);

        if (decision.allowed) {
          expect(decision.retryAfterSeconds).toBe(0);
        } else {
          const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));
          expect(Number.isInteger(decision.retryAfterSeconds)).toBe(true);
          expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
          expect(decision.retryAfterSeconds).toBeLessThanOrEqual(windowSeconds);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
