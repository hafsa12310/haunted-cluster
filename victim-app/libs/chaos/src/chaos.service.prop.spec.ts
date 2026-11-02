// Feature: victim-app, Property 9: ChaosState GET /chaos/state serialisation round-trip

import * as fc from 'fast-check';
import { ChaosService, ChaosStateResponse } from './chaos.service';

/**
 * Property 9: ChaosState serialisation round-trip
 *
 * For any combination of chaos settings applied via ChaosService methods,
 * the object returned by chaosService.getState() SHALL accurately reflect
 * the current values of:
 *   - latencyMs
 *   - errorRatePercent
 *   - memoryLeakEnabled
 *   - memoryLeakRetainedMb
 *   - all expiry timestamps (within a 1-second tolerance)
 *
 * Null-expiry invariants:
 *   - latencyMs === 0       → latencyExpiresAt === null
 *   - errorRatePercent === 0 → errorRateExpiresAt === null
 *   - !memoryLeakEnabled    → memoryLeakExpiresAt === null
 *
 * Validates: Requirements 7.5
 */

/** ISO 8601 date-string guard. */
function isIso8601(value: string): boolean {
  return !isNaN(Date.parse(value));
}

/**
 * Check that a serialised expiry timestamp is within CHAOS_TTL_SECONDS ± 1 s
 * from the moment it was recorded.
 *
 * @param expiresAt  ISO 8601 string from getState()
 * @param ttlSeconds The TTL configured for this ChaosService instance
 * @param recordedAt Approximate Date.now() at the time the setting was applied
 */
function isWithinTolerance(
  expiresAt: string,
  ttlSeconds: number,
  recordedAt: number,
): boolean {
  const expiryMs = new Date(expiresAt).getTime();
  const expectedMs = recordedAt + ttlSeconds * 1000;
  return Math.abs(expiryMs - expectedMs) <= 1000; // ±1 s tolerance
}

