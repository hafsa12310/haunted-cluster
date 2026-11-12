import * as fc from 'fast-check';
import { fitTrend, RssSample } from './trend-fitter';

const NUM_RUNS = 200;

describe('trend-fitter properties', () => {
  // Feature: engine-intelligence, Property 20: The trend fit recovers an exact line
  // **Validates: Requirements 5.3, 5.8**
  it('Property 20: recovers slope and r2 of an exact line, including epoch-ms timestamps', () => {
    const slopeArb = fc
      .double({ min: 0.01, max: 10, noNaN: true })
      .chain((m) => fc.boolean().map((neg) => (neg ? -m : m)));
    fc.assert(
      fc.property(
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        slopeArb,
        fc.oneof(fc.constant(0), fc.integer({ min: 1.6e12, max: 1.8e12 })),
        fc.array(fc.integer({ min: 500, max: 10_000 }), { minLength: 2, maxLength: 60 }),
        (a, b, base, steps) => {
          const window: RssSample[] = [];
          let t = base;
          for (const step of steps) {
            window.push({ t, mb: a + (b * (t - base)) / 1000 });
            t += step;
          }
          const fit = fitTrend(window, 2);
          expect(fit).not.toBeNull();
          const f = fit as NonNullable<typeof fit>;
          expect(Math.abs(f.slopeMbPerSecond - b)).toBeLessThanOrEqual(1e-6 * Math.abs(b));
          expect(Math.abs(f.r2 - 1)).toBeLessThanOrEqual(1e-6);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 21: Trend fits are well formed
  // **Validates: Requirements 5.4, 5.5, 5.6, 5.7**
  describe('Property 21', () => {
    const sampleArb = fc.record({
      t: fc.integer({ min: 0, max: 2_000_000_000_000 }),
      mb: fc.double({ min: 0, max: 100_000, noNaN: true }),
    });
    const windowArb = fc.array(sampleArb, { minLength: 0, maxLength: 40 });

    it('returns null below minSamples', () => {
      fc.assert(
        fc.property(windowArb, fc.integer({ min: 1, max: 50 }), (window, extra) => {
          expect(fitTrend(window, window.length + extra)).toBeNull();
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('returns null for equal timestamps', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 2_000_000_000_000 }),
          fc.array(fc.double({ min: 0, max: 100_000, noNaN: true }), { minLength: 1, maxLength: 40 }),
          (t, mbs) => {
            const window = mbs.map((mb) => ({ t, mb }));
            expect(fitTrend(window, 2)).toBeNull();
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('returns slope 0 and r2 0 when all RSS values are equal', () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0, max: 100_000, noNaN: true }),
          fc.uniqueArray(fc.integer({ min: 0, max: 2_000_000_000_000 }), { minLength: 2, maxLength: 40 }),
          (mb, ts) => {
            const window = ts.map((t) => ({ t, mb }));
            expect(fitTrend(window, 2)).toEqual({ slopeMbPerSecond: 0, r2: 0 });
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('otherwise returns a finite slope and r2 in [0, 1], without mutating input, deterministically', () => {
      fc.assert(
        fc.property(windowArb, fc.integer({ min: 1, max: 10 }), (window, minSamples) => {
          const before = JSON.stringify(window);
          const first = fitTrend(window, minSamples);
          const second = fitTrend(window, minSamples);
          expect(JSON.stringify(window)).toBe(before);
          expect(second).toEqual(first);

          const distinctTimes = new Set(window.map((s) => s.t)).size;
          if (window.length < minSamples || distinctTimes < 2) {
            expect(first).toBeNull();
            return;
          }
          expect(first).not.toBeNull();
          const f = first as NonNullable<typeof first>;
          expect(Number.isFinite(f.slopeMbPerSecond)).toBe(true);
          expect(f.r2).toBeGreaterThanOrEqual(0);
          expect(f.r2).toBeLessThanOrEqual(1);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
