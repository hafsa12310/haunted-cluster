import type { AnomalyReading, MonitoredSignal, ServiceName } from '@haunted-cluster/shared';
import { loadEngineConfig } from '../../config/engine-config';
import type { PairObservation, PairTracking, TrackingMap } from '../intelligence-types';
import { trackAnomalies, type TrackingContext } from './anomaly-tracker';

const CONFIG = loadEngineConfig({
  PROMETHEUS_URL: 'http://prometheus:9090',
  GATEWAY_URL: 'http://gateway:3000',
  ORDERS_URL: 'http://orders:3001',
  PAYMENTS_URL: 'http://payments:3002',
});
const CHAIN: readonly ServiceName[] = CONFIG.serviceChain;
const SIGNALS: readonly MonitoredSignal[] = ['latencyP95Ms', 'errorRatio', 'rssMb'];
const SERVICE: ServiceName = CHAIN[0];

const emptyPair = (): PairTracking => ({
  anomalousStreak: 0,
  clearStreak: 0,
  confirmed: false,
  lastReading: null,
});

function emptyTracking(): TrackingMap {
  const map = {} as TrackingMap;
  for (const service of CHAIN) {
    const perSignal = {} as Record<MonitoredSignal, PairTracking>;
    for (const signal of SIGNALS) perSignal[signal] = emptyPair();
    map[service] = perSignal;
  }
  return map;
}

function context(leakSuspected: boolean): TrackingContext {
  const off = {} as Record<ServiceName, boolean>;
  const leak = {} as Record<ServiceName, boolean>;
  for (const service of CHAIN) {
    off[service] = false;
    leak[service] = service === SERVICE && leakSuspected;
  }
  return { openBefore: off, leakSuspected: leak };
}

const reading = (signal: MonitoredSignal): AnomalyReading => ({
  service: SERVICE,
  signal,
  value: 100,
  baselineMean: 10,
  baselineStdDev: 1,
  zScore: 5,
  method: 'learned',
});

const anomalous = (signal: MonitoredSignal): PairObservation => ({
  service: SERVICE,
  signal,
  kind: 'evaluated',
  reading: reading(signal),
});

const noReading = (signal: MonitoredSignal): PairObservation => ({
  service: SERVICE,
  signal,
  kind: 'evaluated',
  reading: null,
});

describe('trackAnomalies edge cases', () => {
  it('confirmPolls of 1 detects in the first anomalous Poll (R4.2)', () => {
    const config = { ...CONFIG.anomaly, confirmPolls: 1, relearnPolls: 1_000 };
    const result = trackAnomalies(
      emptyTracking(),
      [anomalous('latencyP95Ms')],
      context(false),
      config,
    );
    expect(result.events).toEqual([
      { type: 'anomaly:detected', reading: reading('latencyP95Ms') },
    ]);
    expect(result.tracking[SERVICE].latencyP95Ms.confirmed).toBe(true);
    expect(result.tracking[SERVICE].latencyP95Ms.anomalousStreak).toBe(1);
  });

  it('relearnPolls === confirmPolls emits detected, then resets streaks and keeps confirmed (R4.8, R4.14)', () => {
    const config = { ...CONFIG.anomaly, confirmPolls: 3, relearnPolls: 3 };
    let tracking = emptyTracking();
    let last = trackAnomalies(tracking, [anomalous('latencyP95Ms')], context(false), config);
    for (let i = 0; i < 2; i += 1) {
      tracking = last.tracking;
      last = trackAnomalies(tracking, [anomalous('latencyP95Ms')], context(false), config);
    }
    expect(last.events).toEqual([
      { type: 'anomaly:detected', reading: reading('latencyP95Ms') },
    ]);
    expect(last.relearn).toEqual([{ service: SERVICE, signal: 'latencyP95Ms' }]);
    const pair = last.tracking[SERVICE].latencyP95Ms;
    expect(pair.anomalousStreak).toBe(0);
    expect(pair.clearStreak).toBe(0);
    expect(pair.confirmed).toBe(true);
  });

  it('a one-Poll gap (evaluated, no reading) resets the anomalous streak to 0 (R4.2)', () => {
    const config = { ...CONFIG.anomaly, confirmPolls: 3, relearnPolls: 1_000 };
    let tracking = emptyTracking();
    for (let i = 0; i < 2; i += 1) {
      tracking = trackAnomalies(tracking, [anomalous('latencyP95Ms')], context(false), config)
        .tracking;
    }
    expect(tracking[SERVICE].latencyP95Ms.anomalousStreak).toBe(2);

    const gap = trackAnomalies(tracking, [noReading('latencyP95Ms')], context(false), config);
    expect(gap.tracking[SERVICE].latencyP95Ms.anomalousStreak).toBe(0);
    expect(gap.tracking[SERVICE].latencyP95Ms.clearStreak).toBe(1);

    const after = trackAnomalies(
      gap.tracking,
      [anomalous('latencyP95Ms')],
      context(false),
      config,
    );
    expect(after.tracking[SERVICE].latencyP95Ms.anomalousStreak).toBe(1);
    expect(after.events).toEqual([]);
  });

  it('suppresses rssMb relearn under Leak_Suspicion but not latencyP95Ms, streak uncapped (R4.15)', () => {
    const config = { ...CONFIG.anomaly, confirmPolls: 2, relearnPolls: 3 };
    let tracking = emptyTracking();
    const relearned: string[] = [];
    const polls = 6;
    for (let i = 0; i < polls; i += 1) {
      const result = trackAnomalies(
        tracking,
        [anomalous('rssMb'), anomalous('latencyP95Ms')],
        context(true),
        config,
      );
      tracking = result.tracking;
      for (const pair of result.relearn) relearned.push(`${pair.service}|${pair.signal}`);
    }
    // rssMb is never relearned and its streak keeps counting past relearnPolls.
    expect(relearned).not.toContain(`${SERVICE}|rssMb`);
    expect(tracking[SERVICE].rssMb.anomalousStreak).toBe(polls);
    // latencyP95Ms of the same service relearns normally (every 3rd Poll).
    expect(relearned.filter((key) => key === `${SERVICE}|latencyP95Ms`)).toHaveLength(2);
    expect(tracking[SERVICE].latencyP95Ms.anomalousStreak).toBe(0);
  });
});