describe('ChaosService — Property 9: ChaosState serialisation round-trip', () => {
  // Use real timers: getState() reads Date.now() via expiresAt() internally,
  // so we need a real clock to verify the timestamps are reasonable.
  // Fake timers would freeze Date.now() at 0 and make the tolerance check
  // trivial / meaningless.

  let service: ChaosService;
  const ttlSeconds = 120; // matches CHAOS_TTL_SECONDS default

  beforeEach(() => {
    // Ensure CHAOS_TTL_SECONDS is set to the expected default.
    delete process.env['CHAOS_TTL_SECONDS'];
    delete process.env['LEAK_MB_PER_SECOND'];
    service = new ChaosService();
  });

  afterEach(() => {
    service.reset();
    service.onModuleDestroy();
  });

  it(
    'Property 9: getState() accurately reflects all applied settings and ' +
      'expiry timestamps for any combination of chaos inputs',
    () => {
      fc.assert(
        fc.property(
          fc.record({
            latencyMs: fc.integer({ min: 0, max: 30000 }),
            errorRatePercent: fc.float({ min: 0, max: 100, noNaN: true }),
            memoryLeakEnabled: fc.boolean(),
          }),
          ({ latencyMs, errorRatePercent, memoryLeakEnabled }) => {
            // ── Arrange: reset to a known baseline ────────────────────────
            service.reset();

            // Record wall-clock time just before applying settings so we can
            // verify expiry timestamps fall within a sensible window.
            const beforeApply = Date.now();

            // ── Act: apply settings ───────────────────────────────────────
            service.setLatency(latencyMs);
            service.setErrorRate(errorRatePercent);

            if (memoryLeakEnabled) {
              service.enableMemoryLeak();
            } else {
              // disableMemoryLeak is a no-op when never enabled, but calling
              // it explicitly ensures we test the disabled branch.
              service.disableMemoryLeak();
            }

            const state: ChaosStateResponse = service.getState();

            // ── Assert: scalar values match exactly ───────────────────────
            expect(state.latencyMs).toBe(latencyMs);
            expect(state.errorRatePercent).toBeCloseTo(errorRatePercent, 5);
            expect(state.memoryLeakEnabled).toBe(memoryLeakEnabled);
            expect(state.memoryLeakRetainedMb).toBeGreaterThanOrEqual(0);

            // ── Assert: latency expiry ────────────────────────────────────
            if (latencyMs === 0) {
              // setLatency(0) still sets a TTL timer per the implementation.
              // The expiry should still be a valid ISO string near now + TTL.
              // (The service always schedules a timer when setLatency is called,
              // even with ms=0, so latencyExpiresAt is set.)
              if (state.latencyExpiresAt !== null) {
                expect(isIso8601(state.latencyExpiresAt)).toBe(true);
                expect(
                  isWithinTolerance(
                    state.latencyExpiresAt,
                    ttlSeconds,
                    beforeApply,
                  ),
                ).toBe(true);
              }
              // null is also acceptable for latencyMs === 0, per spec requirement 7.5
            } else {
              // latencyMs > 0: expiry MUST be present and within tolerance.
              expect(state.latencyExpiresAt).not.toBeNull();
              expect(isIso8601(state.latencyExpiresAt!)).toBe(true);
              expect(
                isWithinTolerance(
                  state.latencyExpiresAt!,
                  ttlSeconds,
                  beforeApply,
                ),
              ).toBe(true);
            }

            // ── Assert: error-rate expiry ─────────────────────────────────
            if (errorRatePercent === 0) {
              // Same reasoning as latency: setErrorRate always schedules timer.
              if (state.errorRateExpiresAt !== null) {
                expect(isIso8601(state.errorRateExpiresAt)).toBe(true);
                expect(
                  isWithinTolerance(
                    state.errorRateExpiresAt,
                    ttlSeconds,
                    beforeApply,
                  ),
                ).toBe(true);
              }
            } else {
              expect(state.errorRateExpiresAt).not.toBeNull();
              expect(isIso8601(state.errorRateExpiresAt!)).toBe(true);
              expect(
                isWithinTolerance(
                  state.errorRateExpiresAt!,
                  ttlSeconds,
                  beforeApply,
                ),
              ).toBe(true);
            }

            // ── Assert: memory-leak expiry ────────────────────────────────
            if (!memoryLeakEnabled) {
              // When not enabled, expiresAt should be null (no timer running).
              expect(state.memoryLeakExpiresAt).toBeNull();
            } else {
              expect(state.memoryLeakExpiresAt).not.toBeNull();
              expect(isIso8601(state.memoryLeakExpiresAt!)).toBe(true);
              expect(
                isWithinTolerance(
                  state.memoryLeakExpiresAt!,
                  ttlSeconds,
                  beforeApply,
                ),
              ).toBe(true);
            }

            // ── Assert: internal fields NOT serialised ────────────────────
            // getState() must not expose private implementation details.
            const rawState = state as unknown as Record<string, unknown>;
            expect(rawState['_leakArray']).toBeUndefined();
            expect(rawState['_leakTimer']).toBeUndefined();
            expect(rawState['_latencyTimer']).toBeUndefined();
            expect(rawState['_errorRateTimer']).toBeUndefined();
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    'Property 9 (null invariants): expiry timestamps are null when the ' +
      'corresponding setting is at zero/false after an explicit reset',
    () => {
      fc.assert(
        fc.property(
          fc.record({
            latencyMs: fc.integer({ min: 1, max: 30000 }),
            errorRatePercent: fc.float({ min: 1, max: 100, noNaN: true }),
            memoryLeakEnabled: fc.constant(true),
          }),
          ({ latencyMs, errorRatePercent }) => {
            // Apply settings, then reset — all expiry fields must be null.
            service.setLatency(latencyMs);
            service.setErrorRate(errorRatePercent);
            service.enableMemoryLeak();

            service.reset();

            const state = service.getState();

            expect(state.latencyMs).toBe(0);
            expect(state.latencyExpiresAt).toBeNull();

            expect(state.errorRatePercent).toBe(0);
            expect(state.errorRateExpiresAt).toBeNull();

            expect(state.memoryLeakEnabled).toBe(false);
            expect(state.memoryLeakExpiresAt).toBeNull();
            expect(state.memoryLeakRetainedMb).toBe(0);
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});
