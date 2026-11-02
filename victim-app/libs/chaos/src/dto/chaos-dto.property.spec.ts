// Feature: victim-app, Property 8: DTO validation rejects out-of-range chaos inputs

import * as fc from 'fast-check';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SetLatencyDto } from './set-latency.dto';
import { SetErrorRateDto } from './set-error-rate.dto';
import { SetMemoryLeakDto } from './set-memory-leak.dto';

/**
 * Property 8: DTO validation rejects out-of-range chaos inputs
 *
 * Validates: Requirements 3.3, 3.4, 4.3, 4.4
 */

describe('Chaos DTOs — Property 8: DTO validation rejects out-of-range chaos inputs', () => {
  /**
   * SetLatencyDto — out-of-range ms values (< 0 or > 30000) must be rejected.
   * Validates: Requirements 3.3, 3.4
   */
  it('Property 8a — SetLatencyDto rejects ms values outside [0, 30000]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer().filter((n) => n < 0 || n > 30000),
        async (ms) => {
          const dto = plainToInstance(SetLatencyDto, { ms });
          const errors = await validate(dto);
          expect(errors.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * SetLatencyDto — valid ms values in [0, 30000] must pass validation.
   * Validates: Requirement 3.3
   */
  it('Property 8b — SetLatencyDto accepts ms values inside [0, 30000]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 30000 }),
        async (ms) => {
          const dto = plainToInstance(SetLatencyDto, { ms });
          const errors = await validate(dto);
          expect(errors).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * SetErrorRateDto — out-of-range percentage values (< 0 or > 100) must be rejected.
   * Validates: Requirements 4.3, 4.4
   */
  it('Property 8c — SetErrorRateDto rejects percentage values outside [0, 100]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.float().filter((n) => n < 0 || n > 100),
        async (percentage) => {
          const dto = plainToInstance(SetErrorRateDto, { percentage });
          const errors = await validate(dto);
          expect(errors.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * SetErrorRateDto — valid percentage values in [0, 100] must pass validation.
   * Validates: Requirement 4.3
   */
  it('Property 8d — SetErrorRateDto accepts percentage values inside [0, 100]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.float({ min: 0, max: 100, noNaN: true }),
        async (percentage) => {
          const dto = plainToInstance(SetErrorRateDto, { percentage });
          const errors = await validate(dto);
          expect(errors).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * SetMemoryLeakDto — boolean enabled values (true/false) must pass validation.
   * Validates: Requirement 3.4 (memory leak control)
   */
  it('Property 8e — SetMemoryLeakDto accepts boolean enabled values', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        async (enabled) => {
          const dto = plainToInstance(SetMemoryLeakDto, { enabled });
          const errors = await validate(dto);
          expect(errors).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
