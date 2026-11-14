import * as fc from 'fast-check';
import {
  FakeClock,
  NUM_RUNS,
  clientKeyArb,
  gapsArb,
  makeService,
  maxArb,
  requestCountArb,
  windowSecondsArb,
} from './test-support';

describe('ChaosRateLimitService accept count', () => {
  // Feature: haunted-house, Property 33: Exactly min(N, max) requests are accepted
  // **Validates: Requirements 9.1, 9.12**
  it('accepts exactly min(N, max) requests within one window', () => {
    const scenario = fc
      .tuple(maxArb, windowSecondsArb, clientKeyArb, requestCountArb)
      .chain(([max, windowSeconds, key, n]) =>
        gapsArb(n, windowSeconds).map((gaps) => ({ max, windowSeconds, key, gaps })),
      );

    fc.assert(
      fc.property(scenario, ({ max, windowSeconds, key, gaps }) => {
        const clock = new FakeClock();
        const service = makeService(clock, max, windowSeconds);
        let accepted = 0;
        for (const gap of gaps) {
          if (service.reserve(key).ok) {
            accepted++;
          }
          clock.advance(gap);
        }
        expect(accepted).toBe(Math.min(gaps.length, max));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
