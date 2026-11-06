import * as fc from 'fast-check';
import type {
  ServiceHealth,
  ServiceSignals,
  ServiceStatus,
  SignalKind,
} from '@haunted-cluster/shared';
import { EngineConfig, loadEngineConfig, Thresholds } from '../config/engine-config';
import { badness, clusterDread, scoreService } from './health-scoring';

const NUM_RUNS = 200;

/** Any finite double. `loadEngineConfig` only ever produces finite thresholds. */
const finiteDouble = fc.double({ noNaN: true, noDefaultInfinity: true });

/** Threshold pairs from `fc.tuple(fc.double(), fc.double())`, filtered to `ok < critical`. */
const thresholdsArb: fc.Arbitrary<Thresholds> = fc
  .tuple(finiteDouble, finiteDouble)
  .filter(([ok, critical]) => ok < critical)
  .map(([ok, critical]) => ({ ok, critical }));

/** Two finite values, sorted so that `a ≤ b`. */
const sortedPairArb = fc
  .tuple(finiteDouble, finiteDouble)
  .map(([x, y]): [number, number] => (x <= y ? [x, y] : [y, x]));

describe('badness — property-based tests (Property 1)', () => {
  // Feature: haunting-engine, Property 1: Badness is bounded and monotonic
  it('Property 1: badness(a) and badness(b) lie in [0, 1] and badness(a) ≤ badness(b) for a ≤ b', () => {
    fc.assert(
      fc.property(thresholdsArb, sortedPairArb, (t, [a, b]) => {
        const ba = badness(a, t);
        const bb = badness(b, t);
        expect(ba).toBeGreaterThanOrEqual(0);
        expect(ba).toBeLessThanOrEqual(1);
        expect(bb).toBeGreaterThanOrEqual(0);
        expect(bb).toBeLessThanOrEqual(1);
        expect(ba).toBeLessThanOrEqual(bb);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 1: Badness is bounded and monotonic
  it('Property 1: badness(null) is 0', () => {
    fc.assert(
      fc.property(thresholdsArb, (t) => {
        expect(badness(null, t)).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 1: Badness is bounded and monotonic
  it('Property 1: badness is 0 at or below OK and 1 at or above CRITICAL', () => {
    fc.assert(
      fc.property(thresholdsArb, finiteDouble, (t, value) => {
        if (value <= t.ok) expect(badness(value, t)).toBe(0);
        if (value >= t.critical) expect(badness(value, t)).toBe(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 1: Badness is bounded and monotonic
  it('Property 1: holds for values drawn from inside the threshold range', () => {
    // Unconstrained doubles rarely land between OK and CRITICAL, so this run
    // places both values inside the range on purpose.
    fc.assert(
      fc.property(
        thresholdsArb,
        fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true })),
        (t, [x, y]) => {
          const [lo, hi] = x <= y ? [x, y] : [y, x];
          // Interpolating as ok·(1−f) + critical·f avoids overflowing on extreme thresholds.
          const a = t.ok * (1 - lo) + t.critical * lo;
          const b = t.ok * (1 - hi) + t.critical * hi;
          fc.pre(Number.isFinite(a) && Number.isFinite(b) && a <= b);
          const ba = badness(a, t);
          const bb = badness(b, t);
          expect(ba).toBeGreaterThanOrEqual(0);
          expect(bb).toBeLessThanOrEqual(1);
          expect(ba).toBeLessThanOrEqual(bb);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 1: Badness is bounded and monotonic
  it('Property 1: holds when CRITICAL − OK overflows to Infinity', () => {
    // Random doubles only occasionally produce a span this wide, so generate it directly.
    const extremeThresholdsArb = fc.record({
      ok: fc.double({ max: -Number.MAX_VALUE / 2, noNaN: true, noDefaultInfinity: true }),
      critical: fc.double({ min: Number.MAX_VALUE / 2, noNaN: true, noDefaultInfinity: true }),
    });
    fc.assert(
      fc.property(extremeThresholdsArb, sortedPairArb, (t, [a, b]) => {
        fc.pre(!Number.isFinite(t.critical - t.ok));
        const ba = badness(a, t);
        const bb = badness(b, t);
        expect(ba).toBeGreaterThanOrEqual(0);
        expect(bb).toBeLessThanOrEqual(1);
        expect(ba).toBeLessThanOrEqual(bb);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

const DEFAULT_CONFIG = loadEngineConfig({
  PROMETHEUS_URL: 'http://prometheus:9090',
  GATEWAY_URL: 'http://gateway:3000',
  ORDERS_URL: 'http://orders:3001',
  PAYMENTS_URL: 'http://payments:3002',
});

/** A non-negative signal value, biased towards the threshold boundaries where status flips. */
function signalValueArb(t: Thresholds, max: number): fc.Arbitrary<number> {
  const span = t.critical - t.ok;
  return fc.oneof(
    fc.double({ min: 0, max, noNaN: true }),
    fc.constantFrom(t.ok, t.critical, t.ok + 0.2 * span, t.ok + 0.6 * span),
  );
}

/** `ServiceSignals` with each field from `fc.option(...)` and `up` from true / false / null. */
function signalsArb(config: EngineConfig): fc.Arbitrary<ServiceSignals> {
  return fc.record({
    requestRate: fc.option(fc.double({ min: 0, max: 1000, noNaN: true })),
    errorRatio: fc.option(signalValueArb(config.errorRatio, 1)),
    latencyP95Ms: fc.option(signalValueArb(config.latencyMs, 20_000)),
    rssMb: fc.option(signalValueArb(config.memoryMb, 1000)),
    up: fc.constantFrom(true, false, null),
  });
}

/** Positive threshold pairs with `ok < critical`, so scoring also runs against non-default config. */
function positiveThresholdsArb(max: number): fc.Arbitrary<Thresholds> {
  return fc
    .tuple(fc.double({ min: 0, max, noNaN: true }), fc.double({ min: 0, max, noNaN: true }))
    .filter(([x, y]) => x !== y)
    .map(([x, y]) => ({ ok: Math.min(x, y), critical: Math.max(x, y) }));
}

const configArb: fc.Arbitrary<EngineConfig> = fc.oneof(
  fc.constant(DEFAULT_CONFIG),
  fc.record({
    latencyMs: positiveThresholdsArb(5000),
    errorRatio: positiveThresholdsArb(1),
    memoryMb: positiveThresholdsArb(500),
  }).map((thresholds) => ({ ...DEFAULT_CONFIG, ...thresholds })),
);

const configAndSignalsArb = configArb.chain((config) =>
  fc.tuple(fc.constant(config), signalsArb(config)),
);

/** Status from `maxBadness` per Requirement 3.5, written independently of the implementation. */
function expectedStatus(maxB: number): ServiceStatus {
  if (maxB <= 0.2) return 'healthy';
  if (maxB <= 0.6) return 'degraded';
  return 'critical';
}

describe('scoreService — property-based tests (Property 2)', () => {
  // Feature: haunting-engine, Property 2: Score, status and breached kinds are consistent
  it('Property 2: badness is computed per kind from the configured thresholds', () => {
    fc.assert(
      fc.property(configAndSignalsArb, ([config, s]) => {
        const health = scoreService('orders', s, config);
        expect(health.service).toBe('orders');
        expect(health.signals).toEqual(s);
        expect(health.badness).toEqual({
          latency: badness(s.latencyP95Ms, config.latencyMs),
          errors: badness(s.errorRatio, config.errorRatio),
          memory: badness(s.rssMb, config.memoryMb),
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 2: Score, status and breached kinds are consistent
  it('Property 2: up === null gives unknown, a null score and no breached kinds', () => {
    fc.assert(
      fc.property(configAndSignalsArb, ([config, s]) => {
        const health = scoreService('orders', { ...s, up: null }, config);
        expect(health.status).toBe('unknown');
        expect(health.score).toBeNull();
        expect(health.breachedKinds).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 2: Score, status and breached kinds are consistent
  it("Property 2: up === false gives down, score 0 and ['down']", () => {
    fc.assert(
      fc.property(configAndSignalsArb, ([config, s]) => {
        const health = scoreService('orders', { ...s, up: false }, config);
        expect(health.status).toBe('down');
        expect(health.score).toBe(0);
        expect(health.breachedKinds).toEqual(['down']);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 2: Score, status and breached kinds are consistent
  it('Property 2: when up, score, status and breached kinds all follow from maxBadness', () => {
    fc.assert(
      fc.property(configAndSignalsArb, ([config, s]) => {
        const health = scoreService('orders', { ...s, up: true }, config);
        const b = health.badness;
        const maxB = Math.max(b.latency, b.errors, b.memory);

        expect(Number.isInteger(health.score)).toBe(true);
        expect(health.score).toBeGreaterThanOrEqual(0);
        expect(health.score).toBeLessThanOrEqual(100);
        expect(health.score).toBe(Math.round(100 * (1 - maxB)));

        expect(health.status).toBe(expectedStatus(maxB));

        const expectedKinds: SignalKind[] = [];
        if (b.errors > 0.2) expectedKinds.push('errors');
        if (b.latency > 0.2) expectedKinds.push('latency');
        if (b.memory > 0.2) expectedKinds.push('memory');
        expect(health.breachedKinds).toEqual(expectedKinds);

        expect(health.status === 'healthy').toBe(health.breachedKinds.length === 0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 2: Score, status and breached kinds are consistent
  it('Property 2: never healthy unless up is true', () => {
    fc.assert(
      fc.property(configAndSignalsArb, ([config, s]) => {
        const health = scoreService('orders', s, config);
        if (s.up !== true) expect(health.status).not.toBe('healthy');
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

const unitArb = fc.double({ min: 0, max: 1, noNaN: true });

/**
 * Any well-formed `ServiceHealth`, not only ones `scoreService` would produce,
 * so `clusterDread` is checked on status and badness alone.
 */
const arbitraryHealthArb: fc.Arbitrary<ServiceHealth> = fc.record({
  service: fc.constantFrom('gateway', 'orders', 'payments', 'checkout-api'),
  status: fc.constantFrom<ServiceStatus>('healthy', 'degraded', 'critical', 'down', 'unknown'),
  score: fc.option(fc.integer({ min: 0, max: 100 })),
  signals: fc.constant<ServiceSignals>({
    requestRate: null,
    errorRatio: null,
    latencyP95Ms: null,
    rssMb: null,
    up: null,
  }),
  badness: fc.record({ latency: unitArb, errors: unitArb, memory: unitArb }),
  breachedKinds: fc.constant<SignalKind[]>([]),
});

/** `ServiceHealth` as `scoreService` actually produces it. */
const scoredHealthArb: fc.Arbitrary<ServiceHealth> = configAndSignalsArb.map(([config, s]) =>
  scoreService('orders', s, config),
);

const healthListArb = fc.array(fc.oneof(arbitraryHealthArb, scoredHealthArb), { maxLength: 8 });

/** Dread per Requirement 3.7, written independently of the implementation. */
function expectedDread(services: ServiceHealth[]): number {
  const contributions = services
    .filter((h) => h.status !== 'unknown')
    .map((h) =>
      h.status === 'down' ? 1 : Math.max(h.badness.latency, h.badness.errors, h.badness.memory),
    );
  return contributions.length === 0 ? 0 : Math.max(...contributions);
}

describe('clusterDread — property-based tests (Property 3)', () => {
  // Feature: haunting-engine, Property 3: Dread is the worst badness
  it('Property 3: dread is in [0, 1] and equals the worst maxBadness', () => {
    fc.assert(
      fc.property(healthListArb, (services) => {
        const dread = clusterDread(services);
        expect(dread).toBeGreaterThanOrEqual(0);
        expect(dread).toBeLessThanOrEqual(1);
        expect(dread).toBe(expectedDread(services));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 3: Dread is the worst badness
  it('Property 3: dread is 1 when any service is down, whatever its badness', () => {
    fc.assert(
      fc.property(
        healthListArb,
        arbitraryHealthArb,
        fc.nat(),
        (services, down, at) => {
          const list = [...services];
          list.splice(at % (list.length + 1), 0, { ...down, status: 'down' });
          expect(clusterDread(list)).toBe(1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 3: Dread is the worst badness
  it('Property 3: unknown services are ignored, whatever their badness', () => {
    fc.assert(
      fc.property(
        healthListArb,
        fc.array(arbitraryHealthArb, { minLength: 1, maxLength: 4 }),
        (services, unknowns) => {
          const withUnknowns = [
            ...services,
            ...unknowns.map((h): ServiceHealth => ({ ...h, status: 'unknown' })),
          ];
          expect(clusterDread(withUnknowns)).toBe(clusterDread(services));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 3: Dread is the worst badness
  it('Property 3: dread is 0 when no service contributes', () => {
    fc.assert(
      fc.property(fc.array(arbitraryHealthArb, { maxLength: 4 }), (services) => {
        const allUnknown = services.map((h): ServiceHealth => ({ ...h, status: 'unknown' }));
        expect(clusterDread(allUnknown)).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
