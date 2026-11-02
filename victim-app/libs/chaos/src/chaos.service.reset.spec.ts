// Feature: victim-app, Property 6: chaos reset clears all state and frees leak memory

import * as fc from 'fast-check';
import { ChaosService } from './chaos.service';

/**
 * Property 6: Chaos reset clears all state and frees leak memory
 *
 * For any combination of active chaos settings (latency, error rate, memory
 * leak simultaneously enabled), calling chaosService.reset() SHALL result in
 * a ChaosState where:
 *   - latencyMs === 0
 *   - errorRatePercent === 0
 *   - memoryLeakEnabled === false
 *   - _leakArray has length 0
 *
 * Validates: Requirements 7.1
 */

describe('ChaosService — Property 6: chaos reset clears all state and frees leak memory', () => {
  let service: ChaosService;

  beforeEach(() => {
    jest.useFakeTimers();
    service = new ChaosService();
  });

  afterEach(() => {
    // Destroy the service to clear all internal timers before switching back
    // to real timers, avoiding open handle warnings.
    service.onModuleDestroy();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it(
    'Property 6: reset() zeroes all chaos state fields and clears the leak array ' +
      'for any arbitrary combination of active chaos settings',
    () => {
      fc.assert(
        fc.property(
          fc.record({
            latencyMs: fc.integer({ min: 1, max: 30000 }),
            errorRatePercent: fc.float({ min: 0, max: 100, noNaN: true }),
            memoryLeakEnabled: fc.boolean(),
          }),
          ({ latencyMs, errorRatePercent, memoryLeakEnabled }) => {
            // Apply all three chaos settings to a fresh service instance.
            service.setLatency(latencyMs);
            service.setErrorRate(errorRatePercent);

            if (memoryLeakEnabled) {
              // enableMemoryLeak sets up a setInterval; with fake timers the
              // interval never fires, but state.memoryLeakEnabled is set to true
              // and internal timers are registered.
              service.enableMemoryLeak();
            }

            // Precondition: at least latency was applied.
            expect(service.state.latencyMs).toBe(latencyMs);
            expect(service.state.errorRatePercent).toBe(errorRatePercent);
            expect(service.state.memoryLeakEnabled).toBe(memoryLeakEnabled);

            // ── Act ────────────────────────────────────────────────────────
            service.reset();

            // ── Assert ─────────────────────────────────────────────────────
            expect(service.state.latencyMs).toBe(0);
            expect(service.state.errorRatePercent).toBe(0);
            expect(service.state.memoryLeakEnabled).toBe(false);
            expect(service.state._leakArray).toHaveLength(0);

            // All TTL timers must also be cleared after reset.
            expect(service.state._latencyTimer).toBeNull();
            expect(service.state._errorRateTimer).toBeNull();
            expect(service.state._leakTimer).toBeNull();

            // Expiry timestamps must be nulled.
            expect(service.state.latencyExpiresAt).toBeNull();
            expect(service.state.errorRateExpiresAt).toBeNull();
            expect(service.state.memoryLeakExpiresAt).toBeNull();
            expect(service.state.memoryLeakRetainedMb).toBe(0);

            // Reset service state for the next iteration so each run is
            // independent — the same service instance is reused across
            // iterations within one `it` block.
            service.reset();
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it('Property 6 (leak array growth): reset() frees memory retained by the leak timer', () => {
    // Manually push data into the leak array to simulate what the interval
    // would have done in real time, then verify reset clears it.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        (chunkCount) => {
          service.enableMemoryLeak();

          // Simulate retained memory by pushing items directly into the array
          // (the setInterval doesn't fire because we're using fake timers).
          for (let i = 0; i < chunkCount; i++) {
            (service.state._leakArray as unknown[]).push('x'.repeat(1024));
          }
          expect(service.state._leakArray.length).toBe(chunkCount);

          service.reset();

          expect(service.state._leakArray).toHaveLength(0);
          expect(service.state.memoryLeakEnabled).toBe(false);
          expect(service.state.memoryLeakRetainedMb).toBe(0);

          // Clean up for next iteration.
          service.reset();
        },
      ),
      { numRuns: 100 },
    );
  });
});
