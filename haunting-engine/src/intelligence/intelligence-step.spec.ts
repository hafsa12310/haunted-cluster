// Unit and worked-example tests for the intelligence pipeline step (task 7.10).
// Health records are built through the real `scoreService` via test-support.
import type { ServiceName, ServiceSignals } from '@haunted-cluster/shared';
import {
  initialIntelligenceState,
  intelligenceView,
  stepIntelligence,
} from './intelligence-step';
import type { IntelligenceEvent, IntelligenceInput } from './intelligence-step';
import type { IntelligenceState } from './intelligence-types';
import {
  buildHealth,
  blindPoll,
  deepFreeze,
  downServiceHealth,
  testEngineConfig,
} from './test-support';

const CHAIN: ServiceName[] = ['gateway', 'orders', 'payments'];
const CONFIG = testEngineConfig(CHAIN);
const T0 = 1_700_000_000_000;
const CALM: Partial<ServiceSignals> = { up: true, latencyP95Ms: 50, errorRatio: 0, rssMb: 80 };
/** Comfortably past Warm_Up (default 30) so the learned method is in force. */
const WARMUP = CONFIG.anomaly.warmupPolls + 5;

type Overrides = Partial<Record<ServiceName, Partial<ServiceSignals>>>;

/** Poll number `i` (2 s apart). Services listed in `down` are up === false. */
function poll(i: number, overrides: Overrides = {}, down: ServiceName[] = []): IntelligenceInput {
  const health: IntelligenceInput['health'] = {};
  for (const service of CHAIN) {
    health[service] = down.includes(service)
      ? downServiceHealth(service, CONFIG)
      : buildHealth(service, { ...CALM, ...overrides[service] }, CONFIG);
  }
  return {
    now: T0 + i * CONFIG.pollIntervalMs,
    metricsAvailable: true,
    health,
    openBefore: { gateway: false, orders: false, payments: false },
  };
}

interface Step {
  state: IntelligenceState;
  events: IntelligenceEvent[];
}

/** Steps through `inputs` in order, returning every intermediate result. */
function run(start: IntelligenceState, inputs: IntelligenceInput[]): Step[] {
  const steps: Step[] = [];
  let state = start;
  for (const input of inputs) {
    const result = stepIntelligence(deepFreeze(state), deepFreeze(input), CONFIG);
    steps.push(result);
    state = result.state;
  }
  return steps;
}

/** A state that has finished Warm_Up on calm signals. Returns it and the next poll index. */
function warmedUp(): { state: IntelligenceState; next: number } {
  const inputs = Array.from({ length: WARMUP }, (_, i) => poll(i));
  const steps = run(initialIntelligenceState(CHAIN), inputs);
  return { state: steps[steps.length - 1].state, next: WARMUP };
}

const SPIKE: Partial<ServiceSignals> = { latencyP95Ms: 800 };

function ofType(events: IntelligenceEvent[], type: IntelligenceEvent['type']): IntelligenceEvent[] {
  return events.filter((e) => e.type === type);
}

function latencyEvents(events: IntelligenceEvent[], service: ServiceName): string[] {
  return events
    .filter((e) => {
      if (e.type === 'anomaly:detected') {
        return e.reading.service === service && e.reading.signal === 'latencyP95Ms';
      }
      if (e.type === 'anomaly:cleared') {
        return e.service === service && e.signal === 'latencyP95Ms';
      }
      return false;
    })
    .map((e) => e.type);
}

/** Independent reference: first leak Poll index whose last-15 fit meets the warning rule. */
function expectedWarningIndex(rss: number[]): number {
  const { windowPolls, minSamples, minR2, minSlopeMbPerS, warnSeconds } = CONFIG.forecast;
  for (let end = 1; end <= rss.length; end += 1) {
    const ys = rss.slice(Math.max(0, end - windowPolls), end);
    if (ys.length < minSamples) continue;
    const xs = ys.map((_, k) => k * (CONFIG.pollIntervalMs / 1000));
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    xs.forEach((x, k) => {
      sxx += (x - mx) ** 2;
      sxy += (x - mx) * (ys[k] - my);
      syy += (ys[k] - my) ** 2;
    });
    if (syy === 0) continue;
    const slope = sxy / sxx;
    const r2 = (sxy * sxy) / (sxx * syy);
    if (slope <= minSlopeMbPerS) continue;
    const ttl = Math.max(0, (CONFIG.memoryLimitMb - ys[ys.length - 1]) / slope);
    if (ttl < warnSeconds && r2 >= minR2) return end - 1;
  }
  return -1;
}

