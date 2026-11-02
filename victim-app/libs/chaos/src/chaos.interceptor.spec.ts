/**
 * Unit tests for ChaosInterceptor
 *
 * Covers:
 *  - Excluded routes (/metrics, /health, /chaos/*) pass through with no
 *    delay and no error injection.                             (Req 7.6)
 *  - Non-excluded routes with latencyMs > 0: the sleep() is awaited and
 *    the interceptor does not resolve before the timer fires.  (Req 3.1, 3.2)
 *  - Non-excluded routes with errorRatePercent > 0: deterministic check
 *    via jest.spyOn(Math, 'random') — below threshold passes, at/above
 *    threshold throws HttpException(500).                      (Req 4.1, 4.2)
 *  - Non-excluded routes with no chaos active: pass through normally.
 */

import { ExecutionContext, CallHandler, HttpException, HttpStatus } from '@nestjs/common';
import { of } from 'rxjs';
import { ChaosInterceptor } from './chaos.interceptor';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal ChaosService mock with the state values used by the interceptor. */
function makeMockService(opts: { latencyMs?: number; errorRatePercent?: number } = {}) {
  return {
    state: {
      latencyMs: opts.latencyMs ?? 0,
      latencyExpiresAt: null,
      errorRatePercent: opts.errorRatePercent ?? 0,
      errorRateExpiresAt: null,
      memoryLeakEnabled: false,
      memoryLeakExpiresAt: null,
      memoryLeakRetainedMb: 0,
      _leakArray: [],
      _leakTimer: null,
      _latencyTimer: null,
      _errorRateTimer: null,
    },
  };
}

/** Build a mock ExecutionContext whose request path is the given string. */
function buildMockContext(path: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ path }),
    }),
  } as unknown as ExecutionContext;
}

