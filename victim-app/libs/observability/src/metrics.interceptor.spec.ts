import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsService } from './metrics.service';

/**
 * Unit tests for MetricsInterceptor.
 *
 * Requirements covered: 2.2, 2.3, 2.4, 2.5
 *
 * These tests use a real MetricsService instance (no mocking of its internals)
 * and a hand-crafted mock ExecutionContext. The `res.once('close', cb)`
 * pattern is simulated by capturing the registered callback and firing it
 * manually, giving deterministic control over when the close event fires.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract a numeric metric value from Prometheus text output.
 * Matches the first non-comment line that starts with `metricName` and
 * contains every `label="value"` pair provided.
 */
function extractMetricValue(
  metricsText: string,
  metricName: string,
  labels: Record<string, string> = {},
): number | null {
  for (const line of metricsText.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    if (!line.startsWith(metricName)) continue;
    if (!Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`))) continue;

    const parts = line.split(' ');
    const value = parseFloat(parts[parts.length - 1]);
    return isNaN(value) ? null : value;
  }
  return null;
}

interface MockContextOpts {
  /** Raw path used for route exclusion check (req.path / req.url). */
  path: string;
  method?: string;
  /** Optional matched route pattern on req.route.path. Omit to simulate unmatched. */
  routePattern?: string;
  statusCode?: number;
  /** Override res.writableFinished. Defaults to true. */
  writableFinished?: boolean;
}

interface MockContextResult {
  context: ExecutionContext;
  handler: CallHandler;
  /** Call this to simulate the underlying TCP connection closing. */
  fireClose: () => void;
  /** Spy on res.once to assert it was (or wasn't) called. */
  resOnceSpy: jest.Mock;
}

function buildMockContext(opts: MockContextOpts): MockContextResult {
  const {
    path,
    method = 'GET',
    routePattern,
    statusCode = 200,
    writableFinished = true,
  } = opts;

  let closeCallback: (() => void) | null = null;
  const resOnceSpy = jest.fn((event: string, cb: () => void) => {
    if (event === 'close') closeCallback = cb;
  });

  const req: Record<string, unknown> = {
    url: path,
    path,
    method,
  };
  // Only set req.route when a pattern is explicitly provided, so we can test
  // the "unmatched" fallback by omitting it.
  if (routePattern !== undefined) {
    req.route = { path: routePattern };
  }

  const res = {
    statusCode,
    writableFinished,
    once: resOnceSpy,
  };

  const context = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;

  const handler: CallHandler = { handle: () => of({}) };

  return {
    context,
    handler,
    fireClose: () => { if (closeCallback) closeCallback(); },
    resOnceSpy,
  };
}

// Helper: run intercept through to completion, then fire the close event.
async function runAndClose(
  interceptor: MetricsInterceptor,
  ctx: MockContextResult,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    interceptor.intercept(ctx.context, ctx.handler).subscribe({
      next: () => {},
      error: reject,
      complete: resolve,
    });
  });
  ctx.fireClose();
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe('MetricsInterceptor — unit tests', () => {
  let service: MetricsService;
  let interceptor: MetricsInterceptor;
  let recordSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    service = new MetricsService('test');
    interceptor = new MetricsInterceptor(service);
    recordSpy = jest.spyOn(service, 'recordRequest');
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ── Scenario 1: recordRequest called with correct args after res.close ───

  describe('Scenario 1 — recordRequest is called with correct arguments after res.close fires', () => {
    it('calls recordRequest with method, matched route, status code, and a positive duration', async () => {
      // Patch performance.now so the duration is predictable.
      let call = 0;
      jest.spyOn(performance, 'now').mockImplementation(() => (call++ === 0 ? 0 : 250));

      const ctx = buildMockContext({
        path: '/order',
        method: 'POST',
        routePattern: '/order',
        statusCode: 200,
      });

      await runAndClose(interceptor, ctx);

      expect(recordSpy).toHaveBeenCalledTimes(1);
      expect(recordSpy).toHaveBeenCalledWith(
        'POST',           // method
        '/order',         // route — from req.route.path
        200,              // statusCode
        0.25,             // durationSeconds — (250 - 0) / 1000
      );
    });

    it('records the correct status code when the response is 500', async () => {
      jest.spyOn(performance, 'now').mockReturnValue(0);

      const ctx = buildMockContext({
        path: '/order',
        method: 'GET',
        routePattern: '/order',
        statusCode: 500,
      });

      await runAndClose(interceptor, ctx);

      expect(recordSpy).toHaveBeenCalledWith('GET', '/order', 500, expect.any(Number));
    });

    it('fires recordRequest only after the close event, not before', async () => {
      const ctx = buildMockContext({ path: '/order', routePattern: '/order' });

      // Subscribe but do NOT fire close yet.
      await new Promise<void>((resolve, reject) => {
        interceptor.intercept(ctx.context, ctx.handler).subscribe({
          next: () => {},
          error: reject,
          complete: resolve,
        });
      });

      expect(recordSpy).not.toHaveBeenCalled();

      ctx.fireClose();

      expect(recordSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── Scenario 2: route label from req.route?.path, fallback to "unmatched" ─

  describe('Scenario 2 — route label uses req.route.path, falling back to "unmatched"', () => {
    it('uses req.route.path as the route label when it is present', async () => {
      const ctx = buildMockContext({
        path: '/order',
        routePattern: '/order',
        statusCode: 200,
      });

      await runAndClose(interceptor, ctx);

      expect(recordSpy).toHaveBeenCalledWith(
        expect.any(String),
        '/order',          // route label is the matched pattern
        expect.any(Number),
        expect.any(Number),
      );
    });

    it('falls back to "unmatched" when req.route is undefined', async () => {
      // No routePattern → req.route is not set → should fall back to "unmatched".
      const ctx = buildMockContext({
        path: '/order',
        routePattern: undefined,
        statusCode: 404,
      });

      await runAndClose(interceptor, ctx);

      expect(recordSpy).toHaveBeenCalledWith(
        expect.any(String),
        'unmatched',       // fallback label — Requirement 2.5
        expect.any(Number),
        expect.any(Number),
      );
    });

    it('falls back to "unmatched" when req.route.path is undefined', async () => {
      // req.route exists but path is explicitly undefined.
      const ctx = buildMockContext({ path: '/order' });
      // Manually override route to have no path property.
      (ctx.context.switchToHttp().getRequest() as Record<string, unknown>).route = {};

      await runAndClose(interceptor, ctx);

      expect(recordSpy).toHaveBeenCalledWith(
        expect.any(String),
        'unmatched',
        expect.any(Number),
        expect.any(Number),
      );
    });
  });

  // ── Scenario 3: status 499 when res.writableFinished === false ────────────

  describe('Scenario 3 — status 499 is recorded when res.writableFinished is false', () => {
    it('records status 499 when writableFinished is false (client disconnected mid-flight)', async () => {
      const ctx = buildMockContext({
        path: '/order',
        routePattern: '/order',
        statusCode: 200,       // res.statusCode says 200, but...
        writableFinished: false, // ...client disconnected before write completed
      });

      await runAndClose(interceptor, ctx);

      expect(recordSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        499,               // 499 overrides res.statusCode — Requirement 2.2
        expect.any(Number),
      );
    });

    it('records res.statusCode (not 499) when writableFinished is true', async () => {
      const ctx = buildMockContext({
        path: '/order',
        routePattern: '/order',
        statusCode: 201,
        writableFinished: true,
      });

      await runAndClose(interceptor, ctx);

      expect(recordSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        201,
        expect.any(Number),
      );
    });
  });

  // ── Scenario 4: excluded routes are skipped entirely ─────────────────────

  describe('Scenario 4 — excluded routes are skipped entirely', () => {
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

    for (const excludedPath of excludedPaths) {
      it(`skips instrumentation for ${excludedPath}`, async () => {
        const ctx = buildMockContext({ path: excludedPath });

        await new Promise<void>((resolve, reject) => {
          interceptor.intercept(ctx.context, ctx.handler).subscribe({
            next: () => {},
            error: reject,
            complete: resolve,
          });
        });

        // No close listener should be registered — Requirement 7.6
        expect(ctx.resOnceSpy).not.toHaveBeenCalled();

        // Firing close anyway should not trigger any metric recording.
        ctx.fireClose();
        expect(recordSpy).not.toHaveBeenCalled();
      });
    }

    it('still processes the request normally on excluded routes (next.handle is returned)', async () => {
      const ctx = buildMockContext({ path: '/health' });
      let emittedValue: unknown;

      await new Promise<void>((resolve, reject) => {
        interceptor.intercept(ctx.context, ctx.handler).subscribe({
          next: (v) => { emittedValue = v; },
          error: reject,
          complete: resolve,
        });
      });

      // The observable completes and passes through the handler's value.
      expect(emittedValue).toEqual({});
      // No metrics touched.
      expect(recordSpy).not.toHaveBeenCalled();
    });
  });
});