describe('stepIntelligence pipeline halves', () => {
  // Property 11 (pipeline half)
  it('a Blind_Poll returns the same state, no events, and feeds the tracker nothing', () => {
    const { state, next } = warmedUp();
    const first = stepIntelligence(state, poll(next, { payments: SPIKE }), CONFIG);
    expect(first.state.tracking.payments.latencyP95Ms.anomalousStreak).toBe(1);

    const blind = stepIntelligence(first.state, blindPoll(CHAIN, T0 + (next + 1) * 2000, CONFIG), CONFIG);
    expect(blind.state).toBe(first.state);
    expect(blind.events).toEqual([]);

    // The streak neither reset nor advanced: the next real anomalous Poll is the second.
    const second = stepIntelligence(blind.state, poll(next + 2, { payments: SPIKE }), CONFIG);
    expect(latencyEvents(second.events, 'payments')).toEqual(['anomaly:detected']);
  });

  // Property 14 (pipeline half)
  it('a down service has no reading in the view and unchanged Baselines', () => {
    const { state, next } = warmedUp();
    const steps = run(state, [
      poll(next, { payments: SPIKE }),
      poll(next + 1, { payments: SPIKE }),
    ]);
    const confirmed = steps[1].state;
    expect(intelligenceView(confirmed, CHAIN).anomalies.map((a) => a.service)).toContain('payments');

    const down = stepIntelligence(confirmed, poll(next + 2, {}, ['payments']), CONFIG);
    expect(intelligenceView(down.state, CHAIN).anomalies.filter((a) => a.service === 'payments')).toEqual([]);
    expect(down.state.baselines.payments).toEqual(confirmed.baselines.payments);
    expect(down.events).toContainEqual({
      type: 'anomaly:cleared',
      service: 'payments',
      signal: 'latencyP95Ms',
    });
    // Other services keep learning normally.
    expect(down.state.baselines.gateway.latencyP95Ms.count).toBe(
      confirmed.baselines.gateway.latencyP95Ms.count + 1,
    );
  });

  // Property 25 (pipeline half)
  it('an active warning stays in the view with no new event', () => {
    const rss = (i: number): number => 85 + 4 * Math.max(0, i - 10);
    const inputs = Array.from({ length: 40 }, (_, i) => poll(i, { payments: { rssMb: rss(i) } }));
    const steps = run(initialIntelligenceState(CHAIN), inputs);
    const warnAt = steps.findIndex((s) => ofType(s.events, 'forecast:warning').length > 0);
    expect(warnAt).toBeGreaterThan(-1);
    for (let i = warnAt + 1; i < steps.length; i += 1) {
      const forecasts = intelligenceView(steps[i].state, CHAIN).forecasts;
      expect(forecasts.find((f) => f.service === 'payments')?.warning).toBe(true);
      expect(ofType(steps[i].events, 'forecast:warning')).toEqual([]);
      expect(ofType(steps[i].events, 'forecast:cleared')).toEqual([]);
    }
  });
});

