import * as fc from 'fast-check';
import { Baseline, resetBaseline, updateBaseline } from './baseline';

const NUM_RUNS = 100;

// Bounded so intermediate results cannot overflow to Infinity.
const finiteNum = fc.double({ min: -1e6, max: 1e6, noNaN: true });
const alphaArb = fc.double({ min: 1e-6, max: 1, noNaN: true });
const baselineArb: fc.Arbitrary<Baseline> = fc.record({
  mean: finiteNum,
  variance: fc.double({ min: 0, max: 1e6, noNaN: true }),
  count: fc.integer({ min: 0, max: 100000 }),
});
const nonFiniteArb = fc.constantFrom<number | null>(null, NaN, Infinity, -Infinity);

function deepFreeze<T extends object>(o: T): T {
  Object.values(o).forEach((v) => {
    if (v && typeof v === 'object') deepFreeze(v);
  });
  return Object.freeze(o);
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

describe('baseline properties', () => {
  // Feature: engine-intelligence, Property 2: Baseline update rule and invariants
  // **Validates: Requirements 1.3, 1.4, 1.5, 1.6, 1.7**
  it('Property 2: follows the EWMA update rule and keeps invariants', () => {
    fc.assert(
      fc.property(baselineArb, finiteNum, alphaArb, (b, x, alpha) => {
        const snapshot = { ...b };
        const frozen = deepFreeze({ ...b });
        const r = updateBaseline(frozen, x, alpha);

        expect(frozen).toEqual(snapshot);
        expect(updateBaseline(frozen, x, alpha)).toEqual(r);
        expect(r.count).toBe(b.count + 1);
        expect(Number.isFinite(r.mean)).toBe(true);
        expect(Number.isFinite(r.variance)).toBe(true);
        expect(r.variance).toBeGreaterThanOrEqual(0);

        if (b.count === 0) {
          expect(r).toEqual({ mean: x, variance: 0, count: 1 });
        } else {
          const diff = x - b.mean;
          expect(close(r.mean, b.mean + alpha * diff)).toBe(true);
          expect(close(r.variance, (1 - alpha) * (b.variance + alpha * diff * diff))).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 3: Non-finite samples change nothing
  // **Validates: Requirements 1.8**
  it('Property 3: non-finite samples return the Baseline unchanged', () => {
    fc.assert(
      fc.property(baselineArb, nonFiniteArb, alphaArb, (b, x, alpha) => {
        const frozen = deepFreeze({ ...b });
        expect(updateBaseline(frozen, x, alpha)).toEqual(b);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 4: Reset behaves like a fresh baseline
  // **Validates: Requirements 1.9**
  it('Property 4: resetBaseline yields an empty Baseline and the next sample acts as the first', () => {
    fc.assert(
      fc.property(baselineArb, finiteNum, alphaArb, (b, x, alpha) => {
        const reset = resetBaseline(b);
        expect(reset).toEqual({ mean: 0, variance: 0, count: 0 });
        expect(updateBaseline(reset, x, alpha)).toEqual({ mean: x, variance: 0, count: 1 });
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
