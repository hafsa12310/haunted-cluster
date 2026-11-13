/**
 * Unit tests for ChaosService
 *
 * Covers state transitions, TTL timer scheduling, reset behaviour,
 * memory-leak TTL expiry, getState() snapshot accuracy, and crash().
 *
 * Requirements: 3.1, 3.2, 4.1, 4.2, 5.1, 5.2, 5.3, 5.4, 7.1, 7.4, 7.5
 */

import { ChaosService } from './chaos.service';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Re-creates ChaosService after setting env vars so the constructor picks them up. */
function makeService(
  ttlSeconds = 2,
  leakMbPerSecond = 1,
): ChaosService {
  process.env['CHAOS_TTL_SECONDS'] = String(ttlSeconds);
  process.env['LEAK_MB_PER_SECOND'] = String(leakMbPerSecond);
  return new ChaosService();
}

/**
 * Make a service with a long TTL so TTL timers never fire during the short
 * fake-timer advances used by leak-growth tests.
 */
function makeServiceLongTtl(leakMbPerSecond = 1): ChaosService {
  return makeService(/* ttlSeconds */ 60, leakMbPerSecond);
}

// ── Test suite ─────────────────────────────────────────────────────────────

describe('ChaosService unit tests', () => {
  let service: ChaosService;

  beforeEach(() => {
    jest.useFakeTimers();
    service = makeService(/* ttlSeconds */ 2, /* leakMbPerSecond */ 1);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.clearAllTimers();
    jest.useRealTimers();
    delete process.env['CHAOS_TTL_SECONDS'];
    delete process.env['LEAK_MB_PER_SECOND'];
  });

  // ── 1. setLatency state transitions ───────────────────────────────────────

  describe('setLatency()', () => {
    it('sets state.latencyMs to the supplied value (Requirements: 3.1)', () => {
      service.setLatency(500);
      expect(service.state.latencyMs).toBe(500);
    });

    it('updates state.latencyMs when called with 0 (Requirements: 3.1)', () => {
      service.setLatency(500);
      service.setLatency(0);
      expect(service.state.latencyMs).toBe(0);
    });

    it('sets latencyExpiresAt to a future Date (Requirements: 7.4)', () => {
      service.setLatency(300);
      expect(service.state.latencyExpiresAt).not.toBeNull();
      // With fake timers Date.now() is frozen, so expiresAt must equal
      // Date.now() + ttlSeconds * 1000.
      const expectedMs = Date.now() + 2 * 1000;
      expect(service.state.latencyExpiresAt!.getTime()).toBe(expectedMs);
    });

    // ── 2. setLatency TTL timer ────────────────────────────────────────────

    it('resets latencyMs to 0 after the TTL expires (Requirements: 3.2, 7.4)', () => {
      service.setLatency(800);
      expect(service.state.latencyMs).toBe(800);

      // Advance time past the TTL (2 s).
      jest.advanceTimersByTime(2000);

      expect(service.state.latencyMs).toBe(0);
      expect(service.state.latencyExpiresAt).toBeNull();
    });

    // ── 3. setLatency restart timer ───────────────────────────────────────

    it('cancels the previous TTL and restarts it when called again (Requirements: 3.2)', () => {
      service.setLatency(200);
      // 1.5 s into the first TTL — should NOT have expired yet.
      jest.advanceTimersByTime(1500);
      expect(service.state.latencyMs).toBe(200);

      // Restart with a new value.
      service.setLatency(400);
      expect(service.state.latencyMs).toBe(400);

      // Another 1.5 s — still within the second TTL window.
      jest.advanceTimersByTime(1500);
      expect(service.state.latencyMs).toBe(400);

      // Now the second TTL fully expires.
      jest.advanceTimersByTime(500);
      expect(service.state.latencyMs).toBe(0);
    });
  });

  // ── 4. setErrorRate state transitions ─────────────────────────────────────

  describe('setErrorRate()', () => {
    it('sets state.errorRatePercent to the supplied value (Requirements: 4.1)', () => {
      service.setErrorRate(50);
      expect(service.state.errorRatePercent).toBe(50);
    });

    it('sets errorRateExpiresAt to a future Date (Requirements: 7.4)', () => {
      service.setErrorRate(25);
      expect(service.state.errorRateExpiresAt).not.toBeNull();
      const expectedMs = Date.now() + 2 * 1000;
      expect(service.state.errorRateExpiresAt!.getTime()).toBe(expectedMs);
    });

    // ── 5. setErrorRate TTL timer ─────────────────────────────────────────

    it('resets errorRatePercent to 0 after the TTL expires (Requirements: 4.2, 7.4)', () => {
      service.setErrorRate(75);
      jest.advanceTimersByTime(2000);
      expect(service.state.errorRatePercent).toBe(0);
      expect(service.state.errorRateExpiresAt).toBeNull();
    });
  });

  // ── 6 & 7. enableMemoryLeak ───────────────────────────────────────────────

  describe('enableMemoryLeak()', () => {
    it('sets memoryLeakEnabled to true and schedules the leak interval (Requirements: 5.1)', () => {
      service.enableMemoryLeak();
      expect(service.state.memoryLeakEnabled).toBe(true);
      expect(service.state._leakTimer).not.toBeNull();
    });

    it('grows _leakArray by LEAK_MB_PER_SECOND entries every second (Requirements: 5.3)', () => {
      // Use a long TTL (60 s) so the TTL timer never fires during this test.
      const svc = makeServiceLongTtl(/* leakMbPerSecond */ 1);

      svc.enableMemoryLeak();

      // After 1 s the interval should have fired once → 1 entry pushed.
      jest.advanceTimersByTime(1000);
      expect(svc.state._leakArray.length).toBe(1);

      // After another 2 s → 3 entries total.
      jest.advanceTimersByTime(2000);
      expect(svc.state._leakArray.length).toBe(3);

      svc.onModuleDestroy();
    });

    it('increments memoryLeakRetainedMb in step with the leak interval (Requirements: 5.3)', () => {
      const svc = makeServiceLongTtl(/* leakMbPerSecond */ 1);

      svc.enableMemoryLeak();
      jest.advanceTimersByTime(3000);
      // leakMbPerSecond = 1, 3 ticks → 3 MB
      expect(svc.state.memoryLeakRetainedMb).toBe(3);

      svc.onModuleDestroy();
    });

    // ── 7. Memory leak TTL expiry ─────────────────────────────────────────

    it('stops the leak timer AND frees _leakArray when TTL expires (Requirements: 5.2)', () => {
      service.enableMemoryLeak();

      // Let the leak grow for 1 s before TTL fires.
      jest.advanceTimersByTime(1000);
      expect(service.state._leakArray.length).toBeGreaterThan(0);

      // Advance past the 2 s TTL.
      jest.advanceTimersByTime(1000);

      expect(service.state._leakArray).toHaveLength(0);
      expect(service.state.memoryLeakEnabled).toBe(false);
      expect(service.state.memoryLeakRetainedMb).toBe(0);
      expect(service.state.memoryLeakExpiresAt).toBeNull();
      expect(service.state._leakTimer).toBeNull();
    });

    it('is idempotent: calling enableMemoryLeak twice resets the interval cleanly', () => {
      service.enableMemoryLeak();
      jest.advanceTimersByTime(1000);
      // 1 entry should be there.
      expect(service.state._leakArray.length).toBe(1);

      // Call again — should restart interval without doubling up.
      service.enableMemoryLeak();
      jest.advanceTimersByTime(1000);
      // Exactly 1 more entry since the second enable (not 2).
      expect(service.state._leakArray.length).toBe(2);
    });
  });

  // ── Real memory growth ────────────────────────────────────────────────────

  describe('enableMemoryLeak() real memory growth', () => {
    const ONE_MB_BYTES = 1_048_576;
    // Large enough that pages freed by earlier tests and reused by the allocator
    // cannot account for more than half of the nominal growth.
    const LEAK_MB_PER_SECOND = 40;
    const TICKS = 3;
    let leakService: ChaosService;

    beforeEach(() => {
      // Real timers: RSS growth only happens when the interval really fires.
      jest.useRealTimers();
      leakService = makeServiceLongTtl(LEAK_MB_PER_SECOND);
    });

    afterEach(() => {
      // Free the retained Buffers and clear every timer.
      leakService.reset();
      leakService.onModuleDestroy();
    });

    it('pushes 1 MiB Buffers and grows RSS by at least half the nominal amount (Requirements: 15.8, 15.10)', async () => {
      const rssBefore = process.memoryUsage().rss;

      leakService.enableMemoryLeak();
      // Wait for about 3 ticks (1 s each), with margin so the 3rd tick has run.
      await new Promise<void>((resolve) => setTimeout(resolve, TICKS * 1000 + 300));

      const entries = leakService.state._leakArray;
      expect(entries.length).toBeGreaterThanOrEqual(TICKS * LEAK_MB_PER_SECOND);
      for (const entry of entries) {
        expect(Buffer.isBuffer(entry)).toBe(true);
        expect((entry as Buffer).length).toBe(ONE_MB_BYTES);
      }

      const nominalBytes = entries.length * ONE_MB_BYTES;
      const rssGrowth = process.memoryUsage().rss - rssBefore;
      expect(rssGrowth).toBeGreaterThanOrEqual(nominalBytes / 2);
    }, 15_000);
  });

  // ── 8. disableMemoryLeak ──────────────────────────────────────────────────

  describe('disableMemoryLeak()', () => {
    it('stops the leak timer but does NOT free _leakArray (Requirements: 5.4)', () => {
      // Use long TTL so TTL expiry doesn't interfere with interval growth.
      const svc = makeServiceLongTtl(/* leakMbPerSecond */ 1);

      svc.enableMemoryLeak();
      jest.advanceTimersByTime(1000); // 1 entry pushed
      expect(svc.state._leakArray.length).toBe(1);

      svc.disableMemoryLeak();

      expect(svc.state.memoryLeakEnabled).toBe(false);
      expect(svc.state._leakTimer).toBeNull();
      // Array must still be populated.
      expect(svc.state._leakArray.length).toBe(1);

      // Advancing time further must NOT grow the array.
      jest.advanceTimersByTime(2000);
      expect(svc.state._leakArray.length).toBe(1);

      svc.onModuleDestroy();
    });
  });

  // ── 9. reset() ────────────────────────────────────────────────────────────

  describe('reset()', () => {
    it('zeros latencyMs, errorRatePercent, memoryLeakEnabled and frees _leakArray (Requirements: 7.1, 7.2)', () => {
      service.setLatency(1000);
      service.setErrorRate(80);
      service.enableMemoryLeak();
      jest.advanceTimersByTime(1000); // grow the leak array

      service.reset();

      expect(service.state.latencyMs).toBe(0);
      expect(service.state.errorRatePercent).toBe(0);
      expect(service.state.memoryLeakEnabled).toBe(false);
      expect(service.state._leakArray).toHaveLength(0);
      expect(service.state.memoryLeakRetainedMb).toBe(0);
    });

    it('nulls all expiry timestamps after reset (Requirements: 7.2)', () => {
      service.setLatency(500);
      service.setErrorRate(40);
      service.enableMemoryLeak();

      service.reset();

      expect(service.state.latencyExpiresAt).toBeNull();
      expect(service.state.errorRateExpiresAt).toBeNull();
      expect(service.state.memoryLeakExpiresAt).toBeNull();
    });

    it('clears all internal timers after reset (Requirements: 7.1)', () => {
      service.setLatency(500);
      service.setErrorRate(40);
      service.enableMemoryLeak();

      service.reset();

      expect(service.state._latencyTimer).toBeNull();
      expect(service.state._errorRateTimer).toBeNull();
      expect(service.state._leakTimer).toBeNull();
    });

    it('prevents TTL timers from firing after reset (Requirements: 7.1)', () => {
      service.setLatency(200);
      service.setErrorRate(60);

      service.reset();

      // Advance past the TTL — the timers were cleared, so state should
      // not change (it is already zeroed from reset).
      jest.advanceTimersByTime(3000);

      expect(service.state.latencyMs).toBe(0);
      expect(service.state.errorRatePercent).toBe(0);
    });
  });

  // ── 10. getState() snapshot ───────────────────────────────────────────────

  describe('getState()', () => {
    it('returns the correct scalar values for applied settings (Requirements: 7.5)', () => {
      service.setLatency(1500);
      service.setErrorRate(33);

      const snapshot = service.getState();

      expect(snapshot.latencyMs).toBe(1500);
      expect(snapshot.errorRatePercent).toBe(33);
      expect(snapshot.memoryLeakEnabled).toBe(false);
      expect(snapshot.memoryLeakRetainedMb).toBe(0);
    });

    it('expiry timestamps are ISO 8601 strings within TTL tolerance (Requirements: 7.4, 7.5)', () => {
      service.setLatency(1000);
      service.setErrorRate(50);
      service.enableMemoryLeak();

      const snapshot = service.getState();
      const ttlMs = 2 * 1000;
      const expectedExpiryMs = Date.now() + ttlMs;

      // All three expiry fields must be present and parseable.
      expect(snapshot.latencyExpiresAt).not.toBeNull();
      expect(snapshot.errorRateExpiresAt).not.toBeNull();
      expect(snapshot.memoryLeakExpiresAt).not.toBeNull();

      // Each timestamp should be within ±1 s of the expected expiry.
      for (const field of [
        snapshot.latencyExpiresAt!,
        snapshot.errorRateExpiresAt!,
        snapshot.memoryLeakExpiresAt!,
      ]) {
        const parsedMs = new Date(field).getTime();
        expect(Math.abs(parsedMs - expectedExpiryMs)).toBeLessThanOrEqual(1000);
      }
    });

    it('expiry timestamps are null after reset (Requirements: 7.5)', () => {
      service.setLatency(500);
      service.reset();

      const snapshot = service.getState();
      expect(snapshot.latencyExpiresAt).toBeNull();
      expect(snapshot.errorRateExpiresAt).toBeNull();
      expect(snapshot.memoryLeakExpiresAt).toBeNull();
    });

    it('does not expose internal fields (_leakArray, timers) (Requirements: 7.5)', () => {
      service.enableMemoryLeak();

      const snapshot = service.getState() as unknown as Record<string, unknown>;
      expect(snapshot['_leakArray']).toBeUndefined();
      expect(snapshot['_leakTimer']).toBeUndefined();
      expect(snapshot['_latencyTimer']).toBeUndefined();
      expect(snapshot['_errorRateTimer']).toBeUndefined();
    });

    it('reflects memoryLeakRetainedMb after the leak interval fires (Requirements: 7.5)', () => {
      // Use long TTL so TTL expiry doesn't clear the array during this test.
      const svc = makeServiceLongTtl(/* leakMbPerSecond */ 1);

      svc.enableMemoryLeak();
      jest.advanceTimersByTime(3000); // 3 ticks at 1 MB/s = 3 MB

      const snapshot = svc.getState();
      expect(snapshot.memoryLeakRetainedMb).toBe(3);
      expect(snapshot.memoryLeakEnabled).toBe(true);

      svc.onModuleDestroy();
    });
  });

  // ── 11. crash() ───────────────────────────────────────────────────────────

  describe('crash()', () => {
    it('schedules process.exit(1) after 100 ms (Requirements: 6.1, 6.2)', () => {
      const exitSpy = jest
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as () => never);

      service.crash();

      // Before 100 ms: process.exit must not have been called yet.
      jest.advanceTimersByTime(99);
      expect(exitSpy).not.toHaveBeenCalled();

      // At 100 ms: process.exit(1) must fire.
      jest.advanceTimersByTime(1);
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
    });
  });
});