describe('scripted scenarios', () => {
  it('a leak (85 MB flat for 10 Polls, then +4 MB per Poll) warns on the expected Poll and is not relearned', () => {
    const rss = Array.from({ length: 60 }, (_, i) => 85 + 4 * Math.max(0, i - 9));
    const inputs = rss.map((mb, i) => poll(i, { payments: { rssMb: mb } }));
    const steps = run(initialIntelligenceState(CHAIN), inputs);

    const warnings = steps.flatMap((s, i) =>
      ofType(s.events, 'forecast:warning').map(() => i),
    );
    const expected = expectedWarningIndex(rss);
    expect(expected).toBeGreaterThan(9);
    expect(warnings).toEqual([expected]);

    // Relearning never reset the rssMb Baseline, although the anomalous streak outgrew relearnPolls.
    let maxStreak = 0;
    let previousCount = 0;
    for (const s of steps) {
      const count = s.state.baselines.payments.rssMb.count;
      expect(count).toBeGreaterThanOrEqual(previousCount);
      previousCount = count;
      maxStreak = Math.max(maxStreak, s.state.tracking.payments.rssMb.anomalousStreak);
    }
    expect(maxStreak).toBeGreaterThanOrEqual(CONFIG.anomaly.relearnPolls);
    const finalBaseline = steps[steps.length - 1].state.baselines.payments.rssMb;
    expect(finalBaseline.count).toBeGreaterThan(0);
    expect(finalBaseline.mean).toBeLessThan(120);
  });

  it('a latency spike confirms after two Polls and clears after two', () => {
    const { state, next } = warmedUp();
    const steps = run(state, [
      poll(next, { payments: SPIKE }),
      poll(next + 1, { payments: SPIKE }),
      poll(next + 2),
      poll(next + 3),
    ]);
    expect(steps.map((s) => latencyEvents(s.events, 'payments'))).toEqual([
      [],
      ['anomaly:detected'],
      [],
      ['anomaly:cleared'],
    ]);
    expect(intelligenceView(steps[1].state, CHAIN).anomalies).toHaveLength(1);
    expect(intelligenceView(steps[2].state, CHAIN).anomalies).toHaveLength(1);
    expect(intelligenceView(steps[3].state, CHAIN).anomalies).toEqual([]);
  });

  it('a payments restart clears the warning and every confirmed payments pair, leaving Baselines alone', () => {
    const { state, next } = warmedUp();
    const leaking = (i: number): Overrides => ({
      payments: { rssMb: 85 + 4 * i, latencyP95Ms: 800, errorRatio: 0.5 },
    });
    const ramp = Array.from({ length: 18 }, (_, i) => poll(next + i, leaking(i)));
    const steps = run(state, ramp);
    const before = steps[steps.length - 1].state;
    expect(before.forecast.payments.warning).toBe(true);
    const confirmedPairs = (['latencyP95Ms', 'errorRatio', 'rssMb'] as const).filter(
      (signal) => before.tracking.payments[signal].confirmed,
    );
    expect(confirmedPairs.length).toBeGreaterThanOrEqual(2);

    const restart = stepIntelligence(before, poll(next + 18, {}, ['payments']), CONFIG);
    expect(restart.events[0]).toEqual({
      type: 'forecast:cleared',
      service: 'payments',
      reason: 'memory-dropped',
    });
    const cleared = restart.events.filter((e) => e.type === 'anomaly:cleared');
    expect(cleared).toEqual(
      confirmedPairs.map((signal) => ({ type: 'anomaly:cleared', service: 'payments', signal })),
    );
    expect(restart.state.baselines.payments).toEqual(before.baselines.payments);
    expect(restart.state.forecast.payments.window).toEqual([]);
    expect(intelligenceView(restart.state, CHAIN).forecasts.map((f) => f.service)).not.toContain(
      'payments',
    );
  });

  it('flapping up gives one detected and one cleared per cycle when confirmPolls anomalous Polls separate the outages', () => {
    const { state, next } = warmedUp();
    const cycle = (c: number): IntelligenceInput[] => {
      const base = next + c * 3;
      return [
        poll(base, { payments: SPIKE }),
        poll(base + 1, { payments: SPIKE }),
        poll(base + 2, {}, ['payments']),
      ];
    };
    const cycles = 3;
    const steps = run(state, [0, 1, 2].slice(0, cycles).flatMap(cycle));
    const events = steps.flatMap((s) => latencyEvents(s.events, 'payments'));
    expect(events).toEqual(Array.from({ length: cycles }, () => ['anomaly:detected', 'anomaly:cleared']).flat());
    // The clear happens in the Poll where the service went down.
    expect(latencyEvents(steps[2].events, 'payments')).toEqual(['anomaly:cleared']);
  });

  it('flapping up with fewer than confirmPolls anomalous Polls between outages emits nothing', () => {
    const { state, next } = warmedUp();
    const inputs = Array.from({ length: 3 }, (_, c) => [
      poll(next + c * 2, { payments: SPIKE }),
      poll(next + c * 2 + 1, {}, ['payments']),
    ]).flat();
    const steps = run(state, inputs);
    expect(steps.flatMap((s) => latencyEvents(s.events, 'payments'))).toEqual([]);
  });

  it('puts forecast events before anomaly events', () => {
    const { state, next } = warmedUp();
    const leaking = (i: number): Overrides => ({
      payments: { rssMb: 85 + 4 * i, latencyP95Ms: 800, errorRatio: 0.5 },
    });
    const steps = run(
      state,
      Array.from({ length: 18 }, (_, i) => poll(next + i, leaking(i))),
    );
    // Down in the Poll after the warning: forecast:cleared must precede the anomaly:cleared events.
    const restart = stepIntelligence(steps[steps.length - 1].state, poll(next + 18, {}, ['payments']), CONFIG);
    const types = restart.events.map((e) => e.type);
    expect(types).toContain('anomaly:cleared');
    const lastForecast = Math.max(...types.map((t, i) => (t.startsWith('forecast:') ? i : -1)));
    const firstAnomaly = types.findIndex((t) => t.startsWith('anomaly:'));
    expect(lastForecast).toBeGreaterThan(-1);
    expect(lastForecast).toBeLessThan(firstAnomaly);
  });
});
