import * as fc from 'fast-check';
import { of } from 'rxjs';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MetricsInterceptor } from './metrics.interceptor';

// Feature: victim-app, Property 1: request counter increments on every non-excluded request
// Feature: victim-app, Property 2: latency histogram records observed duration

/**
 * Helper: extract a numeric metric value from Prometheus text output.
 * Returns the value of the FIRST line matching the given metric name and labels.
 */
function extractMetricValue(
  metricsText: string,
  metricName: string,
  labels: Record<string, string> = {},
): number | null {
  const lines = metricsText.split('\n');
  for (const line of lines) {
    if (line.startsWith('#') || line.trim() === '') continue;
    if (!line.startsWith(metricName)) continue;

    const labelEntries = Object.entries(labels);
    const allLabelsMatch = labelEntries.every(([k, v]) =>
      line.includes(`${k}="${v}"`),
    );
    if (!allLabelsMatch) continue;

    const parts = line.split(' ');
    const value = parseFloat(parts[parts.length - 1]);
    if (!isNaN(value)) return value;
  }
  return null;
}

interface MockContextResult {
  context: ExecutionContext;
  handler: CallHandler;
  fireClose: () => void;
}

/**
 * Build a mock ExecutionContext and CallHandler that simulate a completed
 * non-excluded HTTP request.
 *
 * Key behaviours:
 *  - req.url / req.path = route
 *  - req.method = method
 *  - req.route.path = route  (so MetricsInterceptor uses the matched pattern, not "unmatched")
 *  - res.writableFinished = true
 *  - res.statusCode = statusCode
 *  - res.once('close', cb) captures the callback so the caller can fire it
 */
function buildMockContext(
  method: string,
  route: string,
  statusCode: number,
): MockContextResult {
  let closeCallback: (() => void) | null = null;

  const req = {
    url: route,
    path: route,
    method,
    route: { path: route },
  };

  const res = {
    statusCode,
    writableFinished: true,
    once: (event: string, cb: () => void) => {
      if (event === 'close') {
        closeCallback = cb;
      }
    },
  };

  const context = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;

  const handler = {
    handle: () => of({}),
  } as unknown as CallHandler;

  const fireClose = () => {
    if (closeCallback) closeCallback();
  };

  return { context, handler, fireClose };
}

