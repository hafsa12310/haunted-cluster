// Pure baseline learning with all guards (R2.1 to R2.9). No I/O, no mutation.
import type { MonitoredSignal, ServiceHealth, ServiceName } from '@haunted-cluster/shared';
import type { AnomalyConfig } from '../../config/engine-config';
import type { BaselineMap, PairObservation } from '../intelligence-types';
import { updateBaseline } from './baseline';

export interface LearningInput {
  metricsAvailable: boolean;
  health: Record<ServiceName, ServiceHealth>;
  /** Carries the Raw_Anomaly flag of this Poll. */
  observations: readonly PairObservation[];
  /** Pre-Poll Open_Incident per service (R2.7). */
  openBefore: Record<ServiceName, boolean>;
}

const SIGNALS: readonly MonitoredSignal[] = ['latencyP95Ms', 'errorRatio', 'rssMb'];

/**
 * Applies the Poll value as one Baseline_Sample to every pair whose guards all
 * pass. Every other Baseline is returned deeply equal. Never resets a Baseline.
 */
export function learnBaselines(
  baselines: BaselineMap,
  input: LearningInput,
  config: AnomalyConfig,
): BaselineMap {
  const rawPairs = new Set<string>();
  for (const obs of input.observations) {
    if (obs.kind === 'evaluated' && obs.reading !== null) {
      rawPairs.add(`${obs.service}|${obs.signal}`);
    }
  }

  const services = Object.keys(baselines) as ServiceName[];
  const next = {} as BaselineMap;
  for (const service of services) {
    const health = input.health[service];
    const serviceGuarded =
      !input.metricsAvailable ||
      health.status === 'unknown' ||
      health.signals.up === false ||
      input.openBefore[service] === true;

    const perSignal = {} as BaselineMap[ServiceName];
    for (const signal of SIGNALS) {
      const current = baselines[service][signal];
      const value = health.signals[signal];
      const guarded =
        serviceGuarded ||
        value === null ||
        !Number.isFinite(value) ||
        rawPairs.has(`${service}|${signal}`);
      perSignal[signal] = guarded ? { ...current } : updateBaseline(current, value, config.alpha);
    }
    next[service] = perSignal;
  }
  return next;
}
