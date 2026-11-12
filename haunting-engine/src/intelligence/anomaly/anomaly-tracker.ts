// Pure streak tracking, confirmation and relearn decision (R4.1 to R4.6, R4.8 to R4.16).
// No I/O, no mutation of inputs.
import type { MonitoredSignal, ServiceName } from '@haunted-cluster/shared';
import type { AnomalyConfig } from '../../config/engine-config';
import type {
  AnomalyEvent,
  PairObservation,
  PairTracking,
  TrackingMap,
} from '../intelligence-types';

// Types are defined once in intelligence-types.ts.
export type { AnomalyEvent, PairObservation, PairTracking, TrackingMap };

export interface TrackingContext {
  /** Pre-Poll Open_Incident per service. */
  openBefore: Record<ServiceName, boolean>;
  /** Leak_Suspicion from this Poll's forecast step. */
  leakSuspected: Record<ServiceName, boolean>;
}

export interface PairKey {
  service: ServiceName;
  signal: MonitoredSignal;
}

const SIGNALS: readonly MonitoredSignal[] = ['latencyP95Ms', 'errorRatio', 'rssMb'];

/**
 * Updates streaks and the confirmed flag of every pair. Events come out in
 * chain order (key order of `prev`), then signal order. `relearn` lists pairs
 * whose Baseline the caller must reset.
 */
export function trackAnomalies(
  prev: TrackingMap,
  observations: readonly PairObservation[],
  context: TrackingContext,
  config: AnomalyConfig,
): { tracking: TrackingMap; events: AnomalyEvent[]; relearn: PairKey[] } {
  const byPair = new Map<string, PairObservation>();
  for (const obs of observations) {
    byPair.set(`${obs.service}|${obs.signal}`, obs);
  }

  const tracking = {} as TrackingMap;
  const events: AnomalyEvent[] = [];
  const relearn: PairKey[] = [];

  for (const service of Object.keys(prev) as ServiceName[]) {
    const perSignal = {} as Record<MonitoredSignal, PairTracking>;
    for (const signal of SIGNALS) {
      const before = prev[service][signal];
      const obs = byPair.get(`${service}|${signal}`);
      let next: PairTracking = { ...before };

      if (obs === undefined || obs.kind === 'unusable') {
        // Frozen exactly as it was, no event (R4.12).
        perSignal[signal] = next;
        continue;
      }

      if (obs.kind === 'unknown-service' || obs.kind === 'down-service') {
        if (before.confirmed) {
          events.push({ type: 'anomaly:cleared', service, signal });
        }
        perSignal[signal] = {
          anomalousStreak: 0,
          clearStreak: 0,
          confirmed: false,
          lastReading: null,
        };
        continue;
      }

      // kind === 'evaluated'
      if (obs.reading !== null) {
        next.anomalousStreak = before.anomalousStreak + 1;
        next.clearStreak = 0;
        next.lastReading = obs.reading;
        if (next.anomalousStreak === config.confirmPolls && !next.confirmed) {
          next.confirmed = true;
          events.push({ type: 'anomaly:detected', reading: obs.reading });
        }
      } else {
        next.clearStreak = before.clearStreak + 1;
        next.anomalousStreak = 0;
        if (next.clearStreak === config.confirmPolls && next.confirmed) {
          next.confirmed = false;
          next.lastReading = null;
          events.push({ type: 'anomaly:cleared', service, signal });
        }
      }

      const suppressed =
        context.openBefore[service] === true ||
        (signal === 'rssMb' && context.leakSuspected[service] === true);
      if (next.anomalousStreak >= config.relearnPolls && !suppressed) {
        relearn.push({ service, signal });
        next = { ...next, anomalousStreak: 0, clearStreak: 0 };
      }

      perSignal[signal] = next;
    }
    tracking[service] = perSignal;
  }

  return { tracking, events, relearn };
}
