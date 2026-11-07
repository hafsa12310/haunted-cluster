/**
 * The five instant PromQL queries a Poll runs, one per signal.
 *
 * `up` is labelled by Prometheus's `job`, everything else by the victim app's
 * `service` label; this relies on each `job_name` in prometheus.yml matching
 * its service name.
 *
 * Requirements: 2.2, 2.3
 */

import type { EngineConfig } from '../config/engine-config';

export interface PromQueries {
  /** Requests per second, by `service`. */
  requestRate: string;
  /** 5xx responses per second, by `service`. */
  errorRate: string;
  /** p95 request latency in seconds, by `service`. */
  latencyP95Seconds: string;
  /** Resident memory in bytes, by `service`. */
  rssBytes: string;
  /** Scrape health (1 or 0), by `job`. */
  up: string;
}

export function buildQueries(config: Pick<EngineConfig, 'rateWindow' | 'serviceChain'>): PromQueries {
  const w = config.rateWindow;
  const jobs = config.serviceChain.map(regexLiteral).join('|');
  return {
    requestRate: `sum by (service) (rate(http_requests_total[${w}]))`,
    errorRate: `sum by (service) (rate(http_errors_total[${w}]))`,
    latencyP95Seconds: `histogram_quantile(0.95, sum by (service, le) (rate(http_request_duration_seconds_bucket[${w}])))`,
    rssBytes: 'max by (service) (process_rss_bytes)',
    up: `up{job=~"${promqlString(jobs)}"}`,
  };
}

/** Matches `name` literally inside a Prometheus (RE2) regex. */
function regexLiteral(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escapes text for use inside a double-quoted PromQL string. */
function promqlString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
