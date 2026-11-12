import * as fc from 'fast-check';
import { parseMemoryGaugeIntervalMs } from './env-validation';

// Feature: engine-intelligence, Property 35: Only positive integers are accepted as a gauge interval
// **Validates: Requirements R15.3, R15.4, R15.5**
describe('parseMemoryGaugeIntervalMs (property)', () => {
  const padding = fc.constantFrom('', ' ', '\t', '  ');

  it('accepts every positive safe integer, with optional surrounding whitespace, and returns it', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        padding,
        padding,
        (n, left, right) => {
          expect(parseMemoryGaugeIntervalMs(`${left}${n}${right}`)).toBe(n);
        },
      ),
      { numRuns: 200 },
    );
  });

  const invalidRaw = fc.oneof(
    // zero and negative integers
    fc.integer({ max: 0 }).map(String),
    // non-integer finite numbers
    fc
      .double({ noNaN: true, noDefaultInfinity: true })
      .filter((d) => !Number.isInteger(d))
      .map(String),
    // integers beyond the safe range
    fc
      .bigInt({ min: BigInt(Number.MAX_SAFE_INTEGER) + 1n, max: 10n ** 30n })
      .map(String),
    // non-numeric words and special numeric literals
    fc.constantFrom('abc', 'NaN', 'Infinity', '-Infinity', '1e3', '0x10', '1_000', '007', ' '),
    // arbitrary non-empty strings that are not plain positive decimals
    fc
      .string({ minLength: 1 })
      .filter((s) => !/^[1-9]\d*$/.test(s.trim())),
  );

  it('rejects every other value with an error naming MEMORY_GAUGE_INTERVAL_MS', () => {
    fc.assert(
      fc.property(invalidRaw, (raw) => {
        expect(() => parseMemoryGaugeIntervalMs(raw)).toThrow(
          /MEMORY_GAUGE_INTERVAL_MS/,
        );
      }),
      { numRuns: 200 },
    );
  });
});
