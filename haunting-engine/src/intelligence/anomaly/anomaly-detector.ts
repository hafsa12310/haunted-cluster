// Pure anomaly detection (R3.1 to R3.10, R3.12). No I/O, no clock, no mutation.
import type {
  AnomalyReading,
  MonitoredSignal,
  ServiceHealth,
  ServiceName,
} from '@haunted-cluster/shared';
import type { AnomalyConfig } from '../../config/engine-config';
import { BREACH_BADNESS } from '../../health/health-scoring';
import { effectiveStdDev, type Baseline } from './baseline';

export interface DetectionInput {
  health: Record<ServiceName, ServiceHealth>;
  /** Baselines as they were before this Poll's update. */
  baselines: Record<ServiceName, Record<MonitoredSignal, Baseline>>;
}

const SIGNALS: readonly MonitoredSignal[] = ['latencyP95Ms', 'errorRatio', 'rssMb'];

const BADNESS_KIND: Record<MonitoredSignal, keyof ServiceHealth['badness']> = {
  latencyP95Ms: 'latency',
  errorRatio: 'errors',
  rssMb: 'memory',
};

/** (value - mean) / floored std dev. Finite, or null when the result is not finite. */
export function zScore(value: number, baseline: Baseline, floor: number): number | null {
  if (!Number.isFinite(value)) return null;
  const z = (value - baseline.mean) / effectiveStdDev(baseline, floor);
  return Number.isFinite(z) ? z : null;
}

/**
 * Raw anomalies for one non-blind Poll, in chain order then signal order.
 * Unknown services, down services and non-finite values yield nothing.
 */
export function detectAnomalies(
  input: DetectionInput,
  config: AnomalyConfig,
  chain: readonly ServiceName[],
): AnomalyReading[] {
  const readings: AnomalyReading[] = [];
  for (const service of chain) {
    const health = input.health[service];
    if (health.status === 'unknown' || health.signals.up === false) continue;

    for (const signal of SIGNALS) {
      const value = health.signals[signal];
      if (value === null || !Number.isFinite(value)) continue;

      const baseline = input.baselines[service][signal];
      const stdDev = effectiveStdDev(baseline, config.minStdDev[signal]);

      if (baseline.count < config.warmupPolls) {
        if (health.badness[BADNESS_KIND[signal]] > BREACH_BADNESS) {
          readings.push({
            service,
            signal,
            value,
            baselineMean: baseline.mean,
            baselineStdDev: stdDev,
            zScore: null,
            method: 'fixed',
          });
        }
        continue;
      }

      const z = zScore(value, baseline, config.minStdDev[signal]);
      if (value > baseline.mean && z !== null && z > config.zThreshold) {
        readings.push({
          service,
          signal,
          value,
          baselineMean: baseline.mean,
          baselineStdDev: stdDev,
          zScore: z,
          method: 'learned',
        });
      }
    }
  }
  return readings;
}
