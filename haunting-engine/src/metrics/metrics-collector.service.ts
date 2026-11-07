/**
 * Runs the five PromQL queries for a Poll and combines them into raw signals
 * per service. Any query failing fails the whole collection, so a Poll never
 * mixes fresh and missing data.
 *
 * Requirements: 2.2, 2.4, 2.5, 2.6
 */

import { Inject, Injectable } from '@nestjs/common';
import type { ServiceName, ServiceSignals } from '@haunted-cluster/shared';
import { ENGINE_CONFIG } from '../config/config.module';
import type { EngineConfig } from '../config/engine-config';
import { PrometheusClient } from './prometheus.client';
import { buildQueries, PromQueries } from './promql';

const BYTES_PER_MB = 1_048_576;

@Injectable()
export class MetricsCollectorService {
  private readonly queries: PromQueries;

  constructor(
    @Inject(ENGINE_CONFIG) private readonly config: EngineConfig,
    private readonly prometheus: PrometheusClient,
  ) {
    this.queries = buildQueries(config);
  }

  /** Rejects with the first query's `MetricsUnavailableError` if any query fails. */
  async collect(): Promise<Record<ServiceName, ServiceSignals>> {
    const q = this.queries;
    const [rate, errors, p95, rss, up] = await Promise.all([
      this.prometheus.query(q.requestRate, 'service'),
      this.prometheus.query(q.errorRate, 'service'),
      this.prometheus.query(q.latencyP95Seconds, 'service'),
      this.prometheus.query(q.rssBytes, 'service'),
      this.prometheus.query(q.up, 'job'),
    ]);

    const signals: Record<ServiceName, ServiceSignals> = {};
    for (const service of this.config.serviceChain) {
      const requestRate = rate.get(service) ?? null;
      // No http_errors_total series until a service's first 5xx (Requirement 2.5).
      const errorRate = errors.has(service)
        ? (errors.get(service) ?? null)
        : requestRate !== null
          ? 0
          : null;
      const latencySeconds = p95.get(service) ?? null;
      const rssBytes = rss.get(service) ?? null;

      signals[service] = {
        requestRate,
        // Requirement 2.4: no ratio without traffic.
        errorRatio:
          requestRate !== null && requestRate > 0 && errorRate !== null
            ? errorRate / requestRate
            : null,
        latencyP95Ms: latencySeconds !== null ? latencySeconds * 1000 : null,
        rssMb: rssBytes !== null ? rssBytes / BYTES_PER_MB : null,
        up: up.has(service) ? up.get(service) === 1 : null,
      };
    }
    return signals;
  }
}
