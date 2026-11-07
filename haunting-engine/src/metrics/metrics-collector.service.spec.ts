import type { ServiceSignals } from '@haunted-cluster/shared';
import { loadEngineConfig } from '../config/engine-config';
import { MetricsCollectorService } from './metrics-collector.service';
import { LabelKey, MetricsUnavailableError, PrometheusClient, Vector } from './prometheus.client';
import { buildQueries, PromQueries } from './promql';

const CONFIG = loadEngineConfig({
  PROMETHEUS_URL: 'http://prometheus:9090',
  GATEWAY_URL: 'http://gateway:3000',
  ORDERS_URL: 'http://orders:3001',
  PAYMENTS_URL: 'http://payments:3002',
});

const QUERIES = buildQueries(CONFIG);

type Samples = Record<string, number | null>;

/** What each of the five queries returns; any omitted query returns an empty vector. */
type Answers = Partial<Record<keyof PromQueries, Samples | Error>>;

/** A collector backed by a fake client that answers each query from `answers`. */
function collectorWith(answers: Answers) {
  const query = jest.fn(async (promql: string, _labelKey: LabelKey): Promise<Vector> => {
    const name = (Object.keys(QUERIES) as (keyof PromQueries)[]).find((k) => QUERIES[k] === promql);
    if (!name) throw new Error(`unexpected query: ${promql}`);
    const answer = answers[name] ?? {};
    if (answer instanceof Error) throw answer;
    return new Map(Object.entries(answer));
  });
  const client = { query } as unknown as PrometheusClient;
  return { collector: new MetricsCollectorService(CONFIG, client), query };
}

const NO_SIGNALS: ServiceSignals = {
  requestRate: null,
  errorRatio: null,
  latencyP95Ms: null,
  rssMb: null,
  up: null,
};

describe('MetricsCollectorService', () => {
  it('runs the five queries from buildQueries, with up keyed by job and the rest by service', async () => {
    const { collector, query } = collectorWith({});

    await collector.collect();

    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls).toEqual(
      expect.arrayContaining([
        [QUERIES.requestRate, 'service'],
        [QUERIES.errorRate, 'service'],
        [QUERIES.latencyP95Seconds, 'service'],
        [QUERIES.rssBytes, 'service'],
        [QUERIES.up, 'job'],
      ]),
    );
  });

  it('returns signals for every service in the chain, and only those', async () => {
    const { collector } = collectorWith({
      requestRate: { gateway: 5, 'not-in-chain': 99 },
      up: { gateway: 1, 'not-in-chain': 1 },
    });

    const signals = await collector.collect();

    expect(Object.keys(signals)).toEqual(['gateway', 'orders', 'payments']);
  });

  it('gives all-null signals for a service Prometheus knows nothing about', async () => {
    const { collector } = collectorWith({});

    const signals = await collector.collect();

    expect(signals.orders).toEqual(NO_SIGNALS);
  });

  describe('error ratio (Requirements 2.4, 2.5)', () => {
    it('divides the error rate by the request rate', async () => {
      const { collector } = collectorWith({
        requestRate: { orders: 8 },
        errorRate: { orders: 2 },
      });

      expect((await collector.collect()).orders.errorRatio).toBe(0.25);
    });

    it('treats a missing error series as 0 when there is traffic', async () => {
      const { collector } = collectorWith({ requestRate: { orders: 8 } });

      expect((await collector.collect()).orders.errorRatio).toBe(0);
    });

    it('is null when the request rate is zero', async () => {
      const { collector } = collectorWith({
        requestRate: { orders: 0 },
        errorRate: { orders: 0 },
      });

      expect((await collector.collect()).orders.errorRatio).toBeNull();
    });

    it('is null when the request rate is missing, even with an error series', async () => {
      const { collector } = collectorWith({ errorRate: { orders: 1 } });

      const { orders } = await collector.collect();
      expect(orders.requestRate).toBeNull();
      expect(orders.errorRatio).toBeNull();
    });

    it('is null when the request rate sample is unparseable', async () => {
      const { collector } = collectorWith({
        requestRate: { orders: null },
        errorRate: { orders: 1 },
      });

      expect((await collector.collect()).orders.errorRatio).toBeNull();
    });

    it('is null, not 0, when the error series exists but its sample is unparseable', async () => {
      const { collector } = collectorWith({
        requestRate: { orders: 8 },
        errorRate: { orders: null },
      });

      expect((await collector.collect()).orders.errorRatio).toBeNull();
    });
  });

  describe('unit conversions (Requirement 2.2)', () => {
    it('converts p95 latency from seconds to milliseconds', async () => {
      const { collector } = collectorWith({ latencyP95Seconds: { orders: 0.25, payments: 10 } });

      const signals = await collector.collect();
      expect(signals.orders.latencyP95Ms).toBe(250);
      expect(signals.payments.latencyP95Ms).toBe(10_000);
    });

    it('converts RSS from bytes to MiB', async () => {
      const { collector } = collectorWith({ rssBytes: { orders: 125_829_120, payments: 1_572_864 } });

      const signals = await collector.collect();
      expect(signals.orders.rssMb).toBe(120);
      expect(signals.payments.rssMb).toBe(1.5);
    });

    it('passes the request rate through unchanged', async () => {
      const { collector } = collectorWith({ requestRate: { orders: 3.75 } });

      expect((await collector.collect()).orders.requestRate).toBe(3.75);
    });

    it('keeps unparseable latency and RSS samples as null (Requirement 2.6)', async () => {
      const { collector } = collectorWith({
        latencyP95Seconds: { orders: null },
        rssBytes: { orders: null },
      });

      const { orders } = await collector.collect();
      expect(orders.latencyP95Ms).toBeNull();
      expect(orders.rssMb).toBeNull();
    });
  });

  describe('up (Requirements 2.2, 11.3)', () => {
    it('is true for 1, false for 0, and null when the job has no sample', async () => {
      const { collector } = collectorWith({ up: { gateway: 1, orders: 0 } });

      const signals = await collector.collect();
      expect(signals.gateway.up).toBe(true);
      expect(signals.orders.up).toBe(false);
      expect(signals.payments.up).toBeNull();
    });

    it('is false when the up sample is unparseable', async () => {
      const { collector } = collectorWith({ up: { orders: null } });

      expect((await collector.collect()).orders.up).toBe(false);
    });
  });

  it('combines every signal for a busy, partly failing service', async () => {
    const { collector } = collectorWith({
      requestRate: { gateway: 20 },
      errorRate: { gateway: 3 },
      latencyP95Seconds: { gateway: 0.48 },
      rssBytes: { gateway: 157_286_400 },
      up: { gateway: 1 },
    });

    expect((await collector.collect()).gateway).toEqual<ServiceSignals>({
      requestRate: 20,
      errorRatio: 0.15,
      latencyP95Ms: 480,
      rssMb: 150,
      up: true,
    });
  });

  describe('failures (Requirement 11.1)', () => {
    it.each(Object.keys(QUERIES) as (keyof PromQueries)[])(
      'rejects with the client error when the %s query fails',
      async (failing) => {
        const failure = new MetricsUnavailableError(`${failing} failed`);
        const { collector } = collectorWith({
          requestRate: { orders: 1 },
          up: { orders: 1 },
          [failing]: failure,
        });

        await expect(collector.collect()).rejects.toBe(failure);
      },
    );
  });
});
