// Feature: victim-app, Property 4: chaos error-rate injection statistical accuracy

import * as fc from 'fast-check';
import { of } from 'rxjs';
import { ExecutionContext, CallHandler, HttpException } from '@nestjs/common';
import { ChaosInterceptor } from './chaos.interceptor';

/**
 * Property 4 — Error-rate statistical accuracy
 *
 * For any error-rate percentage p in [1, 100], running ChaosInterceptor
 * n = 200 times on a non-excluded route SHALL produce an error count that
 * falls within ±4σ of the binomial expected value (n × p / 100), where
 * σ = sqrt(n × p × (1 − p)).
 *
 * This validates that the Math.random() sampling in ChaosInterceptor
 * produces statistically correct injection rates across many inputs.
 *
 * Validates: Requirements 4.1, 4.2
 */

/** Minimal mock for ChaosService — only exposes the `state` property used by the interceptor. */
function makeMockChaosService(errorRatePercent: number) {
  return {
    state: {
      latencyMs: 0,
      latencyExpiresAt: null,
      errorRatePercent,
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

/** Mock ExecutionContext pointing to a non-excluded business route. */
function buildMockContext(path: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ path }),
    }),
  } as unknown as ExecutionContext;
}

/** Mock CallHandler whose handle() always succeeds with null. */
function buildMockHandler(): CallHandler {
  return {
    handle: () => of(null),
  } as unknown as CallHandler;
}

describe('ChaosInterceptor — Property 4: error-rate statistical accuracy', () => {
  /**
   * Run the interceptor `n` times and count how many invocations throw an
   * HttpException with status 500 (i.e. chaos-injected errors).
   *
   * The interceptor is `async` and returns `Promise<Observable<unknown>>`.
   * A thrown HttpException is caught at the `await` level; a successful call
   * returns an Observable (no error thrown).
   */
  async function runBatch(
    interceptor: ChaosInterceptor,
    context: ExecutionContext,
    n: number,
  ): Promise<number> {
    let errorCount = 0;

    for (let i = 0; i < n; i++) {
      const handler = buildMockHandler();
      try {
        await interceptor.intercept(context, handler);
        // No exception thrown → successful pass-through
      } catch (err) {
        if (err instanceof HttpException && err.getStatus() === 500) {
          errorCount++;
        } else {
          // Re-throw unexpected errors so they bubble up as test failures
          throw err;
        }
      }
    }

    return errorCount;
  }

  it(
    'Property 4 — error count falls within ±4σ of binomial expected value for any p in [1, 100]',
    async () => {
      // Feature: victim-app, Property 4: chaos error-rate injection statistical accuracy
      await fc.assert(
        fc.asyncProperty(
          fc.float({ min: 1, max: 100, noNaN: true }),
          async (percentage) => {
            const n = 200;
            const p = percentage / 100;

            // Build interceptor with the generated error rate
            const mockService = makeMockChaosService(percentage);
            const interceptor = new ChaosInterceptor(
              // Cast needed because we only implement the subset used by the interceptor
              mockService as never,
            );
            const context = buildMockContext('/order');

            // Run the batch and count injected errors
            const errorCount = await runBatch(interceptor, context, n);

            // Binomial(n, p) statistics
            const expected = n * p;
            const sigma = Math.sqrt(n * p * (1 - p));

            // With ±4σ bounds the false-failure probability is ~0.006% per run
            const lowerBound = expected - 4 * sigma;
            const upperBound = expected + 4 * sigma;

            // For very high or very low p the sigma can be near 0; clamp bounds
            // to [0, n] to avoid nonsensical comparisons.
            const clampedLower = Math.max(0, lowerBound);
            const clampedUpper = Math.min(n, upperBound);

            expect(errorCount).toBeGreaterThanOrEqual(clampedLower);
            expect(errorCount).toBeLessThanOrEqual(clampedUpper);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    'Property 4 (error body) — thrown HttpException carries the expected chaos message and HTTP 500',
    async () => {
      // Feature: victim-app, Property 4: chaos error-rate injection statistical accuracy
      // Use 100% error rate so every call throws, letting us inspect every response body.
      await fc.assert(
        fc.asyncProperty(
          fc.constant(100 as number), // always 100%
          async (percentage) => {
            const mockService = makeMockChaosService(percentage);
            const interceptor = new ChaosInterceptor(mockService as never);
            const context = buildMockContext('/order');
            const handler = buildMockHandler();

            let caughtError: unknown;
            try {
              await interceptor.intercept(context, handler);
            } catch (err) {
              caughtError = err;
            }

            // Must have thrown
            expect(caughtError).toBeInstanceOf(HttpException);

            const httpException = caughtError as HttpException;

            // Status must be 500 (Req 4.2)
            expect(httpException.getStatus()).toBe(500);

            // Body must carry { message: 'chaos: injected error' } (Req 4.2)
            const body = httpException.getResponse() as Record<string, unknown>;
            expect(body).toMatchObject({ message: 'chaos: injected error' });
          },
        ),
        { numRuns: 20 },
      );
    },
  );

  it(
    'Property 4 (excluded routes) — interceptor never injects errors on excluded routes regardless of error rate',
    async () => {
      // Feature: victim-app, Property 4: chaos error-rate injection statistical accuracy
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            path: fc.constantFrom('/metrics', '/health', '/chaos/state', '/chaos/reset'),
            percentage: fc.float({ min: 1, max: 100, noNaN: true }),
          }),
          async ({ path, percentage }) => {
            const mockService = makeMockChaosService(percentage);
            const interceptor = new ChaosInterceptor(mockService as never);
            const context = buildMockContext(path);

            // Run 20 times on an excluded route — none should throw
            for (let i = 0; i < 20; i++) {
              const handler = buildMockHandler();
              // Should never throw — excluded routes bypass chaos logic
              await expect(
                interceptor.intercept(context, handler),
              ).resolves.not.toThrow();
            }
          },
        ),
        { numRuns: 50 },
      );
    },
  );
});

