import type { ServiceName } from './service-health';

/** The three signals the Engine learns a baseline for. */
export type MonitoredSignal = 'latencyP95Ms' | 'errorRatio' | 'rssMb';

/** How an anomaly was detected. */
export type AnomalyMethod = 'learned' | 'fixed';

/** One flagged signal. For a Confirmed_Anomaly this is the most recent reading of the pair. */
export interface AnomalyReading {
  service: ServiceName;
  signal: MonitoredSignal;
  /** The Poll value that was flagged. */
  value: number;
  /** Baseline mean when the Poll was evaluated. */
  baselineMean: number;
  /** Baseline standard deviation with the per-signal minimum applied. */
  baselineStdDev: number;
  /** (value - baselineMean) / baselineStdDev; null when method is 'fixed'. */
  zScore: number | null;
  method: AnomalyMethod;
}

/** Why a forecast warning ended. */
export type ForecastClearReason = 'stopped-rising' | 'memory-dropped';

/** Linear RSS trend of one service and the estimated time until the container memory limit. */
export interface MemoryForecast {
  service: ServiceName;
  /** MB per second from the least-squares fit. */
  slopeMbPerSecond: number;
  /** Coefficient of determination of the fit, 0-1. */
  r2: number;
  /** The most recent RSS sample in the fit, MB. */
  latestRssMb: number;
  /** Seconds until RSS reaches the limit; null when the slope is not above the minimum. */
  timeToLimitSeconds: number | null;
  /** True while a Forecast_Warning is active. */
  warning: boolean;
}

/** The resolved incident that looks most like another incident. */
export interface SimilarIncident {
  id: string;
  fingerprint: string;
  /** ISO 8601. */
  resolvedAt: string;
  /** Whole seconds, rounded from the matched incident's duration. */
  durationSeconds: number;
  /** Cosine similarity rounded to 3 decimal places, 0-1. */
  similarity: number;
}

export interface AnomalyClearedPayload {
  service: ServiceName;
  signal: MonitoredSignal;
}

export interface ForecastClearedPayload {
  service: ServiceName;
  reason: ForecastClearReason;
}