/** Build a mock CallHandler that resolves with null. */
function buildMockHandler(): CallHandler {
  return { handle: () => of(null) } as unknown as CallHandler;
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe('ChaosInterceptor — unit tests', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── 1. Excluded routes ─────────────────────────────────────────────────

  describe('excluded routes (Requirements: 7.6)', () => {
    const excludedPaths = [
      '/metrics',
      '/health',
      '/chaos/state',
      '/chaos/reset',
      '/chaos/latency',
      '/chaos/error-rate',
      '/chaos/memory-leak',
      '/chaos/crash',
    ];

    for (const path of excludedPaths) {
      it(`passes through immediately for ${path} even with chaos active`, async () => {
        // Set both latency and error rate to their maximums — they must be ignored.
        const service = makeMockService({ latencyMs: 5000, errorRatePercent: 100 });
        const interceptor = new ChaosInterceptor(service as never);
        const context = buildMockContext(path);
        const handler = buildMockHandler();

        // Should resolve without any timer ticks and without throwing.
        await expect(interceptor.intercept(context, handler)).resolves.toBeDefined();
      });
    }

    it('does not await a sleep timer for excluded routes', async () => {
      jest.useFakeTimers();
      try {
        const service = makeMockService({ latencyMs: 10000 });
        const interceptor = new ChaosInterceptor(service as never);
        const context = buildMockContext('/health');
        const handler = buildMockHandler();

        let resolved = false;
        const promise = interceptor.intercept(context, handler).then(() => {
          resolved = true;
        });

        // Flush microtasks only — no timer advance needed for excluded routes.
        await Promise.resolve();
        await Promise.resolve();

        expect(resolved).toBe(true);
        await promise;
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not throw an HttpException for excluded routes at 100% error rate', async () => {
      const service = makeMockService({ errorRatePercent: 100 });
      const interceptor = new ChaosInterceptor(service as never);
      const context = buildMockContext('/metrics');
      const handler = buildMockHandler();

      // Math.random returning 0 would normally trigger error at 100%, but the
      // route is excluded so the random check must never run.
      jest.spyOn(Math, 'random').mockReturnValue(0);

      await expect(interceptor.intercept(context, handler)).resolves.toBeDefined();
    });
  });

  // ── 2. Latency injection ───────────────────────────────────────────────

  describe('latency injection (Requirements: 3.1, 3.2)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('does not resolve before the sleep timer fires', async () => {
      const service = makeMockService({ latencyMs: 200 });
      const interceptor = new ChaosInterceptor(service as never);
      const context = buildMockContext('/order');
      const handler = buildMockHandler();

      let resolved = false;
      const promise = interceptor.intercept(context, handler).then(() => {
        resolved = true;
      });

      // No timer advancement — the sleep is still pending.
      expect(resolved).toBe(false);

      // Advance exactly 200 ms to fire the sleep.
      await jest.advanceTimersByTimeAsync(200);

      expect(resolved).toBe(true);
      await promise;
    });

    it('resolves immediately when latencyMs is 0', async () => {
      const service = makeMockService({ latencyMs: 0 });
      const interceptor = new ChaosInterceptor(service as never);
      const context = buildMockContext('/order');
      const handler = buildMockHandler();

      let resolved = false;
      const promise = interceptor.intercept(context, handler).then(() => {
        resolved = true;
      });

      // Flush microtasks — no timer tick should be needed.
      await Promise.resolve();
      await Promise.resolve();

      expect(resolved).toBe(true);
      await promise;
    });

    it('does not resolve 1 ms before the configured delay', async () => {
      const service = makeMockService({ latencyMs: 500 });
      const interceptor = new ChaosInterceptor(service as never);
      const context = buildMockContext('/order');
      const handler = buildMockHandler();

      let resolved = false;
      const promise = interceptor.intercept(context, handler).then(() => {
        resolved = true;
      });

      // One millisecond short — must still be pending.
      await jest.advanceTimersByTimeAsync(499);
      expect(resolved).toBe(false);

      // The final 1 ms completes the sleep.
      await jest.advanceTimersByTimeAsync(1);
      expect(resolved).toBe(true);
      await promise;
    });

    it('awaits the sleep before passing control to next.handle()', async () => {
      const service = makeMockService({ latencyMs: 300 });
      const interceptor = new ChaosInterceptor(service as never);
      const context = buildMockContext('/order');

      let handleCalled = false;
      const handler: CallHandler = {
        handle: () => {
          handleCalled = true;
          return of(null);
        },
      } as unknown as CallHandler;

      const promise = interceptor.intercept(context, handler);

      // Advance past the sleep.
      await jest.advanceTimersByTimeAsync(300);
      await promise;

      expect(handleCalled).toBe(true);
    });
  });

  // ── 3. Error-rate injection ────────────────────────────────────────────

  describe('error-rate injection (Requirements: 4.1, 4.2)', () => {
    it('throws HttpException(500) when random roll is below errorRatePercent', async () => {
      const service = makeMockService({ errorRatePercent: 50 });
      const interceptor = new ChaosInterceptor(service as never);
      const context = buildMockContext('/order');
      const handler = buildMockHandler();

      // roll = Math.random() * 100 = 0.2 * 100 = 20 < 50 → throw
      jest.spyOn(Math, 'random').mockReturnValue(0.2);

      await expect(interceptor.intercept(context, handler)).rejects.toThrow(HttpException);
    });

    it('throws with HTTP 500 status (Requirements: 4.2)', async () => {
      const service = makeMockService({ errorRatePercent: 50 });
      const interceptor = new ChaosInterceptor(service as never);
      const context = buildMockContext('/order');
      const handler = buildMockHandler();

      jest.spyOn(Math, 'random').mockReturnValue(0.1); // 10 < 50 → throw

      let thrown: HttpException | undefined;
      try {
        await interceptor.intercept(context, handler);
      } catch (err) {
        thrown = err as HttpException;
      }

      expect(thrown).toBeInstanceOf(HttpException);
      expect(thrown!.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    });

    it('carries { message: "chaos: injected error" } in the response body (Requirements: 4.2)', async () => {
      const service = makeMockService({ errorRatePercent: 50 });
      const interceptor = new ChaosInterceptor(service as never);
      const context = buildMockContext('/order');
      const handler = buildMockHandler();

      jest.spyOn(Math, 'random').mockReturnValue(0.0); // 0 < 50 → throw

      let thrown: HttpException | undefined;
      try {
        await interceptor.intercept(context, handler);
      } catch (err) {
        thrown = err as HttpException;
      }

      expect(thrown).toBeInstanceOf(HttpException);
      const body = thrown!.getResponse() as Record<string, unknown>;
      expect(body).toMatchObject({ message: 'chaos: injected error' });
    });

    it('passes through when random roll equals errorRatePercent (boundary — not strictly less than)', async () => {
      const service = makeMockService({ errorRatePercent: 50 });
      const interceptor = new ChaosInterceptor(service as never);
      const context = buildMockContext('/order');
      const handler = buildMockHandler();

      // roll = 0.5 * 100 = 50, which is NOT < 50 → should NOT throw
      jest.spyOn(Math, 'random').mockReturnValue(0.5);

      await expect(interceptor.intercept(context, handler)).resolves.toBeDefined();
    });

    it('passes through when random roll is above errorRatePercent', async () => {
      const service = makeMockService({ errorRatePercent: 30 });
      const interceptor = new ChaosInterceptor(service as never);
      const context = buildMockContext('/order');
      const handler = buildMockHandler();

      // roll = 0.8 * 100 = 80 ≥ 30 → pass through
      jest.spyOn(Math, 'random').mockReturnValue(0.8);

      await expect(interceptor.intercept(context, handler)).resolves.toBeDefined();
    });

    it('always throws at 100% error rate regardless of random value', async () => {
      const service = makeMockService({ errorRatePercent: 100 });
      const interceptor = new ChaosInterceptor(service as never);
      const context = buildMockContext('/order');

      // Even the maximum valid float below 1 gives a roll < 100.
      for (const roll of [0, 0.5, 0.9999]) {
        jest.spyOn(Math, 'random').mockReturnValue(roll);
        await expect(interceptor.intercept(context, buildMockHandler())).rejects.toBeInstanceOf(
          HttpException,
        );
      }
    });

    it('never throws at 0% error rate regardless of random value', async () => {
      const service = makeMockService({ errorRatePercent: 0 });
      const interceptor = new ChaosInterceptor(service as never);
      const context = buildMockContext('/order');

      // Even the smallest possible roll should not trigger injection at 0%.
      jest.spyOn(Math, 'random').mockReturnValue(0);

      await expect(interceptor.intercept(context, buildMockHandler())).resolves.toBeDefined();
    });
  });

  // ── 4. No chaos active ─────────────────────────────────────────────────

  describe('no chaos active (Requirements: 3.1, 4.1)', () => {
    it('passes through to next.handle() and returns its observable', async () => {
      const service = makeMockService();
      const interceptor = new ChaosInterceptor(service as never);
      const context = buildMockContext('/order');
      const handler = buildMockHandler();

      const result = await interceptor.intercept(context, handler);

      // The returned observable must emit when subscribed.
      await expect(
        new Promise<void>((resolve, reject) => {
          result.subscribe({ next: () => {}, error: reject, complete: resolve });
        }),
      ).resolves.toBeUndefined();
    });

    it('calls next.handle() exactly once', async () => {
      const service = makeMockService();
      const interceptor = new ChaosInterceptor(service as never);
      const context = buildMockContext('/order');

      const handleSpy = jest.fn(() => of(null));
      const handler = { handle: handleSpy } as unknown as CallHandler;

      await interceptor.intercept(context, handler);

      expect(handleSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── 5. Latency + error-rate combined ──────────────────────────────────

  describe('latency then error injection combined', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('awaits sleep before evaluating error rate', async () => {
      const service = makeMockService({ latencyMs: 100, errorRatePercent: 100 });
      const interceptor = new ChaosInterceptor(service as never);
      const context = buildMockContext('/order');
      const handler = buildMockHandler();

      // roll = 0 → always throw at 100%, but only after the sleep fires.
      jest.spyOn(Math, 'random').mockReturnValue(0);

      let settled = false;
      const promise = interceptor.intercept(context, handler).catch(() => {
        settled = true;
      });

      // Before the sleep: not yet settled.
      expect(settled).toBe(false);

      // Advance past the 100 ms sleep.
      await jest.advanceTimersByTimeAsync(100);
      await promise;

      // After the sleep: error was thrown (caught above).
      expect(settled).toBe(true);
    });
  });
});