// Feature: victim-app, Property 5: chaos latency injection adds delay to every non-excluded request

/**
 * Property 5 — Latency injection adds delay to every non-excluded request
 *
 * For any configured latency `ms` in [1, 30 000], with Jest fake timers,
 * every non-excluded request processed while latency chaos is active SHALL
 * trigger an awaited delay of exactly `ms` milliseconds inside ChaosInterceptor
 * before passing control to the route handler.
 *
 * Validates: Requirements 3.1, 3.2
 */

/** Minimal mock for ChaosService with latencyMs set, error rate zeroed. */
function makeMockChaosServiceWithLatency(latencyMs: number) {
  return {
    state: {
      latencyMs,
      latencyExpiresAt: null,
      errorRatePercent: 0,
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

describe('ChaosInterceptor — Property 5: latency injection adds delay', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it(
    'Property 5 — interceptor does not resolve before the timer fires, then resolves after advancing timers by ms',
    async () => {
      // Feature: victim-app, Property 5: chaos latency injection adds delay to every non-excluded request
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 30000 }),
          async (ms) => {
            const mockService = makeMockChaosServiceWithLatency(ms);
            const interceptor = new ChaosInterceptor(mockService as never);
            const context = buildMockContext('/order');
            const handler = buildMockHandler();

            let resolved = false;
            const promise = interceptor
              .intercept(context, handler)
              .then(() => {
                resolved = true;
              });

            // The sleep(ms) inside the interceptor hasn't fired yet — still pending.
            expect(resolved).toBe(false);

            // Advance fake timers by exactly `ms` and flush all microtasks/promises.
            await jest.advanceTimersByTimeAsync(ms);

            // Now the sleep resolves and the interceptor completes.
            expect(resolved).toBe(true);

            // Drain to avoid unhandled-rejection warnings.
            await promise;
          },
        ),
        // Keep numRuns modest — fake-timer overhead is low but we don't need thousands.
        { numRuns: 50 },
      );
    },
  );

  it(
    'Property 5 — advancing timers by ms-1 is NOT enough; only full ms resolves the interceptor',
    async () => {
      // Feature: victim-app, Property 5: chaos latency injection adds delay to every non-excluded request
      await fc.assert(
        fc.asyncProperty(
          // min 2 so that ms-1 >= 1 (setTimeout(resolve, 1) never fires at t=0)
          fc.integer({ min: 2, max: 30000 }),
          async (ms) => {
            const mockService = makeMockChaosServiceWithLatency(ms);
            const interceptor = new ChaosInterceptor(mockService as never);
            const context = buildMockContext('/order');
            const handler = buildMockHandler();

            let resolved = false;
            const promise = interceptor
              .intercept(context, handler)
              .then(() => {
                resolved = true;
              });

            // Advance by one less than required — interceptor should still be waiting.
            await jest.advanceTimersByTimeAsync(ms - 1);
            expect(resolved).toBe(false);

            // Advance the remaining 1 ms — now it resolves.
            await jest.advanceTimersByTimeAsync(1);
            expect(resolved).toBe(true);

            await promise;
          },
        ),
        { numRuns: 50 },
      );
    },
  );

  it(
    'Property 5 (excluded routes) — excluded routes bypass the delay entirely even when latencyMs > 0',
    async () => {
      // Feature: victim-app, Property 5: chaos latency injection adds delay to every non-excluded request
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            path: fc.constantFrom('/metrics', '/health', '/chaos/state', '/chaos/reset'),
            ms: fc.integer({ min: 1, max: 30000 }),
          }),
          async ({ path, ms }) => {
            const mockService = makeMockChaosServiceWithLatency(ms);
            const interceptor = new ChaosInterceptor(mockService as never);
            const context = buildMockContext(path);
            const handler = buildMockHandler();

            let resolved = false;
            const promise = interceptor
              .intercept(context, handler)
              .then(() => {
                resolved = true;
              });

            // Excluded routes skip the sleep entirely — no timer advancement needed.
            // Flush microtasks/promises only (no fake timer tick required).
            await Promise.resolve();
            await Promise.resolve();

            expect(resolved).toBe(true);

            await promise;
          },
        ),
        { numRuns: 50 },
      );
    },
  );
});