describe('MetricsInterceptor — Property 1: request counter increments on every non-excluded request', () => {
  let service: MetricsService;
  let interceptor: MetricsInterceptor;

  beforeEach(() => {
    jest.useFakeTimers();
    service = new MetricsService('test-service');
    interceptor = new MetricsInterceptor(service);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  /**
   * Property 1: For any HTTP method, route pattern (not /metrics, /health, or
   * /chaos/*), and status code, completing one request SHALL increment
   * http_requests_total by exactly one, labelled with the correct method,
   * matched route pattern, and status code.
   *
   * Validates: Requirements 2.2, 2.5
   */
  it(
    'Property 1 — http_requests_total increments by exactly 1 for any non-excluded request',
    async () => {
      // Feature: victim-app, Property 1: request counter increments on every non-excluded request
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            method: fc.constantFrom('GET', 'POST', 'PUT', 'DELETE'),
            route: fc.constantFrom('/order', '/payment'),
            statusCode: fc.integer({ min: 100, max: 599 }),
          }),
          async ({ method, route, statusCode }) => {
            // Each iteration needs a fresh MetricsService so counters start at 0.
            const iterService = new MetricsService('test-service');
            const iterInterceptor = new MetricsInterceptor(iterService);

            try {
              const { context, handler, fireClose } = buildMockContext(
                method,
                route,
                statusCode,
              );

              // Call intercept and subscribe to trigger the handler pipeline.
              await new Promise<void>((resolve, reject) => {
                iterInterceptor.intercept(context, handler).subscribe({
                  next: () => {},
                  error: reject,
                  complete: resolve,
                });
              });

              // Fire the close event to trigger the metrics recording callback.
              fireClose();

              const metrics = await iterService.getMetrics();
              const value = extractMetricValue(metrics, 'http_requests_total', {
                method,
                route,
                status_code: String(statusCode),
                service: 'test-service',
              });

              expect(value).toBe(1);
            } finally {
              iterService.onModuleDestroy();
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});

describe('MetricsInterceptor — Property 2: latency histogram records observed duration (fake timers)', () => {
  /**
   * Property 2: For any injected delay d milliseconds (in [0, 30 000]),
   * the http_request_duration_seconds observation recorded by
   * MetricsInterceptor SHALL be greater than or equal to d / 1000 seconds
   * and use the matched route pattern as the `route` label.
   *
   * Strategy: mock `performance.now()` to return 0 on the first call
   * (startTime capture inside intercept) and `delay` on the second call
   * (inside the `close` callback). This gives deterministic control over
   * the computed durationSeconds without relying on wall-clock time or
   * Jest fake-timer interception of performance.now().
   *
   * Validates: Requirements 2.3, 3.2
   */
  it(
    'Property 2 — http_request_duration_seconds observation equals delay/1000 for any delay in [0, 30000]',
    async () => {
      // Feature: victim-app, Property 2: latency histogram records observed duration
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 30_000 }),
          async (delay) => {
            // Fresh service per iteration so histogram starts at zero.
            const iterService = new MetricsService('test-service');

            // Mock performance.now(): first call returns 0 (startTime),
            // second call returns `delay` (inside close callback).
            let callCount = 0;
            const perfNowSpy = jest
              .spyOn(performance, 'now')
              .mockImplementation(() => {
                callCount++;
                // First call: startTime = 0
                // Second call (inside close callback): now = delay ms
                return callCount === 1 ? 0 : delay;
              });

            try {
              const iterInterceptor = new MetricsInterceptor(iterService);

              const { context, handler, fireClose } = buildMockContext(
                'POST',
                '/order',
                200,
              );

              // Intercept the request — registers the close listener.
              await new Promise<void>((resolve, reject) => {
                iterInterceptor.intercept(context, handler).subscribe({
                  next: () => {},
                  error: reject,
                  complete: resolve,
                });
              });

              // Fire the close event: triggers the close callback which calls
              // performance.now() a second time and calls recordRequest.
              fireClose();

              const metrics = await iterService.getMetrics();

              // The _sum metric holds the total observed duration in seconds.
              // With a single observation it equals the observed value exactly.
              const sumValue = extractMetricValue(
                metrics,
                'http_request_duration_seconds_sum',
                { method: 'POST', route: '/order', service: 'test-service' },
              );

              const expectedSeconds = delay / 1000;

              // The recorded duration must equal delay / 1000 (within
              // floating-point tolerance of ±1 µs).
              expect(sumValue).not.toBeNull();
              expect(sumValue!).toBeCloseTo(expectedSeconds, 9);

              // The observation count must be exactly 1.
              const countValue = extractMetricValue(
                metrics,
                'http_request_duration_seconds_count',
                { method: 'POST', route: '/order', service: 'test-service' },
              );
              expect(countValue).toBe(1);
            } finally {
              perfNowSpy.mockRestore();
              iterService.onModuleDestroy();
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});

describe('MetricsInterceptor — Property 3: error counter increments on 5xx only', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * Property 3: For any HTTP status code in [100, 599], completing one request
   * SHALL increment http_errors_total by exactly 1 iff statusCode >= 500,
   * and SHALL NOT increment it (counter absent or 0) for statusCode < 500.
   *
   * Validates: Requirements 2.4
   */
  it(
    'Property 3 — http_errors_total increments by exactly 1 for 5xx, and is absent/0 for non-5xx',
    async () => {
      // Feature: victim-app, Property 3: error counter increments on 5xx only
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 100, max: 599 }),
          async (statusCode) => {
            // Fresh service per iteration so counters start at 0.
            const iterService = new MetricsService('test-service');
            const iterInterceptor = new MetricsInterceptor(iterService);

            try {
              const { context, handler, fireClose } = buildMockContext(
                'POST',
                '/order',
                statusCode,
              );

              // Call intercept and subscribe to trigger the handler pipeline.
              await new Promise<void>((resolve, reject) => {
                iterInterceptor.intercept(context, handler).subscribe({
                  next: () => {},
                  error: reject,
                  complete: resolve,
                });
              });

              // Fire the close event to trigger the metrics recording callback.
              fireClose();

              const metrics = await iterService.getMetrics();
              const value = extractMetricValue(metrics, 'http_errors_total', {
                method: 'POST',
                route: '/order',
                status_code: String(statusCode),
                service: 'test-service',
              });

              if (statusCode >= 500) {
                // 5xx: error counter must be exactly 1
                expect(value).toBe(1);
              } else {
                // non-5xx: error counter must be absent (null) or 0
                expect(value === null || value === 0).toBe(true);
              }
            } finally {
              iterService.onModuleDestroy();
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});
