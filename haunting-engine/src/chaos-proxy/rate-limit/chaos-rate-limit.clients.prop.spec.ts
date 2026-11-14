import * as fc from 'fast-check';
import { FakeClock, NUM_RUNS, makeService, maxArb, windowSecondsArb } from './test-support';

describe('ChaosRateLimitService client independence', () => {
  // Feature: haunted-house, Property 35: Clients are limited independently
  // **Validates: Requirements 9.5**
  it('accepts min(count, max) for each key under any interleaving', () => {
    const scenario = fc.record({
      max: maxArb,
      windowSeconds: windowSecondsArb,
      // true = request from client "a", false = client "b"
      order: fc.array(fc.boolean(), { maxLength: 60 }),
    });

    fc.assert(
      fc.property(scenario, ({ max, windowSeconds, order }) => {
        const clock = new FakeClock();
        const service = makeService(clock, max, windowSeconds);
        const gap = Math.floor((windowSeconds * 1000 - 1) / (order.length + 1));
        const accepted = { a: 0, b: 0 };
        const requested = { a: 0, b: 0 };

        for (const isA of order) {
          const key = isA ? 'a' : 'b';
          requested[key]++;
          if (service.reserve(key).ok) {
            accepted[key]++;
          }
          clock.advance(gap);
        }

        expect(accepted.a).toBe(Math.min(requested.a, max));
        expect(accepted.b).toBe(Math.min(requested.b, max));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
