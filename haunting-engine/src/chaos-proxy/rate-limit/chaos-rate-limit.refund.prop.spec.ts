import * as fc from 'fast-check';
import {
  FakeClock,
  NUM_RUNS,
  makeService,
  maxArb,
  timestampsOf,
  windowSecondsArb,
} from './test-support';

describe('ChaosRateLimitService refunds', () => {
  // Feature: haunted-house, Property 36: Invalid requests do not use up the allowance
  // **Validates: Requirements 9.13, 15.4**
  it('accepts min(valid count, max) valid requests and restores state on each refund', () => {
    const scenario = fc.record({
      max: maxArb,
      windowSeconds: windowSecondsArb,
      // true = valid request, false = invalid (reserved, then refunded)
      validity: fc.array(fc.boolean(), { maxLength: 60 }),
    });

    fc.assert(
      fc.property(scenario, ({ max, windowSeconds, validity }) => {
        const clock = new FakeClock();
        const service = makeService(clock, max, windowSeconds);
        const gap = Math.floor((windowSeconds * 1000 - 1) / (validity.length + 1));
        const key = 'client';
        let acceptedValid = 0;

        for (const valid of validity) {
          const before = [...(timestampsOf(service, key) ?? [])];
          const result = service.reserve(key);
          if (result.ok) {
            if (valid) {
              acceptedValid++;
            } else {
              service.refund(result.reservation);
              expect(timestampsOf(service, key) ?? []).toEqual(before);
            }
          }
          clock.advance(gap);
        }

        const validCount = validity.filter(Boolean).length;
        expect(acceptedValid).toBe(Math.min(validCount, max));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
