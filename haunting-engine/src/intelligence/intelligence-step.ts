// Pure per-Poll intelligence pipeline (R9.1, R9.2, R9.8, R9.9). No I/O, no timers,
// no clock reads, no shared state. Time comes in as `now`.
import type {
  AnomalyReading,
  MemoryForecast,
  MonitoredSignal,
  ServiceHealth,
  ServiceName,
} from '@haunted-cluster/shared';
import type { EngineConfig } from '../config/engine-config';
import { detectAnomalies } from './anomaly/anomaly-detector';
import { learnBaselines } from './anomaly/anomaly-learning';
import { trackAnomalies } from './anomaly/anomaly-tracker';
import { EMPTY_BASELINE, resetBaseline } from './anomaly/baseline';
import { isLeakSuspected, stepForecast } from './forecast/forecaster';
import type {
  AnomalyEvent,
  BaselineMap,
  ForecastEvent,
  IntelligenceEvent,
  IntelligenceState,
  PairObservation,
  PairTracking,
  ServiceForecastState,
  TrackingMap,
} from './intelligence-types';

export type { IntelligenceEvent } from './intelligence-types';

export interface IntelligenceInput {
  /** Poll epoch ms. */
  now: number;
  metricsAvailable: boolean;
  health: Record<ServiceName, ServiceHealth>;
  /** Pre-Poll Open_Incident per service (R2.7). */
  openBefore: Record<ServiceName, boolean>;
}

const SIGNALS: readonly MonitoredSignal[] = ['latencyP95Ms', 'errorRatio', 'rssMb'];

/** Fresh state: empty Baselines, quiet tracking, empty windows, no forecasts (R1.1, R4.1). */
export function initialIntelligenceState(chain: readonly ServiceName[]): IntelligenceState {
  const baselines = {} as BaselineMap;
  const tracking = {} as TrackingMap;
  const forecast = {} as Record<ServiceName, ServiceForecastState>;
  for (const service of chain) {
    const b = {} as BaselineMap[ServiceName];
    const t = {} as Record<MonitoredSignal, PairTracking>;
    for (const signal of SIGNALS) {
      b[signal] = { ...EMPTY_BASELINE };
      t[signal] = { anomalousStreak: 0, clearStreak: 0, confirmed: false, lastReading: null };
    }
    baselines[service] = b;
    tracking[service] = t;
    forecast[service] = { window: [], warning: false, forecast: null };
  }
  return { baselines, tracking, forecast };
}

function observe(
  service: ServiceName,
  signal: MonitoredSignal,
  health: ServiceHealth,
  reading: AnomalyReading | null,
): PairObservation {
  if (health.status === 'unknown') return { service, signal, kind: 'unknown-service' };
  if (health.signals.up === false) return { service, signal, kind: 'down-service' };
  const value = health.signals[signal];
  if (value === null || !Number.isFinite(value)) return { service, signal, kind: 'unusable' };
  return { service, signal, kind: 'evaluated', reading };
}

/** One Poll of intelligence. A blind Poll returns `prev` and no events (R2.1, R4.7). */
export function stepIntelligence(
  prev: IntelligenceState,
  input: IntelligenceInput,
  config: EngineConfig,
): { state: IntelligenceState; events: IntelligenceEvent[] } {
  if (!input.metricsAvailable) {
    return { state: prev, events: [] };
  }
  const chain = Object.keys(prev.baselines) as ServiceName[];

  // (2) Forecast step per service, chain order.
  const forecastState = {} as Record<ServiceName, ServiceForecastState>;
  const forecastEvents: ForecastEvent[] = [];
  for (const service of chain) {
    const signals = input.health[service].signals;
    const result = stepForecast(
      prev.forecast[service],
      { service, now: input.now, up: signals.up, rssMb: signals.rssMb },
      config.forecast,
      config.memoryLimitMb,
    );
    forecastState[service] = result.state;
    if (result.event !== null) forecastEvents.push(result.event);
  }

  // (3) Leak suspicion from this Poll's forecasts.
  const leakSuspected = {} as Record<ServiceName, boolean>;
  for (const service of chain) {
    leakSuspected[service] = isLeakSuspected(forecastState[service].forecast, config.forecast);
  }

  // (4) Raw anomalies against the Baselines as they were before this Poll.
  const readings = detectAnomalies(
    { health: input.health, baselines: prev.baselines },
    config.anomaly,
    chain,
  );
  const readingByPair = new Map<string, AnomalyReading>();
  for (const r of readings) readingByPair.set(`${r.service}|${r.signal}`, r);

  // (5) One observation per pair.
  const observations: PairObservation[] = [];
  for (const service of chain) {
    for (const signal of SIGNALS) {
      observations.push(
        observe(service, signal, input.health[service], readingByPair.get(`${service}|${signal}`) ?? null),
      );
    }
  }

  // (6) Streaks, confirmation, relearn decision.
  const tracked = trackAnomalies(
    prev.tracking,
    observations,
    { openBefore: input.openBefore, leakSuspected },
    config.anomaly,
  );

  // (7) Learn with the unconfirmed Raw_Anomaly flags.
  let baselines = learnBaselines(
    prev.baselines,
    {
      metricsAvailable: input.metricsAvailable,
      health: input.health,
      observations,
      openBefore: input.openBefore,
    },
    config.anomaly,
  );

  // (8) Relearn resets.
  if (tracked.relearn.length > 0) {
    const reset = {} as BaselineMap;
    for (const service of chain) reset[service] = { ...baselines[service] };
    for (const { service, signal } of tracked.relearn) {
      reset[service][signal] = resetBaseline(reset[service][signal]);
    }
    baselines = reset;
  }

  // (9) Forecast events first, then anomaly events.
  const anomalyEvents: AnomalyEvent[] = tracked.events;
  return {
    state: { baselines, tracking: tracked.tracking, forecast: forecastState },
    events: [...forecastEvents, ...anomalyEvents],
  };
}

/** The only place that turns state into snapshot fields (R4.18, R6.13). */
export function intelligenceView(
  state: IntelligenceState,
  chain: readonly ServiceName[],
): { anomalies: AnomalyReading[]; forecasts: MemoryForecast[] } {
  const anomalies: AnomalyReading[] = [];
  const forecasts: MemoryForecast[] = [];
  for (const service of chain) {
    for (const signal of SIGNALS) {
      const pair = state.tracking[service][signal];
      if (pair.confirmed && pair.lastReading !== null) anomalies.push(pair.lastReading);
    }
    const f = state.forecast[service].forecast;
    if (f !== null) forecasts.push(f);
  }
  return { anomalies, forecasts };
}
