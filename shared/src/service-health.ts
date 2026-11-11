/**
 * Per-service health as scored by the haunting-engine on every Poll.
 *
 * Requirements: 1.1
 */
import type { AnomalyReading, MemoryForecast } from './intelligence';

/** A service name from SERVICE_CHAIN, e.g. "gateway". */
export type ServiceName = string;

export type SignalKind = 'latency' | 'errors' | 'memory' | 'down';

export type ServiceStatus = 'healthy' | 'degraded' | 'critical' | 'down' | 'unknown';

/** Raw measurements for one service; null when Prometheus has no data. */
export interface ServiceSignals {
  /** Requests per second. */
  requestRate: number | null;
  /** 5xx responses as a fraction of all requests, 0–1. */
  errorRatio: number | null;
  latencyP95Ms: number | null;
  rssMb: number | null;
  up: boolean | null;
}

export interface ServiceHealth {
  service: ServiceName;
  status: ServiceStatus;
  /** 0–100; null when the status is unknown. */
  score: number | null;
  signals: ServiceSignals;
  /** Each 0–1: 0 at or below the OK threshold, 1 at or above critical. */
  badness: { latency: number; errors: number; memory: number };
  breachedKinds: SignalKind[];
}

export interface ClusterSnapshot {
  /** ISO 8601. */
  timestamp: string;
  metricsAvailable: boolean;
  /** SERVICE_CHAIN order, upstream first. */
  services: ServiceHealth[];
  /** Overall horror intensity, 0–1. */
  dread: number;
  /** Confirmed anomalies only, chain order then latencyP95Ms, errorRatio, rssMb. */
  anomalies: AnomalyReading[];
  /** One entry per service that has a trend fit or an active warning, chain order. */
  forecasts: MemoryForecast[];
}
