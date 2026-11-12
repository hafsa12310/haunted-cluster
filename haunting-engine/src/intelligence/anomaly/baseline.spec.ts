import {
  EMPTY_BASELINE,
  effectiveStdDev,
  isWarmUp,
  resetBaseline,
  updateBaseline,
} from './baseline';

describe('baseline', () => {
  it('first sample seeds the mean', () => {
    expect(updateBaseline(EMPTY_BASELINE, 5, 0.1)).toEqual({ mean: 5, variance: 0, count: 1 });
  });

  it('applies the EWMA rule', () => {
    const next = updateBaseline({ mean: 10, variance: 4, count: 3 }, 20, 0.5);
    expect(next.mean).toBeCloseTo(15);
    expect(next.variance).toBeCloseTo(0.5 * (4 + 0.5 * 100));
    expect(next.count).toBe(4);
  });

  it.each([null, NaN, Infinity, -Infinity])('ignores sample %p', (s) => {
    const b = { mean: 1, variance: 2, count: 3 };
    expect(updateBaseline(b, s, 0.1)).toBe(b);
  });

  it('returns old baseline on non-finite result and does not mutate', () => {
    const b = { mean: Number.MAX_VALUE, variance: 0, count: 2 };
    expect(updateBaseline(b, -Number.MAX_VALUE, 0.5)).toBe(b);
    expect(b).toEqual({ mean: Number.MAX_VALUE, variance: 0, count: 2 });
  });

  it('reset equals EMPTY_BASELINE as a new object', () => {
    const r = resetBaseline({ mean: 1, variance: 1, count: 9 });
    expect(r).toEqual(EMPTY_BASELINE);
    expect(r).not.toBe(EMPTY_BASELINE);
  });

  it('isWarmUp and effectiveStdDev', () => {
    expect(isWarmUp({ mean: 0, variance: 0, count: 4 }, 5)).toBe(true);
    expect(isWarmUp({ mean: 0, variance: 0, count: 5 }, 5)).toBe(false);
    expect(effectiveStdDev({ mean: 0, variance: 16, count: 5 }, 1)).toBe(4);
    expect(effectiveStdDev({ mean: 0, variance: 0, count: 5 }, 1)).toBe(1);
  });
});
