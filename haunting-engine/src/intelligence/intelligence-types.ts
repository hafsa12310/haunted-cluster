// Types only. No runtime code (R9.1, R9.4).
//
// This file is the single definition of every state type shared across the
// intelligence layer. Function files that the design places these types in
// (anomaly/baseline.ts, anomaly/anomaly-tracker.ts, forecast/trend-fitter.ts,
// forecast/forecaster.ts) must `export type { ... } from '../intelligence-types'`
// instead of defining them again.
import type {
  AnomalyReading,
  ForecastClearReason,
  MemoryForecast,
  MonitoredSignal,
  ServiceName,
} from '@haunted-cluster/shared';

/**
 * EWMA mean and variance of one (service, signal) pair.
 * Single definition. Task 5.2 (anomaly/baseline.ts) re-exports it.
 */
export interface Baseline {
  readonly mean: number;
  readonly variance: number;
  /** Baseline_Samples applied so far. */
  readonly count: number;
}

/** One Baseline per (service, signal): 3 x N entries (R1.1). */
export type BaselineMap = Record<ServiceName, Record<MonitoredSignal, Baseline>>;

/** Streaks, Confirmed_Anomaly flag and latest reading of one pair (R4.1). */
export interface PairTracking {
  anomalousStreak: number;
  clearStreak: number;
  confirmed: boolean;
  lastReading: AnomalyReading | null;
}

export type TrackingMap = Record<ServiceName, Record<MonitoredSignal, PairTracking>>;

/**
 * What one Poll showed for one (service, signal) pair. Single definition;
 * anomaly-tracker.ts (task 5.8) re-exports it.
 */
export type PairObservation =
  | { service: ServiceName; signal: MonitoredSignal; kind: 'unknown-service' }
  | { service: ServiceName; signal: MonitoredSignal; kind: 'down-service' }
  | { service: ServiceName; signal: MonitoredSignal; kind: 'unusable' }
  | {
      service: ServiceName;
      signal: MonitoredSignal;
      kind: 'evaluated';
      reading: AnomalyReading | null;
    };

/** One RSS reading; t is the Poll epoch ms. Task 6.1 (trend-fitter.ts) re-exports it. */
export interface RssSample {
  readonly t: number;
  readonly mb: number;
}

/** RSS_Window, warning flag and last non-blind Memory_Forecast of one service. */
export interface ServiceForecastState {
  readonly window: readonly RssSample[];
  readonly warning: boolean;
  /** Null when there is no fit and no warning. */
  readonly forecast: MemoryForecast | null;
}

/**
 * Anomaly events. Defined here so IntelligenceEvent compiles before
 * anomaly-tracker.ts exists; task 5.x (anomaly-tracker.ts) re-exports it.
 */
export type AnomalyEvent =
  | { type: 'anomaly:detected'; reading: AnomalyReading }
  | { type: 'anomaly:cleared'; service: ServiceName; signal: MonitoredSignal };

/**
 * Forecast events. Defined here for the same reason; task 6.3
 * (forecaster.ts) re-exports it.
 */
export type ForecastEvent =
  | { type: 'forecast:warning'; forecast: MemoryForecast }
  | { type: 'forecast:cleared'; service: ServiceName; reason: ForecastClearReason };

export type IntelligenceEvent = ForecastEvent | AnomalyEvent;

export interface IntelligenceState {
  /** One Baseline per (service, signal): 3 x N entries (R1.1). */
  baselines: BaselineMap;
  /** Streaks, Confirmed_Anomaly flag and latest reading per pair (R4.1). */
  tracking: TrackingMap;
  /** RSS_Window, warning flag and last non-blind Memory_Forecast per service. */
  forecast: Record<ServiceName, ServiceForecastState>;
}
