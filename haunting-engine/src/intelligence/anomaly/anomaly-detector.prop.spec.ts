import * as fc from 'fast-check';
import type {
  MonitoredSignal,
  ServiceHealth,
  ServiceName,
  ServiceSignals,
} from '@haunted-cluster/shared';
import { loadEngineConfig } from '../../config/engine-config';
import type { AnomalyConfig } from '../../config/engine-config';
import { BREACH_BADNESS, scoreService } from '../../health/health-scoring';
import { Baseline } from './baseline';
import { detectAnomalies, zScore } from './anomaly-detector';

const NUM_RUNS = 100;

const ENGINE_CONFIG = loadEngineConfig({
  PROMETHEUS_URL: 'http://prometheus:9090',
  GATEWAY_URL: 'http://gateway:3000',
  ORDERS_URL: 'http://orders:3001',
  PAYMENTS_URL: 'http://payments:3002',
});

const CHAIN: readonly ServiceName[] = ['gateway', 'orders', 'payments'];
const SIGNALS: readonly MonitoredSignal[] = ['latencyP95Ms', 'errorRatio', 'rssMb'];
const BADNESS_KIND = { latencyP95Ms: 'latency', errorRatio: 'errors', rssMb: 'memory' } as const;

type Baselines = Record<ServiceName, Record<MonitoredSignal, Baseline>>;
type Health = Record<ServiceName, ServiceHealth>;

const MAX_BY_SIGNAL: Record<MonitoredSignal, number> = {
  latencyP95Ms: 5000,
  errorRatio: 1,
  rssMb: 600,
};

function valueArb(signal: MonitoredSignal, allowBad: boolean): fc.Arbitrary<number | null> {
  const good = fc.double({ min: 0, max: MAX_BY_SIGNAL[signal], noNaN: true });
  if (!allowBad) return good;
  return fc.oneof(
    { weight: 6, arbitrary: good },
    { weight: 1, arbitrary: fc.constantFrom<number | null>(null, NaN, Infinity, -Infinity) },
  );
}

function baselineArb(signal: MonitoredSignal, count: fc.Arbitrary<number>): fc.Arbitrary<Baseline> {
  const max = MAX_BY_SIGNAL[signal];
  return fc.record({
    mean: fc.double({ min: 0, max, noNaN: true }),
    variance: fc.double({ min: 0, max: (max * max) / 100, noNaN: true }),
    count,
  });
}

function baselinesArb(count: fc.Arbitrary<number>): fc.Arbitrary<Baselines> {
  const perService = fc.record({
    latencyP95Ms: baselineArb('latencyP95Ms', count),
    errorRatio: baselineArb('errorRatio', count),
    rssMb: baselineArb('rssMb', count),
  });
  return fc.record({ gateway: perService, orders: perService, payments: perService });
}

// ServiceHealth values go through the real scoreService, including up null/false.
function healthArb(allowBad: boolean): fc.Arbitrary<Health> {
  const up = allowBad
    ? fc.constantFrom<boolean | null>(true, true, true, false, null)
    : fc.constant<boolean | null>(true);
  const one = (service: ServiceName): fc.Arbitrary<ServiceHealth> =>
    fc
      .record({
        latencyP95Ms: valueArb('latencyP95Ms', allowBad),
        errorRatio: valueArb('errorRatio', allowBad),
        rssMb: valueArb('rssMb', allowBad),
        requestRate: fc.double({ min: 0, max: 100, noNaN: true }),
        up,
      })
      .map((s) => scoreService(service, s as ServiceSignals, ENGINE_CONFIG));
  return fc.record({ gateway: one('gateway'), orders: one('orders'), payments: one('payments') });
}

const configArb: fc.Arbitrary<AnomalyConfig> = fc.record({
  alpha: fc.constant(ENGINE_CONFIG.anomaly.alpha),
  zThreshold: fc.double({ min: 0.5, max: 6, noNaN: true }),
  warmupPolls: fc.integer({ min: 1, max: 60 }),
  confirmPolls: fc.constant(ENGINE_CONFIG.anomaly.confirmPolls),
  relearnPolls: fc.constant(ENGINE_CONFIG.anomaly.relearnPolls),
  minStdDev: fc.record({
    latencyP95Ms: fc.double({ min: 0.1, max: 50, noNaN: true }),
    errorRatio: fc.double({ min: 0.001, max: 0.05, noNaN: true }),
    rssMb: fc.double({ min: 0.1, max: 20, noNaN: true }),
  }),
});

