import * as fc from 'fast-check';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SetErrorRateDto } from './set-error-rate.dto';
import { SetLatencyDto } from './set-latency.dto';
import { SetMemoryLeakDto } from './set-memory-leak.dto';

const NUM_RUNS = 200;

/** Validation errors for `body`, the same way the victim-app's Property 8 checks them. */
async function errorsFor<T extends object>(dto: new () => T, body: object) {
  return validate(plainToInstance(dto, body));
}

/** Any value that isn't a number, including a missing field. */
const notANumberArb = fc.oneof(
  fc.anything().filter((v) => typeof v !== 'number'),
  fc.constantFrom(undefined, null, '', '0', '100', 'NaN', true, false, [], {}),
);

/** Any value that isn't a boolean, including look-alikes such as "true" and 1. */
const notABooleanArb = fc.oneof(
  fc.anything().filter((v) => typeof v !== 'boolean'),
  fc.constantFrom(undefined, null, 'true', 'false', 1, 0, '', [], {}),
);

describe('Chaos proxy DTOs — property-based tests (Property 11)', () => {
  describe('SetLatencyDto', () => {
    // Feature: haunting-engine, Property 11: Chaos proxy DTOs reject out-of-range input
    it('Property 11: accepts every integer ms in [0, 30000]', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 0, max: 30000 }), async (ms) => {
          expect(await errorsFor(SetLatencyDto, { ms })).toHaveLength(0);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    // Feature: haunting-engine, Property 11: Chaos proxy DTOs reject out-of-range input
    it('Property 11: rejects integers outside [0, 30000]', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(fc.integer({ max: -1 }), fc.integer({ min: 30001 }), fc.constantFrom(-1, 30001)),
          async (ms) => {
            expect((await errorsFor(SetLatencyDto, { ms })).length).toBeGreaterThan(0);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    // Feature: haunting-engine, Property 11: Chaos proxy DTOs reject out-of-range input
    it('Property 11: rejects non-integer numbers, NaN and ±Infinity, even inside the range', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.double({ min: 0, max: 30000, noNaN: true }).filter((n) => !Number.isInteger(n)),
            fc.double().filter((n) => !Number.isInteger(n)),
            fc.constantFrom(0.5, 29999.9, Number.NaN, Infinity, -Infinity),
          ),
          async (ms) => {
            expect((await errorsFor(SetLatencyDto, { ms })).length).toBeGreaterThan(0);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    // Feature: haunting-engine, Property 11: Chaos proxy DTOs reject out-of-range input
    it('Property 11: rejects ms that is not a number, or missing', async () => {
      await fc.assert(
        fc.asyncProperty(notANumberArb, async (ms) => {
          expect((await errorsFor(SetLatencyDto, { ms })).length).toBeGreaterThan(0);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('SetErrorRateDto', () => {
    // Feature: haunting-engine, Property 11: Chaos proxy DTOs reject out-of-range input
    it('Property 11: accepts every number in [0, 100], fractions included', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(fc.double({ min: 0, max: 100, noNaN: true }), fc.constantFrom(0, 0.01, 50, 99.99, 100)),
          async (percentage) => {
            expect(await errorsFor(SetErrorRateDto, { percentage })).toHaveLength(0);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    // Feature: haunting-engine, Property 11: Chaos proxy DTOs reject out-of-range input
    it('Property 11: rejects numbers outside [0, 100], NaN and ±Infinity', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.double({ noNaN: true }).filter((n) => n < 0 || n > 100),
            fc.constantFrom(-0.01, 100.01, Number.NaN, Infinity, -Infinity),
          ),
          async (percentage) => {
            expect((await errorsFor(SetErrorRateDto, { percentage })).length).toBeGreaterThan(0);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    // Feature: haunting-engine, Property 11: Chaos proxy DTOs reject out-of-range input
    it('Property 11: rejects percentage that is not a number, or missing', async () => {
      await fc.assert(
        fc.asyncProperty(notANumberArb, async (percentage) => {
          expect((await errorsFor(SetErrorRateDto, { percentage })).length).toBeGreaterThan(0);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('SetMemoryLeakDto', () => {
    // Feature: haunting-engine, Property 11: Chaos proxy DTOs reject out-of-range input
    it('Property 11: accepts true and false', async () => {
      await fc.assert(
        fc.asyncProperty(fc.boolean(), async (enabled) => {
          expect(await errorsFor(SetMemoryLeakDto, { enabled })).toHaveLength(0);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    // Feature: haunting-engine, Property 11: Chaos proxy DTOs reject out-of-range input
    it('Property 11: rejects enabled that is not a boolean, or missing', async () => {
      await fc.assert(
        fc.asyncProperty(notABooleanArb, async (enabled) => {
          expect((await errorsFor(SetMemoryLeakDto, { enabled })).length).toBeGreaterThan(0);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
