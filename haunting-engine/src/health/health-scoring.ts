/**
 * Health scoring: turns raw signals into a per-service score and status, and
 * the whole cluster into a single Dread value.
 *
 * Every function here is pure. Status is derived from `maxBadness`, never from
 * the rounded score, so a service is non-healthy if and only if it has at least
 * one breached kind.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 11.3
 */

import type {
  ServiceHealth,
  ServiceName,
  ServiceSignals,
  ServiceStatus,
  SignalKind,
} from '@haunted-cluster/shared';
import type { EngineConfig, Thresholds } from '../config/engine-config';

/** A kind is breached when its Badness is above this. */
export const BREACH_BADNESS = 0.2;
/** A service is critical when its `maxBadness` is above this. */
export const CRITICAL_BADNESS = 0.6;

type Badness = ServiceHealth['badness'];

/** Breached kinds are reported in this order. */
const BADNESS_KINDS = ['errors', 'latency', 'memory'] as const satisfies readonly (keyof Badness &
  SignalKind)[];

/**
 * `clamp((value − ok) / (critical − ok), 0, 1)`; a null signal has Badness 0.
 * Requirements: 3.1
 */
export function badness(value: number | null, t: Thresholds): number {
  // NaN is treated like a missing signal rather than poisoning every max() downstream.
  if (value === null || Number.isNaN(value) || value <= t.ok) return 0;
  if (value >= t.critical) return 1;
  const span = t.critical - t.ok;
  // With extreme thresholds the span can overflow to Infinity; halving both
  // sides keeps the ratio finite and equal.
  const ratio = Number.isFinite(span)
    ? (value - t.ok) / span
    : (value / 2 - t.ok / 2) / (t.critical / 2 - t.ok / 2);
  return Math.min(Math.max(ratio, 0), 1);
}

/** The largest Badness of the three kinds. */
export function maxBadness(b: Badness): number {
  return Math.max(b.latency, b.errors, b.memory);
}

function statusFor(maxB: number): ServiceStatus {
  if (maxB <= BREACH_BADNESS) return 'healthy';
  if (maxB <= CRITICAL_BADNESS) return 'degraded';
  return 'critical';
}

/** Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 11.3 */
export function scoreService(
  service: ServiceName,
  s: ServiceSignals,
  config: EngineConfig,
): ServiceHealth {
  const b: Badness = {
    latency: badness(s.latencyP95Ms, config.latencyMs),
    errors: badness(s.errorRatio, config.errorRatio),
    memory: badness(s.rssMb, config.memoryMb),
  };

  if (s.up === null) {
    return { service, status: 'unknown', score: null, signals: s, badness: b, breachedKinds: [] };
  }
  if (s.up === false) {
    return { service, status: 'down', score: 0, signals: s, badness: b, breachedKinds: ['down'] };
  }

  const maxB = maxBadness(b);
  return {
    service,
    status: statusFor(maxB),
    score: Math.round(100 * (1 - maxB)),
    signals: s,
    badness: b,
    breachedKinds: BADNESS_KINDS.filter((k) => b[k] > BREACH_BADNESS),
  };
}

/**
 * The largest `maxBadness` across services, using 1 for `down` and skipping
 * `unknown`; 0 when no service contributes.
 * Requirements: 3.7
 */
export function clusterDread(services: ServiceHealth[]): number {
  let dread = 0;
  for (const health of services) {
    if (health.status === 'unknown') continue;
    dread = Math.max(dread, health.status === 'down' ? 1 : maxBadness(health.badness));
  }
  return dread;
}

/**
 * Health for a service the engine cannot see, used for every service when a
 * Poll fails.
 * Requirements: 11.1, 11.3
 */
export function unknownHealth(service: ServiceName): ServiceHealth {
  return {
    service,
    status: 'unknown',
    score: null,
    signals: { requestRate: null, errorRatio: null, latencyP95Ms: null, rssMb: null, up: null },
    badness: { latency: 0, errors: 0, memory: 0 },
    breachedKinds: [],
  };
}
