import type { MemoryForecast, ServiceName } from '@haunted-cluster/shared';
import type { ForecastConfig } from '../../config/engine-config';
import type { RssSample, ServiceForecastState } from '../intelligence-types';
import { isLeakSuspected, RssObservation, stepForecast } from './forecaster';

const SERVICE = 'payments' as ServiceName;
const LIMIT_MB = 512;
const T0 = 1_700_000_000_000;

const CONFIG: ForecastConfig = {
  windowPolls: 15,
  minSamples: 5,
  minR2: 0.8,
  minSlopeMbPerS: 0.1,
  warnSeconds: 300,
  restartDropMb: 50,
};

const EMPTY: ServiceForecastState = { window: [], warning: false, forecast: null };

function obs(second: number, rssMb: number | null, up: boolean | null = true): RssObservation {
  return { service: SERVICE, now: T0 + second * 1000, up, rssMb };
}

function samples(values: number[]): RssSample[] {
  return values.map((mb, i) => ({ t: T0 + i * 1000, mb }));
}

function forecastOf(slopeMbPerSecond: number, warning: boolean): MemoryForecast {
  return {
    service: SERVICE,
    slopeMbPerSecond,
    r2: 1,
    latestRssMb: 100,
    timeToLimitSeconds: null,
    warning,
  };
}

describe('stepForecast', () => {
  it('ends a steady leak in a forecast:warning', () => {
    let state = EMPTY;
    const events: unknown[] = [];
    // 2 MB/s from 100 MB, one sample per second.
    for (let i = 0; i < 6; i++) {
      const result = stepForecast(state, obs(i, 100 + 2 * i), CONFIG, LIMIT_MB);
      state = result.state;
      if (result.event) events.push(result.event);
    }

    expect(events).toHaveLength(1);
    const event = events[0] as { type: string; forecast: MemoryForecast };
    expect(event.type).toBe('forecast:warning');
    expect(event.forecast.warning).toBe(true);
    expect(event.forecast.slopeMbPerSecond).toBeCloseTo(2, 6);
    expect(event.forecast.timeToLimitSeconds).toBeLessThan(CONFIG.warnSeconds);
    expect(state.warning).toBe(true);
  });

  it('clears with memory-dropped on a restart and restarts the window with the current sample', () => {
    const prev: ServiceForecastState = {
      window: samples([300, 320, 340, 360, 380]),
      warning: true,
      forecast: forecastOf(20, true),
    };

    const result = stepForecast(prev, obs(5, 30), CONFIG, LIMIT_MB);

    expect(result.event).toEqual({ type: 'forecast:cleared', service: SERVICE, reason: 'memory-dropped' });
    expect(result.state.warning).toBe(false);
    expect(result.state.window).toEqual([{ t: T0 + 5000, mb: 30 }]);
    expect(result.state.forecast).toBeNull();
  });

  it('clears with memory-dropped and empties the window when the service is down', () => {
    const prev: ServiceForecastState = {
      window: samples([300, 320, 340, 360, 380]),
      warning: true,
      forecast: forecastOf(20, true),
    };

    const result = stepForecast(prev, obs(5, null, false), CONFIG, LIMIT_MB);

    expect(result.event).toEqual({ type: 'forecast:cleared', service: SERVICE, reason: 'memory-dropped' });
    expect(result.state.window).toEqual([]);
    expect(result.state.warning).toBe(false);
  });

  it('clears with stopped-rising when the series flattens', () => {
    const prev: ServiceForecastState = {
      window: samples([300, 300, 300, 300]),
      warning: true,
      forecast: forecastOf(2, true),
    };

    const result = stepForecast(prev, obs(4, 300), CONFIG, LIMIT_MB);

    expect(result.event).toEqual({ type: 'forecast:cleared', service: SERVICE, reason: 'stopped-rising' });
    expect(result.state.warning).toBe(false);
    expect(result.state.window).toHaveLength(5);
  });

  it('leaves the window unchanged when up is true but rssMb is null', () => {
    // Flat window: re-fitting it does not start a warning, so no event is expected.
    const window = samples([200, 200, 200, 200, 200]);
    const prev: ServiceForecastState = { window, warning: false, forecast: null };

    const result = stepForecast(prev, obs(5, null, true), CONFIG, LIMIT_MB);

    expect(result.state.window).toEqual(window);
    expect(result.event).toBeNull();
  });
});

describe('isLeakSuspected', () => {
  it('is true when a warning is active, even with a slope below the minimum', () => {
    expect(isLeakSuspected(forecastOf(0, true), CONFIG)).toBe(true);
  });

  it('is true when the slope is above the minimum without a warning', () => {
    expect(isLeakSuspected(forecastOf(CONFIG.minSlopeMbPerS + 0.01, false), CONFIG)).toBe(true);
  });

  it('is false when the slope is below the minimum without a warning', () => {
    expect(isLeakSuspected(forecastOf(CONFIG.minSlopeMbPerS - 0.01, false), CONFIG)).toBe(false);
  });

  it('is false for a null forecast', () => {
    expect(isLeakSuspected(null, CONFIG)).toBe(false);
  });
});
