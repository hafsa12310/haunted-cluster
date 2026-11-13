import * as fc from 'fast-check';
import type { ServiceName } from '@haunted-cluster/shared';
import type { ForecastConfig } from '../../config/engine-config';
import type { ServiceForecastState } from '../intelligence-types';
import { RssObservation, stepForecast, timeToLimitSeconds } from './forecaster';
import { fitTrend } from './trend-fitter';

const NUM_RUNS = 200;
const SERVICE: ServiceName = 'gateway' as ServiceName;
const EMPTY: ServiceForecastState = { window: [], warning: false, forecast: null };

const configArb: fc.Arbitrary<ForecastConfig> = fc
  .record({
    windowPolls: fc.integer({ min: 2, max: 20 }),
    minSamplesOffset: fc.nat({ max: 18 }),
    minR2: fc.double({ min: 0, max: 1, noNaN: true }),
    minSlopeMbPerS: fc.double({ min: 0.001, max: 1, noNaN: true }),
    warnSeconds: fc.double({ min: 1, max: 5000, noNaN: true }),
    restartDropMb: fc.double({ min: 1, max: 100, noNaN: true }),
  })
  .map(({ minSamplesOffset, ...rest }) => ({
    ...rest,
    minSamples: Math.min(rest.windowPolls, 2 + minSamplesOffset),
  }));

const limitArb = fc.double({ min: 100, max: 2000, noNaN: true });

/**
 * Observation sequences that mix a noisy rising trend (so warnings really start)
 * with downs, unknowns, non-finite values and sudden drops. `now` always increases.
 */
const sequenceArb: fc.Arbitrary<RssObservation[]> = fc
  .record({
    start: fc.double({ min: 50, max: 500, noNaN: true }),
    slope: fc.double({ min: -1, max: 30, noNaN: true }),
    noise: fc.double({ min: 0, max: 20, noNaN: true }),
    base: fc.oneof(fc.constant(0), fc.integer({ min: 1.6e12, max: 1.8e12 })),
    steps: fc.array(
      fc.record({
        dt: fc.integer({ min: 1000, max: 5000 }),
        kind: fc.constantFrom(
          'up', 'up', 'up', 'up', 'up', 'up', 'down', 'unknown', 'nan', 'nullRss', 'drop',
        ),
        jitter: fc.double({ min: -1, max: 1, noNaN: true }),
        drop: fc.double({ min: 0, max: 400, noNaN: true }),
      }),
      { minLength: 1, maxLength: 40 },
    ),
  })
  .map(({ start, slope, noise, base, steps }) => {
    const out: RssObservation[] = [];
    let now = base;
    let rss = start;
    for (const s of steps) {
      now += s.dt;
      rss = Math.max(0, rss + (slope * s.dt) / 1000 + noise * s.jitter);
      switch (s.kind) {
        case 'down':
          out.push({ service: SERVICE, now, up: false, rssMb: null });
          break;
        case 'unknown':
          out.push({ service: SERVICE, now, up: null, rssMb: null });
          break;
        case 'nan':
          out.push({ service: SERVICE, now, up: true, rssMb: Number.NaN });
          break;
        case 'nullRss':
          out.push({ service: SERVICE, now, up: true, rssMb: null });
          break;
        case 'drop':
          rss = Math.max(0, rss - s.drop);
          out.push({ service: SERVICE, now, up: true, rssMb: rss });
          break;
        default:
          out.push({ service: SERVICE, now, up: true, rssMb: rss });
      }
    }
    return out;
  });

/** Independent restatement of the Memory_Drop rule (R6.6). */
function isMemoryDrop(prev: ServiceForecastState, obs: RssObservation, config: ForecastConfig): boolean {
  if (obs.up === false) return true;
  const last = prev.window[prev.window.length - 1];
  return (
    obs.rssMb !== null &&
    Number.isFinite(obs.rssMb) &&
    last !== undefined &&
    last.mb - obs.rssMb > config.restartDropMb
  );
}

function runSequence(
  seq: RssObservation[],
  config: ForecastConfig,
  limit: number,
  check: (
    prev: ServiceForecastState,
    obs: RssObservation,
    result: ReturnType<typeof stepForecast>,
  ) => void,
): void {
  let state = EMPTY;
  for (const obs of seq) {
    const result = stepForecast(state, obs, config, limit);
    check(state, obs, result);
    state = result.state;
  }
}

