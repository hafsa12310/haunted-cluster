import type { AnomalyReading, MonitoredSignal, ServiceHealth, ServiceSignals } from '@haunted-cluster/shared';
import { loadEngineConfig } from '../../config/engine-config';
import type { BaselineMap, PairObservation } from '../intelligence-types';
import { learnBaselines, type LearningInput } from './anomaly-learning';
import { EMPTY_BASELINE } from './baseline';

const CONFIG = loadEngineConfig({
  PROMETHEUS_URL: 'http://prometheus:9090',
  GATEWAY_URL: 'http://gateway:3000',
  ORDERS_URL: 'http://orders:3001',
  PAYMENTS_URL: 'http://payments:3002',
});
const CHAIN = CONFIG.serviceChain;
const SIGNALS: MonitoredSignal[] = ['latencyP95Ms', 'errorRatio', 'rssMb'];

function health(service: string, status: ServiceHealth['status'], signals: Partial<ServiceSignals>): ServiceHealth {
  return {
    service,
    status,
    score: status === 'unknown' ? null : 100,
    signals: { requestRate: 1, errorRatio: 0.1, latencyP95Ms: 50, rssMb: 100, up: true, ...signals },
    badness: { latency: 0, errors: 0, memory: 0 },
    breachedKinds: [],
  };
}

function baselines(): BaselineMap {
  return Object.fromEntries(
    CHAIN.map((s) => [
      s,
      Object.fromEntries(SIGNALS.map((g) => [g, { mean: 10, variance: 1, count: 5 }])),
    ]),
  ) as BaselineMap;
}

function input(over: Partial<LearningInput> = {}): LearningInput {
  return {
    metricsAvailable: true,
    health: Object.fromEntries(CHAIN.map((s) => [s, health(s, 'healthy', {})])),
    observations: CHAIN.flatMap((s) =>
      SIGNALS.map((g): PairObservation => ({ service: s, signal: g, kind: 'evaluated', reading: null })),
    ),
    openBefore: Object.fromEntries(CHAIN.map((s) => [s, false])),
    ...over,
  };
}

describe('learnBaselines', () => {
  it('applies one sample per unguarded pair without mutating the input', () => {
    const b = baselines();
    const copy = JSON.parse(JSON.stringify(b)) as BaselineMap;
    const out = learnBaselines(b, input(), CONFIG.anomaly);
    expect(b).toEqual(copy);
    for (const s of CHAIN) {
      for (const g of SIGNALS) expect(out[s][g].count).toBe(6);
    }
  });

  it('returns equal baselines when the Poll is blind', () => {
    const b = baselines();
    expect(learnBaselines(b, input({ metricsAvailable: false }), CONFIG.anomaly)).toEqual(b);
  });

  it('guards unknown, down, open-incident, null/non-finite and raw-anomaly pairs', () => {
    const [a, c, d, e] = [CHAIN[0], CHAIN[1], CHAIN[2], CHAIN[0]];
    const base = input();
    const h = { ...base.health };
    h[a] = health(a, 'unknown', {});
    h[c] = health(c, 'down', { up: false });
    h[d] = health(d, 'healthy', { latencyP95Ms: null, errorRatio: Infinity });
    const reading = { service: d, signal: 'rssMb' } as unknown as AnomalyReading;
    const observations = base.observations.map((o) =>
      o.service === d && o.signal === 'rssMb' ? { ...o, reading } : o,
    );
    const out = learnBaselines(baselines(), { ...base, health: h, observations }, CONFIG.anomaly);
    for (const g of SIGNALS) {
      expect(out[a][g].count).toBe(5);
      expect(out[c][g].count).toBe(5);
    }
    expect(out[d].latencyP95Ms.count).toBe(5);
    expect(out[d].errorRatio.count).toBe(5);
    expect(out[d].rssMb.count).toBe(5);

    const open = learnBaselines(baselines(), input({ openBefore: { ...base.openBefore, [e]: true } }), CONFIG.anomaly);
    for (const g of SIGNALS) expect(open[e][g].count).toBe(5);
  });

  it('never resets an empty or populated baseline', () => {
    const b = baselines();
    b[CHAIN[0]].rssMb = { ...EMPTY_BASELINE };
    const out = learnBaselines(b, input(), CONFIG.anomaly);
    expect(out[CHAIN[0]].rssMb.count).toBe(1);
  });
});
