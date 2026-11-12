// Feature: engine-intelligence
// Pure incident feature extraction (R7.1 to R7.8). No I/O, no clock reads, no mutation.
import type { Incident, ServiceName, SignalKind } from '@haunted-cluster/shared';

export type FeatureVector = readonly number[];

export interface FeatureConfig {
  latencyCriticalMs: number;
  errorRatioCritical: number;
  memoryLimitMb: number;
  durationCapSeconds: number;
}

const KIND_ORDER: readonly SignalKind[] = ['latency', 'errors', 'memory', 'down'];

/** 2N + 4 + 3 + 1 (R7.1). */
export function featureVectorLength(knownServiceCount: number): number {
  return 2 * knownServiceCount + 8;
}

/** Any non-finite value becomes 0, then the result is clamped to [0, 1] (R7.2, R7.3, R7.6). */
function unit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Peak divided by its critical value; a null peak is 0 (R7.2). */
function normalizedPeak(peak: number | null, critical: number): number {
  if (peak === null) return 0;
  return unit(peak / critical);
}

function durationSeconds(incident: Incident, nowMs: number): number {
  if (incident.status === 'resolved') {
    return incident.durationMs === null ? 0 : incident.durationMs / 1000;
  }
  return (nowMs - Date.parse(incident.openedAt)) / 1000;
}

export function extractFeatures(
  incident: Incident,
  nowMs: number,
  chain: readonly ServiceName[],
  config: FeatureConfig,
): FeatureVector {
  const root = chain.map((s) => (s === incident.rootService ? 1 : 0));
  const affectedNames = new Set(incident.affected.map((a) => a.service));
  const affected = chain.map((s) => (affectedNames.has(s) ? 1 : 0));
  const kinds = KIND_ORDER.map((k) => (incident.kinds.includes(k) ? 1 : 0));
  const peaks = [
    normalizedPeak(incident.peak.latencyP95Ms, config.latencyCriticalMs),
    normalizedPeak(incident.peak.errorRatio, config.errorRatioCritical),
    normalizedPeak(incident.peak.rssMb, config.memoryLimitMb),
  ];
  const duration = unit(durationSeconds(incident, nowMs) / config.durationCapSeconds);
  return [...root, ...affected, ...kinds, ...peaks, duration];
}

/** Comparison_Vector: the Feature_Vector without its duration entry (R8.6). */
export function withoutDuration(v: FeatureVector): FeatureVector {
  return v.slice(0, -1);
}