function deepFreeze<T extends object>(o: T): T {
  Object.values(o).forEach((v) => {
    if (v && typeof v === 'object') deepFreeze(v);
  });
  return Object.freeze(o);
}

function evaluable(h: ServiceHealth, signal: MonitoredSignal): number | null {
  if (h.status === 'unknown' || h.signals.up === false) return null;
  const v = h.signals[signal];
  return v !== null && Number.isFinite(v) ? v : null;
}

function key(service: string, signal: string): string {
  return `${service}/${signal}`;
}

describe('anomaly detector properties', () => {
  // Feature: engine-intelligence, Property 8: Z-scores are finite or null and respect the floor
  // **Validates: Requirements 3.6, 3.10**
  it('Property 8: zScore is finite or null and respects the floor', () => {
    fc.assert(
      fc.property(
        baselineArb('latencyP95Ms', fc.integer({ min: 0, max: 1000 })),
        fc.double({ min: -1e300, max: 1e300, noNaN: true }),
        fc.double({ min: 1e-300, max: 1e3, noNaN: true }),
        (b, x, floor) => {
          const z = zScore(x, b, floor);
          if (z !== null) expect(Number.isFinite(z)).toBe(true);
          const expected = (x - b.mean) / Math.max(Math.sqrt(b.variance), floor);
          if (Number.isFinite(expected)) {
            expect(z).toBe(expected);
          } else {
            expect(z).toBeNull();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 8: Z-scores are finite or null and respect the floor
  // **Validates: Requirements 3.6, 3.10**
  it('Property 8: every reading has a finite or null zScore and baselineStdDev >= floor', () => {
    fc.assert(
      fc.property(
        healthArb(true),
        baselinesArb(fc.integer({ min: 0, max: 100 })),
        configArb,
        (health, baselines, config) => {
          const readings = detectAnomalies({ health, baselines }, config, CHAIN);
          for (const r of readings) {
            expect(r.zScore === null || Number.isFinite(r.zScore)).toBe(true);
            expect(r.baselineStdDev).toBeGreaterThanOrEqual(config.minStdDev[r.signal]);
            expect(Number.isFinite(r.baselineStdDev)).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 9: Warm-up flags only fixed-threshold breaches
  // **Validates: Requirements 3.3, 3.4**
  it('Property 9: during warm-up a pair is flagged iff its badness exceeds 0.2, as fixed with null z', () => {
    fc.assert(
      fc.property(healthArb(false), baselinesArb(fc.integer({ min: 0, max: 59 })), configArb, (health, baselines, base) => {
        // Every generated count is below warmupPolls.
        const config = { ...base, warmupPolls: 60 };
        const readings = detectAnomalies({ health, baselines }, config, CHAIN);

        const expected = new Set<string>();
        for (const s of CHAIN) {
          for (const sig of SIGNALS) {
            if (health[s].badness[BADNESS_KIND[sig]] > BREACH_BADNESS) expected.add(key(s, sig));
          }
        }
        expect(new Set(readings.map((r) => key(r.service, r.signal)))).toEqual(expected);
        expect(readings).toHaveLength(expected.size);
        for (const r of readings) {
          expect(r.method).toBe('fixed');
          expect(r.zScore).toBeNull();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 10: Learned flagging rule after warm-up
  // **Validates: Requirements 3.2, 3.5, 3.12**
  it('Property 10: after warm-up a pair is flagged iff value > mean and z > threshold, regardless of breaches', () => {
    fc.assert(
      fc.property(
        healthArb(false),
        baselinesArb(fc.integer({ min: 30, max: 200 })),
        configArb,
        (health, baselines, base) => {
          const config = { ...base, warmupPolls: 30 };
          const readings = detectAnomalies({ health, baselines }, config, CHAIN);

          const expected = new Map<string, number>();
          for (const s of CHAIN) {
            for (const sig of SIGNALS) {
              const x = evaluable(health[s], sig);
              if (x === null) continue;
              const b = baselines[s][sig];
              const z = (x - b.mean) / Math.max(Math.sqrt(b.variance), config.minStdDev[sig]);
              if (x > b.mean && z > config.zThreshold) expected.set(key(s, sig), z);
            }
          }
          expect(readings).toHaveLength(expected.size);
          for (const r of readings) {
            expect(r.method).toBe('learned');
            expect(r.value).toBeGreaterThan(r.baselineMean);
            expect(r.zScore).toBe(expected.get(key(r.service, r.signal)));
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 10: Learned flagging rule after warm-up
  // **Validates: Requirements 3.5, 3.12**
  it('Property 10: a breached value with a small z-score is not flagged after warm-up', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1000, max: 5000, noNaN: true }),
        configArb,
        (latency, base) => {
          // The baseline already sits at the breaching level, so z is about 0.
          const config = { ...base, warmupPolls: 30 };
          const flat: Baseline = { mean: latency, variance: 0, count: 100 };
          const mk = (sig: MonitoredSignal): Baseline =>
            sig === 'latencyP95Ms' ? flat : { mean: 0, variance: 0, count: 100 };
          const perService = { latencyP95Ms: mk('latencyP95Ms'), errorRatio: mk('errorRatio'), rssMb: mk('rssMb') };
          const baselines: Baselines = { gateway: perService, orders: perService, payments: perService };
          const signals: ServiceSignals = {
            requestRate: 1,
            errorRatio: 0,
            latencyP95Ms: latency,
            rssMb: 0,
            up: true,
          };
          const health = {
            gateway: scoreService('gateway', signals, ENGINE_CONFIG),
            orders: scoreService('orders', signals, ENGINE_CONFIG),
            payments: scoreService('payments', signals, ENGINE_CONFIG),
          };
          expect(health.gateway.badness.latency).toBeGreaterThan(BREACH_BADNESS);
          const readings = detectAnomalies({ health, baselines }, config, CHAIN);
          expect(readings.filter((r) => r.signal === 'latencyP95Ms')).toHaveLength(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 11: Nothing evaluable, nothing flagged
  // **Validates: Requirements 3.1, 3.7, 3.8, 3.9**
  it('Property 11: unknown, down and non-finite pairs never produce a reading', () => {
    fc.assert(
      fc.property(
        healthArb(true),
        baselinesArb(fc.integer({ min: 0, max: 100 })),
        configArb,
        (health, baselines, config) => {
          const frozenHealth = deepFreeze(health);
          const frozenBaselines = deepFreeze(baselines);
          const readings = detectAnomalies(
            { health: frozenHealth, baselines: frozenBaselines },
            config,
            CHAIN,
          );
          for (const r of readings) {
            expect(evaluable(health[r.service], r.signal)).not.toBeNull();
          }
          // Reading order: chain order, then signal order.
          const order = readings.map(
            (r) => CHAIN.indexOf(r.service) * SIGNALS.length + SIGNALS.indexOf(r.signal),
          );
          expect(order).toEqual([...order].sort((a, b) => a - b));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 11: Nothing evaluable, nothing flagged
  // **Validates: Requirements 3.1, 3.7, 3.8, 3.9**
  it('Property 11: a cluster with nothing evaluable yields no readings', () => {
    const badValue = fc.constantFrom<number | null>(null, NaN, Infinity, -Infinity);
    fc.assert(
      fc.property(
        baselinesArb(fc.integer({ min: 0, max: 100 })),
        configArb,
        fc.constantFrom<boolean | null>(true, false, null),
        badValue,
        (baselines, config, up, bad) => {
          const mk = (service: ServiceName): ServiceHealth =>
            scoreService(
              service,
              up === true
                ? { requestRate: null, errorRatio: bad, latencyP95Ms: bad, rssMb: bad, up }
                : { requestRate: 1, errorRatio: 1, latencyP95Ms: 5000, rssMb: 600, up },
              ENGINE_CONFIG,
            );
          const health = { gateway: mk('gateway'), orders: mk('orders'), payments: mk('payments') };
          expect(detectAnomalies({ health, baselines }, config, CHAIN)).toEqual([]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
