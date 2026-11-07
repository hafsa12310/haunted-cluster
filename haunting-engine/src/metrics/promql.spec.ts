import { loadEngineConfig } from '../config/engine-config';
import { buildQueries, PromQueries } from './promql';

const DEFAULT_CONFIG = loadEngineConfig({
  PROMETHEUS_URL: 'http://prometheus:9090',
  GATEWAY_URL: 'http://gateway:3000',
  ORDERS_URL: 'http://orders:3001',
  PAYMENTS_URL: 'http://payments:3002',
});

describe('buildQueries', () => {
  it('builds the five queries from design.md for the default config (Requirements 2.2, 2.3)', () => {
    expect(buildQueries(DEFAULT_CONFIG)).toEqual<PromQueries>({
      requestRate: 'sum by (service) (rate(http_requests_total[15s]))',
      errorRate: 'sum by (service) (rate(http_errors_total[15s]))',
      latencyP95Seconds:
        'histogram_quantile(0.95, sum by (service, le) (rate(http_request_duration_seconds_bucket[15s])))',
      rssBytes: 'max by (service) (process_rss_bytes)',
      up: 'up{job=~"gateway|orders|payments"}',
    });
  });

  it('uses RATE_WINDOW for every rate() and SERVICE_CHAIN for the up matcher', () => {
    expect(buildQueries({ rateWindow: '2m', serviceChain: ['checkout-api', 'billing'] })).toEqual<PromQueries>({
      requestRate: 'sum by (service) (rate(http_requests_total[2m]))',
      errorRate: 'sum by (service) (rate(http_errors_total[2m]))',
      latencyP95Seconds:
        'histogram_quantile(0.95, sum by (service, le) (rate(http_request_duration_seconds_bucket[2m])))',
      rssBytes: 'max by (service) (process_rss_bytes)',
      up: 'up{job=~"checkout-api|billing"}',
    });
  });

  it('handles a single-service chain', () => {
    expect(buildQueries({ rateWindow: '15s', serviceChain: ['gateway'] }).up).toBe('up{job=~"gateway"}');
  });

  it('escapes service names so they match literally and keep the query valid', () => {
    // SERVICE_CHAIN entries aren't restricted, so regex characters must not widen
    // the match and quotes or backslashes must not break the string.
    const { up } = buildQueries({ rateWindow: '15s', serviceChain: ['api.v2', 'a|b', 'say"hi', 'back\\slash'] });
    expect(up).toBe('up{job=~"api\\\\.v2|a\\\\|b|say\\"hi|back\\\\\\\\slash"}');
  });
});
