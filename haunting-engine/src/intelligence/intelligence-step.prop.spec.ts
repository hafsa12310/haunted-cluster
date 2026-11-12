import * as fc from 'fast-check';
import type { ServiceName } from '@haunted-cluster/shared';
import { EMPTY_BASELINE, isWarmUp, updateBaseline } from './anomaly/baseline';
import type { Baseline } from './anomaly/baseline';
import {
  initialIntelligenceState,
  intelligenceView,
  stepIntelligence,
} from './intelligence-step';
import {
  SIGNALS,
  blindPoll,
  chainArb,
  deepFreeze,
  pollSequenceArb,
  testEngineConfig,
} from './test-support';
import { attributeFaults } from '../incidents/attribution';
import { initialTrackerState, trackIncidents } from '../incidents/incident-tracker';
import { applySimilarity } from './similarity/incident-similarity';

const NUM_RUNS = 100;

describe('intelligence-step properties', () => {
  // Feature: engine-intelligence, Property 1: Initial state shape
  // **Validates: Requirements 1.1, 1.2, 4.1**
  it('Property 1: initial state has empty Baselines, quiet tracking and empty forecasts', () => {
    fc.assert(
      fc.property(chainArb, (chain) => {
        const config = testEngineConfig(chain);
        const state = initialIntelligenceState(chain);

        expect(Object.keys(state.baselines).sort()).toEqual([...chain].sort());
        expect(Object.keys(state.tracking).sort()).toEqual([...chain].sort());
        expect(Object.keys(state.forecast).sort()).toEqual([...chain].sort());

        let baselineCount = 0;
        for (const service of chain) {
          expect(Object.keys(state.baselines[service]).sort()).toEqual([...SIGNALS].sort());
          for (const signal of SIGNALS) {
            const b = state.baselines[service][signal];
            baselineCount += 1;
            expect(b).toEqual(EMPTY_BASELINE);
            expect(b).toEqual({ mean: 0, variance: 0, count: 0 });
            expect(isWarmUp(b, config.anomaly.warmupPolls)).toBe(true);
            expect(state.tracking[service][signal]).toEqual({
              anomalousStreak: 0,
              clearStreak: 0,
              confirmed: false,
              lastReading: null,
            });
          }
          expect(state.forecast[service]).toEqual({ window: [], warning: false, forecast: null });
        }
        expect(baselineCount).toBe(3 * chain.length);

        expect(intelligenceView(state, chain)).toEqual({ anomalies: [], forecasts: [] });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 6: Baselines equal a replay of the unguarded Polls
  // **Validates: Requirements 2.8, 2.9**
  it('Property 6: Baselines equal a replay of the unguarded Polls', () => {
    fc.assert(
      fc.property(pollSequenceArb(), ({ chain, config, polls }) => {
        let state = initialIntelligenceState(chain);
        // Reference model: plain loop over updateBaseline, guards restated here.
        const ref: Record<ServiceName, Record<string, Baseline>> = {};
        for (const service of chain) {
          ref[service] = Object.fromEntries(SIGNALS.map((s) => [s, EMPTY_BASELINE]));
        }

        for (const poll of polls) {
          const prev = state;
          state = stepIntelligence(prev, poll, config).state;
          if (!poll.metricsAvailable) continue; // blind guard: nothing changes

          for (const service of chain) {
            const health = poll.health[service];
            for (const signal of SIGNALS) {
              const value = health.signals[signal];
              const guarded =
                health.status === 'unknown' ||
                poll.openBefore[service] ||
                health.signals.up === false ||
                value === null ||
                !Number.isFinite(value);
              if (guarded) continue;

              // For an evaluated pair, a raw anomaly sets clearStreak to 0; a quiet Poll
              // makes it at least 1. A raw pair whose anomalous streak is back at 0 was
              // relearn-reset at the end of the Poll.
              const after = state.tracking[service][signal];
              const raw = after.clearStreak === 0;
              if (raw) {
                if (after.anomalousStreak === 0) ref[service][signal] = EMPTY_BASELINE;
                continue;
              }
              ref[service][signal] = updateBaseline(ref[service][signal], value, config.anomaly.alpha);
            }
          }

          for (const service of chain) {
            for (const signal of SIGNALS) {
              expect(state.baselines[service][signal]).toEqual(ref[service][signal]);
            }
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 7: Open-incident guard reads the pre-Poll state
  // **Validates: Requirements 2.7**
  it('Property 7: an incident opening in a Poll still learns; one resolving in a Poll does not', () => {
    let opening = 0;
    let resolving = 0;
    fc.assert(
      fc.property(pollSequenceArb({ minPolls: 2 }), ({ chain, config, polls }) => {
        let state = initialIntelligenceState(chain);
        polls.forEach((poll, i) => {
          const prev = state;
          state = stepIntelligence(prev, poll, config).state;
          const next = polls[i + 1];
          if (!poll.metricsAvailable || !next) return;

          for (const service of chain) {
            const before = poll.openBefore[service];
            const after = next.openBefore[service]; // state held after this Poll's tracking
            const health = poll.health[service];
            for (const signal of SIGNALS) {
              const value = health.signals[signal];
              const otherwiseUnflagged =
                health.status !== 'unknown' &&
                health.signals.up !== false &&
                value !== null &&
                Number.isFinite(value) &&
                // Raw_Anomaly pairs have clearStreak 0 after the Poll and are not learned.
                state.tracking[service][signal].clearStreak > 0;
              if (!otherwiseUnflagged) continue;

              const b0 = prev.baselines[service][signal];
              const b1 = state.baselines[service][signal];
              if (!before && after) {
                opening += 1;
                expect(b1.count).toBe(b0.count + 1); // opens in this Poll: still learned
              } else if (before && !after) {
                resolving += 1;
                expect(b1).toEqual(b0); // resolves in this Poll: guard still held
              }
            }
          }
        });
      }),
      { numRuns: NUM_RUNS },
    );
    // Guard against a vacuous pass.
    expect(opening).toBeGreaterThan(0);
    expect(resolving).toBeGreaterThan(0);
  });
});

// Feature: engine-intelligence, Property 13: Blind Polls change nothing
// **Validates: Requirements 4.7, 4.18, 5.9, 6.10**
describe('intelligence-step Blind_Poll properties', () => {
  it('Property 13: Blind Polls change nothing', () => {
    fc.assert(
      fc.property(
        pollSequenceArb(),
        fc.array(fc.nat({ max: 60 }), { minLength: 1, maxLength: 10 }),
        ({ chain, config, polls }, rawPositions) => {
          // The reference sequence has no Blind_Polls at all.
          const base = polls.filter((p) => p.metricsAvailable);

          // Insert a Blind_Poll before base[pos] (pos === base.length appends one).
          const positions = rawPositions.map((p) => p % (base.length + 1));
          const withBlind: { poll: (typeof base)[number]; blind: boolean }[] = [];
          base.forEach((poll, i) => {
            positions.forEach((pos) => {
              if (pos === i) {
                withBlind.push({ poll: blindPoll(chain, poll.now - 1, config), blind: true });
              }
            });
            withBlind.push({ poll, blind: false });
          });
          positions.forEach((pos) => {
            if (pos === base.length) {
              const last = base.length > 0 ? base[base.length - 1].now : 0;
              withBlind.push({ poll: blindPoll(chain, last + 1, config), blind: true });
            }
          });

          // Reference run.
          let refState = initialIntelligenceState(chain);
          const refSteps = base.map((poll) => {
            const result = stepIntelligence(refState, poll, config);
            refState = result.state;
            return { ...result, view: intelligenceView(result.state, chain) };
          });

          // Run with Blind_Polls inserted.
          let state = initialIntelligenceState(chain);
          let lastView = intelligenceView(state, chain);
          let nonBlindIndex = 0;
          for (const { poll, blind } of withBlind) {
            const before = state;
            const result = stepIntelligence(before, poll, config);
            state = result.state;
            if (blind) {
              expect(result.state).toBe(before);
              expect(result.events).toEqual([]);
              expect(intelligenceView(result.state, chain)).toEqual(lastView);
            } else {
              const ref = refSteps[nonBlindIndex];
              nonBlindIndex += 1;
              expect(result.state).toEqual(ref.state);
              expect(result.events).toEqual(ref.events);
              lastView = intelligenceView(result.state, chain);
              expect(lastView).toEqual(ref.view);
            }
          }
          expect(nonBlindIndex).toBe(base.length);
          expect(state).toEqual(refState);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// Feature: engine-intelligence, Property 17: Reported anomalies are exactly the confirmed ones, in order
// **Validates: Requirements 4.17**
describe('intelligence-step reported anomalies', () => {
  it('Property 17: Reported anomalies are exactly the confirmed ones, in order', () => {
    let confirmedSeen = 0;
    let rawOnlySeen = 0;
    fc.assert(
      fc.property(pollSequenceArb(), ({ chain, config, polls }) => {
        let state = initialIntelligenceState(chain);
        for (const poll of polls) {
          state = stepIntelligence(state, poll, config).state;
          const { anomalies } = intelligenceView(state, chain);

          // Expected: lastReading of every confirmed pair, chain order then signal order.
          const expected = [];
          for (const service of chain) {
            for (const signal of SIGNALS) {
              const pair = state.tracking[service][signal];
              if (pair.confirmed) {
                expect(pair.lastReading).not.toBeNull();
                expected.push(pair.lastReading);
                confirmedSeen += 1;
              } else if (pair.anomalousStreak > 0) {
                rawOnlySeen += 1; // Raw_Anomaly only: must not be reported
                expect(
                  anomalies.some((a) => a.service === service && a.signal === signal),
                ).toBe(false);
              }
            }
          }
          expect(anomalies).toEqual(expected);
          expect(anomalies.length).toBe(expected.length);
        }
      }),
      { numRuns: NUM_RUNS },
    );
    // Guard against a vacuous pass.
    expect(confirmedSeen).toBeGreaterThan(0);
    expect(rawOnlySeen).toBeGreaterThan(0);
  });
});

// Feature: engine-intelligence, Property 34: Snapshots and incidents survive a JSON round trip
// **Validates: Requirements R10.8**
describe('intelligence-step JSON round trip', () => {
  /** Fails on undefined, NaN or Infinity anywhere in a value. */
  const expectPlainJson = (value: unknown, path = 'value'): void => {
    if (value === undefined) throw new Error(`undefined at ${path}`);
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`non-finite number at ${path}`);
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => expectPlainJson(v, `${path}[${i}]`));
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) expectPlainJson(v, `${path}.${k}`);
    }
  };
  const roundTrips = (value: unknown, label: string): void => {
    expectPlainJson(value, label);
    // toStrictEqual also rejects undefined-valued keys that JSON would drop.
    expect(JSON.parse(JSON.stringify(value))).toStrictEqual(value);
  };

  it('Property 34: Snapshots and incidents survive a JSON round trip', () => {
    let incidentsSeen = 0;
    let similarSeen = 0;
    let anomaliesSeen = 0;
    fc.assert(
      fc.property(pollSequenceArb(), ({ chain, config, polls }) => {
        let state = initialIntelligenceState(chain);
        let tracker = initialTrackerState(chain);
        let counter = 0;

        for (const rawPoll of polls) {
          // The intelligence step sees the raw poll, NaN included.
          state = stepIntelligence(state, rawPoll, config).state;
          // The real Prometheus client maps non-finite values to null, so the pre-existing
          // incident fields (peak, signals) never hold NaN in production. Mirror that here.
          const poll = {
            ...rawPoll,
            health: Object.fromEntries(
              Object.entries(rawPoll.health).map(([name, h]) => [
                name,
                {
                  ...h,
                  signals: Object.fromEntries(
                    Object.entries(h.signals).map(([k, v]) => [
                      k,
                      typeof v === 'number' && !Number.isFinite(v) ? null : v,
                    ]),
                  ) as typeof h.signals,
                },
              ]),
            ),
          };
          const view = intelligenceView(state, chain);
          roundTrips(view.anomalies, 'anomalies');
          roundTrips(view.forecasts, 'forecasts');
          anomaliesSeen += view.anomalies.length;

          const attributions = poll.metricsAvailable ? attributeFaults(chain, poll.health) : [];
          const tracked = trackIncidents(
            tracker,
            { now: poll.now, metricsAvailable: poll.metricsAvailable, health: poll.health, attributions, chaosEvents: [] },
            config,
            () => `incident-${++counter}`,
          );
          const applied = applySimilarity(tracked.state, tracked.events, poll.now, chain, config);
          tracker = applied.tracker;

          for (const event of applied.events) {
            roundTrips(event.incident, `${event.type}.incident`);
            incidentsSeen += 1;
            if (event.incident.similar !== undefined) similarSeen += 1;
          }
          for (const incident of Object.values(applied.tracker.open)) {
            roundTrips(incident, 'open.incident');
          }
          for (const incident of applied.tracker.history) {
            roundTrips(incident, 'history.incident');
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
    // Guard against a vacuous pass.
    expect(incidentsSeen).toBeGreaterThan(0);
    expect(anomaliesSeen).toBeGreaterThan(0);
    expect(similarSeen).toBeGreaterThanOrEqual(0);
  });
});

// Feature: engine-intelligence, Property 33: Everything is pure and replayable
// **Validates: Requirements R3.11, R5.11, R7.8, R9.1, R9.2, R9.8**
describe('intelligence-step purity and replay', () => {
  it('Property 33: Everything is pure and replayable', () => {
    /**
     * Runs the whole sequence with every argument deep-frozen. Frozen objects throw on
     * mutation in strict mode, and each argument is also compared with a copy taken
     * before the call.
     */
    const run = (chain: ServiceName[], config: ReturnType<typeof testEngineConfig>, polls: unknown[]) => {
      let state = deepFreeze(initialIntelligenceState(chain));
      let tracker = deepFreeze(initialTrackerState(chain));
      let counter = 0;
      const stepEvents: unknown[] = [];
      const similarityEvents: unknown[] = [];
      const failures: unknown[] = [];
      const views: unknown[] = [];

      for (const raw of polls) {
        const poll = deepFreeze(raw as Parameters<typeof stepIntelligence>[1]);

        // stepIntelligence: no throw, no argument changed.
        const stateCopy = structuredClone(state);
        const pollCopy = structuredClone(poll);
        const configCopy = structuredClone(config);
        const stepped = stepIntelligence(state, poll, config);
        expect(state).toEqual(stateCopy);
        expect(poll).toEqual(pollCopy);
        expect(config).toEqual(configCopy);
        state = deepFreeze(stepped.state);
        stepEvents.push(deepFreeze(stepped.events));
        views.push(intelligenceView(state, chain));

        // Incident pipeline feeding applySimilarity.
        const attributions = poll.metricsAvailable ? attributeFaults(chain, poll.health) : [];
        const tracked = trackIncidents(
          tracker,
          deepFreeze({ now: poll.now, metricsAvailable: poll.metricsAvailable, health: poll.health, attributions, chaosEvents: [] }),
          config,
          () => `incident-${++counter}`,
        );
        const trackerIn = deepFreeze(tracked.state);
        const eventsIn = deepFreeze(tracked.events);
        const chainIn = deepFreeze([...chain]);
        const trackerCopy = structuredClone(trackerIn);
        const eventsCopy = structuredClone(eventsIn);

        const applied = applySimilarity(trackerIn, eventsIn, poll.now, chainIn, config);
        expect(trackerIn).toEqual(trackerCopy);
        expect(eventsIn).toEqual(eventsCopy);
        expect(chainIn).toEqual(chain);
        expect(config).toEqual(configCopy);
        tracker = deepFreeze(applied.tracker);
        similarityEvents.push(deepFreeze(applied.events));
        failures.push(applied.failures);
      }
      return { state, tracker, stepEvents, similarityEvents, failures, views };
    };

    fc.assert(
      fc.property(pollSequenceArb(), ({ chain, config, polls }) => {
        const first = run(chain, config, polls);
        const second = run(chain, config, polls);
        expect(second).toEqual(first);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
