// Pure memory forecaster. No I/O, no clock reads, no mutation of inputs (R9.1, R9.2).
import type { ForecastClearReason, MemoryForecast, ServiceName } from '@haunted-cluster/shared';
import type { ForecastConfig } from '../../config/engine-config';
import type { ForecastEvent, RssSample, ServiceForecastState } from '../intelligence-types';
import { fitTrend } from './trend-fitter';

export type { ForecastEvent, ServiceForecastState } from '../intelligence-types';

export interface RssObservation {
  service: ServiceName;
  /** Poll epoch ms. */
  now: number;
  up: boolean | null;
  rssMb: number | null;
}

/** (limit - latest) / slope, never below 0. Caller guarantees slope > 0. */
export function timeToLimitSeconds(latestRssMb: number, slope: number, limitMb: number): number {
  return Math.max(0, (limitMb - latestRssMb) / slope);
}

export function stepForecast(
  prev: ServiceForecastState,
  obs: RssObservation,
  config: ForecastConfig,
  memoryLimitMb: number,
): { state: ServiceForecastState; event: ForecastEvent | null } {
  let window: readonly RssSample[] = prev.window;
  let warning = prev.warning;
  let event: ForecastEvent | null = null;

  // 1. Memory_Drop: service down, or RSS fell by more than restartDropMb.
  const previous = window.length > 0 ? window[window.length - 1] : undefined;
  const rssFinite = obs.rssMb !== null && Number.isFinite(obs.rssMb);
  const dropped =
    obs.up === false ||
    (rssFinite && previous !== undefined && previous.mb - (obs.rssMb as number) > config.restartDropMb);
  if (dropped) {
    window = [];
    if (warning) {
      warning = false;
      const reason: ForecastClearReason = 'memory-dropped';
      event = { type: 'forecast:cleared', service: obs.service, reason };
    }
  }

  // 2. Append the sample and trim to windowPolls.
  if (obs.up === true && rssFinite) {
    const next = [...window, { t: obs.now, mb: obs.rssMb as number }];
    window = next.length > config.windowPolls ? next.slice(next.length - config.windowPolls) : next;
  }

  // 3. Fit.
  const fit = fitTrend(window, config.minSamples);

  // 4. Time to limit, only for a rising slope.
  let ttl: number | null = null;
  const latest = window.length > 0 ? window[window.length - 1] : undefined;
  if (fit !== null && latest !== undefined && fit.slopeMbPerSecond > config.minSlopeMbPerS) {
    ttl = timeToLimitSeconds(latest.mb, fit.slopeMbPerSecond, memoryLimitMb);
  }

  if (fit !== null) {
    if (!warning) {
      // 5. Warning start.
      if (ttl !== null && ttl < config.warnSeconds && fit.r2 >= config.minR2) {
        warning = true;
        event = { type: 'forecast:warning', forecast: buildForecast(obs.service, fit, latest, ttl, true) };
      }
    } else if (fit.slopeMbPerSecond <= config.minSlopeMbPerS) {
      // 6. Warning clear (a warning cleared in step 1 is already inactive here).
      warning = false;
      event = { type: 'forecast:cleared', service: obs.service, reason: 'stopped-rising' };
    }
  }

  // 7. Result.
  const forecast =
    fit !== null && latest !== undefined ? buildForecast(obs.service, fit, latest, ttl, warning) : null;

  return { state: { window, warning, forecast }, event };
}

function buildForecast(
  service: ServiceName,
  fit: { slopeMbPerSecond: number; r2: number },
  latest: RssSample | undefined,
  ttl: number | null,
  warning: boolean,
): MemoryForecast {
  return {
    service,
    slopeMbPerSecond: fit.slopeMbPerSecond,
    r2: fit.r2,
    latestRssMb: latest === undefined ? 0 : latest.mb,
    timeToLimitSeconds: ttl,
    warning,
  };
}

/** Leak_Suspicion: warning active, or fitted slope above the minimum slope, in this Poll's forecast. */
export function isLeakSuspected(forecast: MemoryForecast | null, config: ForecastConfig): boolean {
  if (forecast === null) {
    return false;
  }
  return forecast.warning || forecast.slopeMbPerSecond > config.minSlopeMbPerS;
}