describe('forecaster properties', () => {
  // Feature: engine-intelligence, Property 19: The RSS_Window follows its update rule
  // **Validates: Requirements 5.1, 5.2, 5.10, 6.6**
  it('Property 19: the window follows its update rule', () => {
    fc.assert(
      fc.property(sequenceArb, configArb, limitArb, (seq, config, limit) => {
        runSequence(seq, config, limit, (prev, obs, { state }) => {
          const dropped = isMemoryDrop(prev, obs, config);
          const appends = obs.up === true && obs.rssMb !== null && Number.isFinite(obs.rssMb);
          const base = dropped ? [] : prev.window;
          const expected = appends ? [...base, { t: obs.now, mb: obs.rssMb as number }] : [...base];
          const trimmed = expected.slice(Math.max(0, expected.length - config.windowPolls));

          expect(state.window).toEqual(trimmed);
          expect(state.window.length).toBeLessThanOrEqual(config.windowPolls);
          for (let i = 1; i < state.window.length; i++) {
            expect(state.window[i].t).toBeGreaterThan(state.window[i - 1].t);
          }
          if (dropped && appends) {
            expect(state.window).toEqual([{ t: obs.now, mb: obs.rssMb }]);
          } else if (dropped) {
            expect(state.window).toEqual([]);
          }
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 22: Time to limit is null or a finite non-negative number
  // **Validates: Requirements 6.1, 6.9, 6.11**
  it('Property 22: time to limit is null or max(0, (limit - latest) / slope)', () => {
    fc.assert(
      fc.property(sequenceArb, configArb, limitArb, (seq, config, limit) => {
        runSequence(seq, config, limit, (_prev, _obs, { state }) => {
          const fit = fitTrend(state.window, config.minSamples);
          if (fit === null && !state.warning) {
            expect(state.forecast).toBeNull();
          }
          const f = state.forecast;
          if (f === null) return;
          expect(fit).not.toBeNull();
          if (f.slopeMbPerSecond <= config.minSlopeMbPerS) {
            expect(f.timeToLimitSeconds).toBeNull();
          } else {
            const expected = Math.max(0, (limit - f.latestRssMb) / f.slopeMbPerSecond);
            expect(f.timeToLimitSeconds).toBe(expected);
            expect(Number.isFinite(f.timeToLimitSeconds)).toBe(true);
            expect(f.timeToLimitSeconds as number).toBeGreaterThanOrEqual(0);
          }
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 23: Time to limit is monotonic
  // **Validates: Requirements 6.12**
  it('Property 23: time to limit never increases as latest RSS or slope increases', () => {
    const rssArb = fc.double({ min: 0, max: 5000, noNaN: true });
    const slopeArb = fc.double({ min: 1e-6, max: 100, noNaN: true });
    fc.assert(
      fc.property(rssArb, rssArb, slopeArb, slopeArb, limitArb, (r1, r2, s1, s2, limit) => {
        const [lowR, highR] = r1 <= r2 ? [r1, r2] : [r2, r1];
        const [lowS, highS] = s1 <= s2 ? [s1, s2] : [s2, s1];
        expect(timeToLimitSeconds(highR, lowS, limit)).toBeLessThanOrEqual(
          timeToLimitSeconds(lowR, lowS, limit),
        );
        expect(timeToLimitSeconds(lowR, highS, limit)).toBeLessThanOrEqual(
          timeToLimitSeconds(lowR, lowS, limit),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 24: Warnings start only from a good, close fit
  // **Validates: Requirements 6.2, 6.3, 6.8**
  it('Property 24: a warning starts iff there is no warning, a fit, ttl < warnSeconds and r2 >= minR2', () => {
    let warningsSeen = 0;
    fc.assert(
      fc.property(sequenceArb, configArb, limitArb, (seq, config, limit) => {
        runSequence(seq, config, limit, (prev, _obs, { state, event }) => {
          const fit = fitTrend(state.window, config.minSamples);
          const ttl = state.forecast?.timeToLimitSeconds ?? null;
          const shouldStart =
            !prev.warning &&
            fit !== null &&
            ttl !== null &&
            ttl < config.warnSeconds &&
            fit.r2 >= config.minR2;

          if (shouldStart) {
            warningsSeen++;
            expect(state.warning).toBe(true);
            expect(event).toEqual({ type: 'forecast:warning', forecast: state.forecast });
          } else if (!prev.warning) {
            expect(state.warning).toBe(false);
            expect(event?.type).not.toBe('forecast:warning');
          }
          if (fit !== null && fit.r2 < config.minR2 && !prev.warning) {
            expect(state.warning).toBe(false);
          }
        });
      }),
      { numRuns: NUM_RUNS },
    );
    // warningsSeen is informational only; non-vacuity is asserted deterministically below.
    void warningsSeen;
  });

  it('Property 24 (non-vacuity): a steep noise-free rise under a lenient config always starts a warning', () => {
    fc.assert(
      fc.property(
        configArb.map((c) => ({ ...c, minR2: Math.min(c.minR2, 0.9), warnSeconds: 5000 })),
        limitArb,
        fc.double({ min: 5, max: 30, noNaN: true }),
        fc.integer({ min: 20, max: 30 }),
        (config, limit, slope, rises) => {
          const seq: RssObservation[] = [];
          for (let i = 0; i < rises; i++) {
            seq.push({ service: SERVICE, now: 1000 * (i + 1), up: true, rssMb: 100 + slope * i });
          }
          let started = 0;
          runSequence(seq, config, limit, (_p, _o, { event }) => {
            if (event?.type === 'forecast:warning') started++;
          });
          expect(started).toBe(1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 25: An active warning stays visible and silent
  // **Validates: Requirements 6.4, 6.13**
  it('Property 25: an active warning keeps a freshly recomputed forecast and emits no further warning', () => {
    fc.assert(
      fc.property(sequenceArb, configArb, limitArb, (seq, config, limit) => {
        runSequence(seq, config, limit, (prev, _obs, { state, event }) => {
          if (prev.warning) {
            expect(event?.type).not.toBe('forecast:warning');
          }
          if (!state.warning) return;
          const fit = fitTrend(state.window, config.minSamples);
          const latest = state.window[state.window.length - 1];
          expect(fit).not.toBeNull();
          expect(state.forecast).not.toBeNull();
          expect(state.forecast?.warning).toBe(true);
          expect(state.forecast?.slopeMbPerSecond).toBe(fit?.slopeMbPerSecond);
          expect(state.forecast?.r2).toBe(fit?.r2);
          expect(state.forecast?.latestRssMb).toBe(latest.mb);
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 26: Warnings clear with the right reason, once
  // **Validates: Requirements 6.5, 6.6, 6.7**
  describe('Property 26: warnings clear with the right reason and never when none was active', () => {
    /** Checks one step; returns 1 when a warning cleared on it, else 0. */
    const checkStep = (
      config: ForecastConfig,
      prev: ServiceForecastState,
      obs: RssObservation,
      { state, event }: ReturnType<typeof stepForecast>,
    ): number => {
      if (!prev.warning) {
        expect(event?.type).not.toBe('forecast:cleared');
        return 0;
      }
      const fit = fitTrend(state.window, config.minSamples);
      if (isMemoryDrop(prev, obs, config)) {
        expect(event).toEqual({ type: 'forecast:cleared', service: SERVICE, reason: 'memory-dropped' });
        expect(state.warning).toBe(false);
        return 1;
      }
      if (fit !== null && fit.slopeMbPerSecond <= config.minSlopeMbPerS) {
        expect(event).toEqual({ type: 'forecast:cleared', service: SERVICE, reason: 'stopped-rising' });
        expect(state.warning).toBe(false);
        return 1;
      }
      expect(event).toBeNull();
      expect(state.warning).toBe(true);
      return 0;
    };

    it('holds on arbitrary mixed sequences', () => {
      fc.assert(
        fc.property(sequenceArb, configArb, limitArb, (seq, config, limit) => {
          runSequence(seq, config, limit, (prev, obs, result) => {
            checkStep(config, prev, obs, result);
          });
        }),
        { numRuns: NUM_RUNS },
      );
    });

    /**
     * Sequences that always warn, then always end the warning: a noise-free steep
     * rise under a config that accepts it, followed by a down poll or a big drop.
     */
    const warnThenClearArb = fc.record({
      config: configArb.map((c) => ({ ...c, minR2: Math.min(c.minR2, 0.9), warnSeconds: 5000 })),
      limit: limitArb,
      slope: fc.double({ min: 5, max: 30, noNaN: true }),
      start: fc.double({ min: 50, max: 500, noNaN: true }),
      rises: fc.integer({ min: 20, max: 30 }),
      ending: fc.constantFrom('down', 'drop'),
    });

    it('exercises at least one clear on every run of warn-then-end sequences', () => {
      fc.assert(
        fc.property(warnThenClearArb, ({ config, limit, slope, start, rises, ending }) => {
          const seq: RssObservation[] = [];
          let now = 1_000;
          let rss = start;
          for (let i = 0; i < rises; i++) {
            now += 1000;
            rss += slope;
            seq.push({ service: SERVICE, now, up: true, rssMb: rss });
          }
          now += 1000;
          seq.push(
            ending === 'down'
              ? { service: SERVICE, now, up: false, rssMb: null }
              : { service: SERVICE, now, up: true, rssMb: Math.max(0, rss - config.restartDropMb - 1) },
          );

          let warned = false;
          let clears = 0;
          runSequence(seq, config, limit, (prev, obs, result) => {
            if (result.event?.type === 'forecast:warning') warned = true;
            clears += checkStep(config, prev, obs, result);
          });
          expect(warned).toBe(true);
          expect(clears).toBeGreaterThan(0);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
