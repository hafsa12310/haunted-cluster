import * as fc from 'fast-check';
import type { AnomalyReading, MonitoredSignal, ServiceHealth } from '@haunted-cluster/shared';
import { loadEngineConfig } from '../../config/engine-config';
import type { Baseline, BaselineMap, PairObservation } from '../intelligence-types';
import { learnBaselines, type LearningInput } from './anomaly-learning';

const CONFIG = loadEngineConfig({
  PROMETHEUS_URL: 'http://prometheus:9090',
  GATEWAY_URL: 'http://gateway:3000',
  ORDERS_URL: 'http://orders:3001',
  PAYMENTS_URL: 'http://payments:3002',
});
const CHAIN = CONFIG.serviceChain;
const SIGNALS: MonitoredSignal[] = ['latencyP95Ms', 'errorRatio', 'rssMb'];

const baselineArb: fc.Arbitrary<Baseline> = fc.record({
  mean: fc.double({ min: -1e6, max: 1e6, noNaN: true }),
  variance: fc.double({ min: 0, max: 1e6, noNaN: true }),
  count: fc.integer({ min: 0, max: 1000 }),
});

const valueArb: fc.Arbitrary<number | null> = fc.oneof(
  fc.double({ min: 0, max: 1e6, noNaN: true }),
  fc.constant(null),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
);

const statusArb = fc.constantFrom<ServiceHealth['status']>('healthy', 'degraded', 'critical', 'down', 'unknown');

const serviceArb = fc.record({
  status: statusArb,
  up: fc.option(fc.boolean(), { nil: null }),
  values: fc.record({ latencyP95Ms: valueArb, errorRatio: valueArb, rssMb: valueArb }),
  open: fc.boolean(),
  baselines: fc.record({ latencyP95Ms: baselineArb, errorRatio: baselineArb, rssMb: baselineArb }),
  // 0 = unusable, 1 = evaluated with null reading, 2 = evaluated with a Raw_Anomaly
  obs: fc.record({
    latencyP95Ms: fc.constantFrom(0, 1, 2),
    errorRatio: fc.constantFrom(0, 1, 2),
    rssMb: fc.constantFrom(0, 1, 2),
  }),
});

const scenarioArb = fc.record({
  metricsAvailable: fc.boolean(),
  services: fc.array(serviceArb, { minLength: CHAIN.length, maxLength: CHAIN.length }),
});

type Scenario = typeof scenarioArb extends fc.Arbitrary<infer T> ? T : never;

function build(s: Scenario): { baselines: BaselineMap; input: LearningInput } {
  const baselines = {} as BaselineMap;
  const health = {} as Record<string, ServiceHealth>;
  const openBefore = {} as Record<string, boolean>;
  const observations: PairObservation[] = [];
  CHAIN.forEach((name, i) => {
    const g = s.services[i];
    baselines[name] = g.baselines;
    openBefore[name] = g.open;
    health[name] = {
      service: name,
      status: g.status,
      score: g.status === 'unknown' ? null : 50,
      signals: { requestRate: 1, up: g.up, ...g.values },
      badness: { latency: 0, errors: 0, memory: 0 },
      breachedKinds: [],
    } as ServiceHealth;
    for (const sig of SIGNALS) {
      const kind = g.obs[sig];
      if (kind === 0) {
        observations.push({ service: name, signal: sig, kind: 'unusable' });
      } else {
        const reading =
          kind === 2 ? ({ service: name, signal: sig } as unknown as AnomalyReading) : null;
        observations.push({ service: name, signal: sig, kind: 'evaluated', reading });
      }
    }
  });
  return {
    baselines,
    input: { metricsAvailable: s.metricsAvailable, health, observations, openBefore },
  };
}

describe('learnBaselines properties', () => {
  // Feature: engine-intelligence, Property 5: Guarded pairs keep their Baseline
  // **Validates: Requirements R2.1, R2.2, R2.3, R2.4, R2.5, R2.6, R2.9**
  it('Property 5: Guarded pairs keep their Baseline', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const { baselines, input } = build(scenario);
        const baselinesCopy = structuredClone(baselines);
        const inputCopy = structuredClone(input);

        const out = learnBaselines(baselines, input, CONFIG.anomaly);

        // Input is not mutated.
        expect(baselines).toEqual(baselinesCopy);
        expect(input).toEqual(inputCopy);

        CHAIN.forEach((name, i) => {
          const g = scenario.services[i];
          const unsafeService =
            !scenario.metricsAvailable || g.status === 'unknown' || g.up === false || g.open;
          for (const sig of SIGNALS) {
            const v = g.values[sig];
            const guarded =
              unsafeService || v === null || !Number.isFinite(v) || g.obs[sig] === 2;
            if (guarded) {
              expect(out[name][sig]).toEqual(baselines[name][sig]);
              expect(out[name][sig].count).toBe(baselines[name][sig].count);
            } else {
              // Unguarded pairs only ever grow, never reset.
              expect(out[name][sig].count).toBeGreaterThanOrEqual(baselines[name][sig].count);
            }
          }
        });
      }),
      { numRuns: 200 },
    );
  });
});
