import { Injectable, OnModuleDestroy, Inject } from '@nestjs/common';
import {
  Registry,
  Counter,
  Histogram,
  Gauge,
} from 'prom-client';
import { parseMemoryGaugeIntervalMs } from '@app/common';

export const METRICS_SERVICE_NAME = 'METRICS_SERVICE_NAME';

/**
 * MetricsService
 *
 * Owns a dedicated prom-client Registry (not the global default) for test
 * isolation.  All four metric families are registered on construction and
 * labelled with `service` via prom-client default labels.
 *
 * Implements OnModuleDestroy to clear the memory-usage polling timer so
 * Jest can shut down cleanly after every test suite.
 */
@Injectable()
export class MetricsService implements OnModuleDestroy {
  private readonly registry: Registry;

  private readonly requestCounter: Counter<string>;
  private readonly requestDuration: Histogram<string>;
  private readonly errorCounter: Counter<string>;
  private readonly heapGauge: Gauge<string>;
  private readonly rssGauge: Gauge<string>;

  private readonly memoryPollTimer: NodeJS.Timeout;

  constructor(@Inject(METRICS_SERVICE_NAME) serviceName: string) {
    this.registry = new Registry();

    // Set the service name as a default label so every metric automatically
    // carries it — callers of recordRequest do not need to pass it.
    this.registry.setDefaultLabels({ service: serviceName });

    // ── Counters ──────────────────────────────────────────────────────────
    this.requestCounter = new Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status_code', 'service'],
      registers: [this.registry],
    });

    this.errorCounter = new Counter({
      name: 'http_errors_total',
      help: 'Total number of HTTP 5xx error responses',
      labelNames: ['method', 'route', 'status_code', 'service'],
      registers: [this.registry],
    });

    // ── Histogram ─────────────────────────────────────────────────────────
    this.requestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'service'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    // ── Memory gauges ─────────────────────────────────────────────────────
    this.heapGauge = new Gauge({
      name: 'process_heap_used_bytes',
      help: 'Node.js heap used in bytes',
      labelNames: ['service'],
      registers: [this.registry],
    });

    this.rssGauge = new Gauge({
      name: 'process_rss_bytes',
      help: 'Node.js resident set size in bytes',
      labelNames: ['service'],
      registers: [this.registry],
    });

    // Seed gauges immediately so the first /metrics scrape has data.
    this.updateMemoryGauges();

    // Poll at the configured interval (MEMORY_GAUGE_INTERVAL_MS, default 1000 ms).
    const intervalMs = parseMemoryGaugeIntervalMs(
      process.env.MEMORY_GAUGE_INTERVAL_MS,
    );
    this.memoryPollTimer = setInterval(
      () => this.updateMemoryGauges(),
      intervalMs,
    );
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  onModuleDestroy(): void {
    clearInterval(this.memoryPollTimer);
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Returns the Prometheus text-format metrics string from this service's
   * private registry.
   *
   * Requirements: 2.1
   */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Records a completed HTTP request.
   *
   * - Always increments `http_requests_total`.
   * - Always observes `http_request_duration_seconds`.
   * - Increments `http_errors_total` only when `statusCode >= 500`.
   *
   * Requirements: 2.2, 2.3, 2.4
   */
  recordRequest(
    method: string,
    route: string,
    statusCode: number,
    durationSeconds: number,
  ): void {
    const labels = { method, route, status_code: String(statusCode) };

    this.requestCounter.inc(labels);
    this.requestDuration.observe({ method, route }, durationSeconds);

    if (statusCode >= 500) {
      this.errorCounter.inc(labels);
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private updateMemoryGauges(): void {
    const { heapUsed, rss } = process.memoryUsage();
    this.heapGauge.set(heapUsed);
    this.rssGauge.set(rss);
  }
}
