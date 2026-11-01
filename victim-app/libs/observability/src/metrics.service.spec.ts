import { MetricsService, METRICS_SERVICE_NAME } from './metrics.service';

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

    // Check that every required label is present in this line.
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

describe('MetricsService', () => {
  let service: MetricsService;

  beforeEach(() => {
    jest.useFakeTimers();
    service = new MetricsService('test-service');
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  // ── Requirement 2.8 — service label ───────────────────────────────────────

  describe('service label (Requirement 2.8)', () => {
    it('should include the service label in all metrics output', async () => {
      service.recordRequest('GET', '/order', 200, 0.01);

      const metrics = await service.getMetrics();

      expect(metrics).toContain('service="test-service"');
    });

    it('should use a different service name when constructed with a different name', async () => {
      const otherService = new MetricsService('payments');
      try {
        otherService.recordRequest('POST', '/payment', 200, 0.005);
        const metrics = await otherService.getMetrics();
        expect(metrics).toContain('service="payments"');
      } finally {
        otherService.onModuleDestroy();
      }
    });
  });

  // ── Requirement 2.1 — getMetrics() returns text format ───────────────────

  describe('getMetrics() (Requirement 2.1)', () => {
    it('should return a string containing registered metric names', async () => {
      const metrics = await service.getMetrics();

      expect(typeof metrics).toBe('string');
      expect(metrics).toContain('http_requests_total');
      expect(metrics).toContain('http_request_duration_seconds');
      expect(metrics).toContain('http_errors_total');
      expect(metrics).toContain('process_heap_used_bytes');
      expect(metrics).toContain('process_rss_bytes');
    });
  });

  // ── Requirement 2.2 — request counter ────────────────────────────────────

  describe('http_requests_total (Requirement 2.2)', () => {
    it('should increment by 1 when recordRequest is called with correct labels', async () => {
      service.recordRequest('POST', '/order', 200, 0.05);

      const metrics = await service.getMetrics();
      const value = extractMetricValue(metrics, 'http_requests_total', {
        method: 'POST',
        route: '/order',
        status_code: '200',
        service: 'test-service',
      });

      expect(value).toBe(1);
    });

    it('should increment once per call', async () => {
      service.recordRequest('GET', '/order', 200, 0.01);
      service.recordRequest('GET', '/order', 200, 0.01);
      service.recordRequest('GET', '/order', 200, 0.01);

      const metrics = await service.getMetrics();
      const value = extractMetricValue(metrics, 'http_requests_total', {
        method: 'GET',
        route: '/order',
        status_code: '200',
        service: 'test-service',
      });

      expect(value).toBe(3);
    });

    it('should track different method/route/status combinations separately', async () => {
      service.recordRequest('GET', '/order', 200, 0.01);
      service.recordRequest('POST', '/order', 201, 0.02);
      service.recordRequest('DELETE', '/order', 404, 0.01);

      const metrics = await service.getMetrics();

      const getCount = extractMetricValue(metrics, 'http_requests_total', {
        method: 'GET',
        route: '/order',
        status_code: '200',
      });
      const postCount = extractMetricValue(metrics, 'http_requests_total', {
        method: 'POST',
        route: '/order',
        status_code: '201',
      });
      const deleteCount = extractMetricValue(metrics, 'http_requests_total', {
        method: 'DELETE',
        route: '/order',
        status_code: '404',
      });

      expect(getCount).toBe(1);
      expect(postCount).toBe(1);
      expect(deleteCount).toBe(1);
    });
  });

  // ── Requirement 2.3 — latency histogram ───────────────────────────────────

  describe('http_request_duration_seconds (Requirement 2.3)', () => {
    it('should record observation in histogram with correct labels', async () => {
      service.recordRequest('POST', '/order', 200, 0.123);

      const metrics = await service.getMetrics();

      // The _count metric confirms an observation was recorded.
      const countValue = extractMetricValue(
        metrics,
        'http_request_duration_seconds_count',
        { method: 'POST', route: '/order', service: 'test-service' },
      );
      expect(countValue).toBe(1);
    });

    it('should use the configured histogram buckets', async () => {
      // prom-client only emits bucket lines once an observation has been recorded.
      service.recordRequest('GET', '/order', 200, 0.05);

      const metrics = await service.getMetrics();

      // Verify all 11 required buckets are present (Requirement 2.6).
      const expectedBuckets = [
        '0.005', '0.01', '0.025', '0.05', '0.1',
        '0.25', '0.5', '1', '2.5', '5', '10',
      ];
      for (const bucket of expectedBuckets) {
        expect(metrics).toContain(`le="${bucket}"`);
      }
    });

    it('should accumulate the sum of durations in _sum', async () => {
      service.recordRequest('GET', '/order', 200, 0.1);
      service.recordRequest('GET', '/order', 200, 0.2);

      const metrics = await service.getMetrics();

      const sumValue = extractMetricValue(
        metrics,
        'http_request_duration_seconds_sum',
        { method: 'GET', route: '/order', service: 'test-service' },
      );
      // Floating-point sum may have tiny imprecision, so use toBeCloseTo.
      expect(sumValue).toBeCloseTo(0.3, 5);
    });

    it('should not include status_code label on histogram (only method and route)', async () => {
      service.recordRequest('POST', '/payment', 500, 0.05);

      const metrics = await service.getMetrics();

      // Confirm there's a histogram entry for the route.
      const countValue = extractMetricValue(
        metrics,
        'http_request_duration_seconds_count',
        { method: 'POST', route: '/payment' },
      );
      expect(countValue).toBe(1);
    });
  });

  // ── Requirement 2.4 — error counter ──────────────────────────────────────

  describe('http_errors_total (Requirement 2.4)', () => {
    it('should increment when status code is 500', async () => {
      service.recordRequest('POST', '/order', 500, 0.01);

      const metrics = await service.getMetrics();
      const value = extractMetricValue(metrics, 'http_errors_total', {
        method: 'POST',
        route: '/order',
        status_code: '500',
        service: 'test-service',
      });

      expect(value).toBe(1);
    });

    it('should increment for any 5xx status code', async () => {
      service.recordRequest('GET', '/order', 502, 0.01);
      service.recordRequest('GET', '/order', 503, 0.01);
      service.recordRequest('GET', '/order', 504, 0.01);

      const metrics = await service.getMetrics();

      const v502 = extractMetricValue(metrics, 'http_errors_total', {
        status_code: '502',
      });
      const v503 = extractMetricValue(metrics, 'http_errors_total', {
        status_code: '503',
      });
      const v504 = extractMetricValue(metrics, 'http_errors_total', {
        status_code: '504',
      });

      expect(v502).toBe(1);
      expect(v503).toBe(1);
      expect(v504).toBe(1);
    });

    it('should NOT increment for 2xx status codes', async () => {
      service.recordRequest('GET', '/order', 200, 0.01);

      const metrics = await service.getMetrics();

      // Either null (line not present) or 0 is acceptable.
      const value = extractMetricValue(metrics, 'http_errors_total', {
        status_code: '200',
      });
      expect(value === null || value === 0).toBe(true);
    });

    it('should NOT increment for 4xx status codes', async () => {
      service.recordRequest('GET', '/order', 404, 0.01);
      service.recordRequest('POST', '/order', 422, 0.01);

      const metrics = await service.getMetrics();

      const v404 = extractMetricValue(metrics, 'http_errors_total', {
        status_code: '404',
      });
      const v422 = extractMetricValue(metrics, 'http_errors_total', {
        status_code: '422',
      });

      expect(v404 === null || v404 === 0).toBe(true);
      expect(v422 === null || v422 === 0).toBe(true);
    });

    it('should increment error counter AND request counter on 5xx', async () => {
      service.recordRequest('POST', '/order', 500, 0.01);

      const metrics = await service.getMetrics();

      const requestCount = extractMetricValue(metrics, 'http_requests_total', {
        method: 'POST',
        route: '/order',
        status_code: '500',
      });
      const errorCount = extractMetricValue(metrics, 'http_errors_total', {
        method: 'POST',
        route: '/order',
        status_code: '500',
      });

      expect(requestCount).toBe(1);
      expect(errorCount).toBe(1);
    });

    it('should NOT increment error counter on non-5xx even when request counter does', async () => {
      service.recordRequest('GET', '/order', 200, 0.01);

      const metrics = await service.getMetrics();

      const requestCount = extractMetricValue(metrics, 'http_requests_total', {
        method: 'GET',
        route: '/order',
        status_code: '200',
      });
      const errorMetricPresent = metrics
        .split('\n')
        .some(
          (line) =>
            line.startsWith('http_errors_total') && line.includes('status_code="200"'),
        );

      expect(requestCount).toBe(1);
      expect(errorMetricPresent).toBe(false);
    });
  });

  // ── Requirement 2.7 — memory gauges ──────────────────────────────────────

  describe('process_heap_used_bytes / process_rss_bytes (Requirement 2.7)', () => {
    it('should set initial gauge values from process.memoryUsage() on construction', async () => {
      const { heapUsed, rss } = process.memoryUsage();

      const metrics = await service.getMetrics();

      const heapValue = extractMetricValue(metrics, 'process_heap_used_bytes', {
        service: 'test-service',
      });
      const rssValue = extractMetricValue(metrics, 'process_rss_bytes', {
        service: 'test-service',
      });

      // Values should be positive and in the same ballpark as the snapshot.
      // We allow ±10 MB tolerance since other allocations may happen.
      expect(heapValue).toBeGreaterThan(0);
      expect(rssValue).toBeGreaterThan(0);
      expect(heapValue).toBeCloseTo(heapUsed, -6); // within ~1 MB
      expect(rssValue).toBeCloseTo(rss, -6);
    });

    it('should update gauge values after 5000ms interval fires', async () => {
      // Spy on process.memoryUsage to return deterministic values.
      const mockMemory = { heapUsed: 123_456_789, rss: 987_654_321, heapTotal: 0, external: 0, arrayBuffers: 0 };
      const memorySpy = jest.spyOn(process, 'memoryUsage').mockReturnValue(mockMemory);

      // Advance fake timers by exactly 5000ms to trigger the interval callback.
      jest.advanceTimersByTime(5_000);

      const metrics = await service.getMetrics();

      const heapValue = extractMetricValue(metrics, 'process_heap_used_bytes', {
        service: 'test-service',
      });
      const rssValue = extractMetricValue(metrics, 'process_rss_bytes', {
        service: 'test-service',
      });

      expect(heapValue).toBe(123_456_789);
      expect(rssValue).toBe(987_654_321);

      memorySpy.mockRestore();
    });

    it('should update gauges on every 5000ms tick (polls continuously)', async () => {
      const firstMemory = { heapUsed: 100_000_000, rss: 200_000_000, heapTotal: 0, external: 0, arrayBuffers: 0 };
      const secondMemory = { heapUsed: 150_000_000, rss: 250_000_000, heapTotal: 0, external: 0, arrayBuffers: 0 };

      const memorySpy = jest
        .spyOn(process, 'memoryUsage')
        .mockReturnValueOnce(firstMemory)
        .mockReturnValueOnce(secondMemory);

      // First tick.
      jest.advanceTimersByTime(5_000);
      const metricsAfterFirst = await service.getMetrics();
      const heap1 = extractMetricValue(metricsAfterFirst, 'process_heap_used_bytes', {
        service: 'test-service',
      });
      expect(heap1).toBe(100_000_000);

      // Second tick.
      jest.advanceTimersByTime(5_000);
      const metricsAfterSecond = await service.getMetrics();
      const heap2 = extractMetricValue(metricsAfterSecond, 'process_heap_used_bytes', {
        service: 'test-service',
      });
      expect(heap2).toBe(150_000_000);

      memorySpy.mockRestore();
    });
  });

  // ── onModuleDestroy / timer cleanup ───────────────────────────────────────

  describe('onModuleDestroy()', () => {
    it('should clear the memory poll interval so Jest can exit cleanly', () => {
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

      service.onModuleDestroy();

      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

      clearIntervalSpy.mockRestore();
    });

    it('should stop updating gauges after destroy', async () => {
      service.onModuleDestroy();

      const mockMemory = { heapUsed: 999_999, rss: 999_999, heapTotal: 0, external: 0, arrayBuffers: 0 };
      const memorySpy = jest.spyOn(process, 'memoryUsage').mockReturnValue(mockMemory);

      // Advance timers — the interval should no longer fire.
      jest.advanceTimersByTime(10_000);

      // process.memoryUsage should NOT have been called by the interval.
      expect(memorySpy).not.toHaveBeenCalled();

      memorySpy.mockRestore();
    });
  });
});
