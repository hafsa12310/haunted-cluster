import * as fc from 'fast-check';
import type { AnomalyReading, MonitoredSignal, ServiceName } from '@haunted-cluster/shared';
import { loadEngineConfig } from '../../config/engine-config';
import type { AnomalyEvent, PairObservation, PairTracking, TrackingMap } from '../intelligence-types';
import { trackAnomalies, type TrackingContext } from './anomaly-tracker';

const CONFIG = loadEngineConfig({
  PROMETHEUS_URL: 'http://prometheus:9090',
  GATEWAY_URL: 'http://gateway:3000',
  ORDERS_URL: 'http://orders:3001',
  PAYMENTS_URL: 'http://payments:3002',
});
const CHAIN: readonly ServiceName[] = CONFIG.serviceChain;
const SIGNALS: readonly MonitoredSignal[] = ['latencyP95Ms', 'errorRatio', 'rssMb'];

const SERVICE: ServiceName = CHAIN[0];
const SIGNAL: MonitoredSignal = 'latencyP95Ms';

const emptyPair = (): PairTracking => ({
  anomalousStreak: 0,
  clearStreak: 0,
  confirmed: false,
  lastReading: null,
});

function emptyTracking(): TrackingMap {
  const map = {} as TrackingMap;
  for (const service of CHAIN) {
    const perSignal = {} as Record<MonitoredSignal, PairTracking>;
    for (const signal of SIGNALS) perSignal[signal] = emptyPair();
    map[service] = perSignal;
  }
  return map;
}

function contextOf(): TrackingContext {
  const flags = {} as Record<ServiceName, boolean>;
  for (const service of CHAIN) flags[service] = false;
  return { openBefore: { ...flags }, leakSuspected: { ...flags } };
}

const readingAt = (index: number): AnomalyReading => ({
  service: SERVICE,
  signal: SIGNAL,
  value: 100 + index,
  baselineMean: 10,
  baselineStdDev: 1,
  zScore: 5,
  method: 'learned',
});

// Runs of anomalous / clear Polls, so that both short and long runs show up often.
const runsArb = fc
  .array(
    fc.record({ anomalous: fc.boolean(), length: fc.integer({ min: 1, max: 8 }) }),
    { maxLength: 12 },
  )
  .map((runs) => runs.flatMap((run) => Array<boolean>(run.length).fill(run.anomalous)));

describe('anomaly-tracker properties', () => {
  // Feature: engine-intelligence, Property 12: Confirmation and clearing events fire once, at the right Poll
  // **Validates: Requirements R4.2, R4.3, R4.4, R4.5, R4.6**
  it('Property 12: Confirmation and clearing events fire once, at the right Poll', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), runsArb, (confirmPolls, polls) => {
        const config = { ...CONFIG.anomaly, confirmPolls, relearnPolls: 1_000_000 };
        let tracking = emptyTracking();
        let confirmed = false;
        let anomalousRun = 0;
        let clearRun = 0;
        let eventCount = 0;
        let longestRun = 0;

        polls.forEach((anomalous, index) => {
          const reading = anomalous ? readingAt(index) : null;
          const observations: PairObservation[] = [
            { service: SERVICE, signal: SIGNAL, kind: 'evaluated', reading },
          ];
          const result = trackAnomalies(tracking, observations, contextOf(), config);
          tracking = result.tracking;

          // Expected streaks equal the length of the current run (R4.2, R4.3).
          anomalousRun = anomalous ? anomalousRun + 1 : 0;
          clearRun = anomalous ? 0 : clearRun + 1;
          longestRun = Math.max(longestRun, anomalousRun, clearRun);
          const pair = tracking[SERVICE][SIGNAL];
          expect(pair.anomalousStreak).toBe(anomalousRun);
          expect(pair.clearStreak).toBe(clearRun);

          // Expected event for this Poll (R4.4, R4.5, R4.6).
          let expected: AnomalyEvent | null = null;
          if (anomalous && anomalousRun === confirmPolls && !confirmed) {
            expected = { type: 'anomaly:detected', reading: readingAt(index) };
            confirmed = true;
          } else if (!anomalous && clearRun === confirmPolls && confirmed) {
            expected = { type: 'anomaly:cleared', service: SERVICE, signal: SIGNAL };
            confirmed = false;
          }

          expect(result.events).toEqual(expected === null ? [] : [expected]);
          expect(pair.confirmed).toBe(confirmed);
          if (expected !== null) eventCount += 1;
        });

        // A sequence whose runs never reach confirmPolls produces no event at all.
        if (longestRun < confirmPolls) expect(eventCount).toBe(0);
      }),
      { numRuns: 200 },
    );
  });
});

describe('anomaly-tracker properties: unknown, down and unusable observations', () => {
  const pairTrackingArb: fc.Arbitrary<PairTracking> = fc
    .record({
      anomalousStreak: fc.integer({ min: 0, max: 10 }),
      clearStreak: fc.integer({ min: 0, max: 10 }),
      confirmed: fc.boolean(),
      hasReading: fc.boolean(),
      index: fc.integer({ min: 0, max: 50 }),
    })
    .map(({ hasReading, index, ...rest }) => ({
      ...rest,
      lastReading: hasReading ? readingAt(index) : null,
    }));

  const trackingArb: fc.Arbitrary<TrackingMap> = fc
    .array(pairTrackingArb, {
      minLength: CHAIN.length * SIGNALS.length,
      maxLength: CHAIN.length * SIGNALS.length,
    })
    .map((pairs) => {
      const map = {} as TrackingMap;
      let i = 0;
      for (const service of CHAIN) {
        const perSignal = {} as Record<MonitoredSignal, PairTracking>;
        for (const signal of SIGNALS) perSignal[signal] = pairs[i++];
        map[service] = perSignal;
      }
      return map;
    });

  type NonEvaluatedKind = 'unknown-service' | 'down-service' | 'unusable';
  // For each pair: no observation (undefined) or one of the three kinds.
  const kindArb = fc.option(
    fc.constantFrom<NonEvaluatedKind>('unknown-service', 'down-service', 'unusable'),
    { nil: undefined },
  );
  const kindsArb = fc.array(kindArb, {
    minLength: CHAIN.length * SIGNALS.length,
    maxLength: CHAIN.length * SIGNALS.length,
  });

  const flagsArb = fc
    .array(fc.boolean(), { minLength: CHAIN.length, maxLength: CHAIN.length })
    .map((values) => {
      const flags = {} as Record<ServiceName, boolean>;
      CHAIN.forEach((service, i) => (flags[service] = values[i]));
      return flags;
    });

  // Feature: engine-intelligence, Property 14: Unknown and down services clear at once and unusable values freeze the pair
  // **Validates: Requirements R2.5, R4.10, R4.11, R4.12**
  it('Property 14: Unknown and down services clear at once and unusable values freeze the pair', () => {
    fc.assert(
      fc.property(
        trackingArb,
        kindsArb,
        flagsArb,
        flagsArb,
        fc.integer({ min: 1, max: 5 }),
        (prev, kinds, openBefore, leakSuspected, relearnPolls) => {
          const config = { ...CONFIG.anomaly, relearnPolls };
          const observations: PairObservation[] = [];
          const kindOf = new Map<string, NonEvaluatedKind | undefined>();
          let i = 0;
          for (const service of CHAIN) {
            for (const signal of SIGNALS) {
              const kind = kinds[i++];
              kindOf.set(`${service}|${signal}`, kind);
              if (kind !== undefined) observations.push({ service, signal, kind });
            }
          }

          const result = trackAnomalies(
            prev,
            observations,
            { openBefore, leakSuspected },
            config,
          );

          // Expected cleared events, in chain then signal order.
          const expectedEvents: AnomalyEvent[] = [];
          for (const service of CHAIN) {
            for (const signal of SIGNALS) {
              const kind = kindOf.get(`${service}|${signal}`);
              const before = prev[service][signal];
              const after = result.tracking[service][signal];
              if (kind === 'unknown-service' || kind === 'down-service') {
                expect(after).toEqual({
                  anomalousStreak: 0,
                  clearStreak: 0,
                  confirmed: false,
                  lastReading: null,
                });
                if (before.confirmed) {
                  expectedEvents.push({ type: 'anomaly:cleared', service, signal });
                }
              } else {
                // unusable, or no observation: the pair is untouched.
                expect(after).toEqual(before);
              }
            }
          }

          expect(result.events).toEqual(expectedEvents);
          expect(result.relearn).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('anomaly-tracker properties: relearning', () => {
  interface RelearnPoll {
    /** Anomalous flag per pair, chain order then signal order. */
    anomalous: boolean[];
    openBefore: boolean[];
    leakSuspected: boolean[];
  }

  const PAIR_COUNT = CHAIN.length * SIGNALS.length;
  const biasedBool = (trueWeight: number): fc.Arbitrary<boolean> =>
    fc.oneof(
      { arbitrary: fc.constant(true), weight: trueWeight },
      { arbitrary: fc.constant(false), weight: 10 - trueWeight },
    );

  // Mostly anomalous so streaks reach relearnPolls; flags toggle so suppression ends too.
  const pollArb = (openWeight: number, leakWeight: number): fc.Arbitrary<RelearnPoll> =>
    fc.record({
      anomalous: fc.array(biasedBool(8), { minLength: PAIR_COUNT, maxLength: PAIR_COUNT }),
      openBefore: fc.array(biasedBool(openWeight), {
        minLength: CHAIN.length,
        maxLength: CHAIN.length,
      }),
      leakSuspected: fc.array(biasedBool(leakWeight), {
        minLength: CHAIN.length,
        maxLength: CHAIN.length,
      }),
    });

  const pollsArb = (openWeight: number, leakWeight: number): fc.Arbitrary<RelearnPoll[]> =>
    fc.array(pollArb(openWeight, leakWeight), { minLength: 1, maxLength: 30 });

  const reading = (service: ServiceName, signal: MonitoredSignal, index: number): AnomalyReading => ({
    service,
    signal,
    value: 100 + index,
    baselineMean: 10,
    baselineStdDev: 1,
    zScore: 5,
    method: 'learned',
  });

  interface ModelPair {
    anomalousStreak: number;
    clearStreak: number;
    confirmed: boolean;
    lastReading: AnomalyReading | null;
  }

  /**
   * Independent reference model: runs every Poll through the plain rules and
   * checks the tracker against it. Returns, per Poll, the relearn keys it expects.
   */
  function checkAgainstModel(
    polls: RelearnPoll[],
    confirmPolls: number,
    relearnPolls: number,
    onPoll: (info: {
      pollIndex: number;
      poll: RelearnPoll;
      pairIndex: number;
      service: ServiceName;
      signal: MonitoredSignal;
      streakBefore: number;
      streakCounted: number;
      relearned: boolean;
    }) => void,
  ): void {
    const config = { ...CONFIG.anomaly, confirmPolls, relearnPolls };
    let tracking = emptyTracking();
    const model: ModelPair[] = Array.from({ length: PAIR_COUNT }, () => emptyPair());

    polls.forEach((poll, pollIndex) => {
      const observations: PairObservation[] = [];
      CHAIN.forEach((service, s) =>
        SIGNALS.forEach((signal, g) => {
          const p = s * SIGNALS.length + g;
          observations.push({
            service,
            signal,
            kind: 'evaluated',
            reading: poll.anomalous[p] ? reading(service, signal, pollIndex) : null,
          });
        }),
      );
      const openBefore = {} as Record<ServiceName, boolean>;
      const leakSuspected = {} as Record<ServiceName, boolean>;
      CHAIN.forEach((service, s) => {
        openBefore[service] = poll.openBefore[s];
        leakSuspected[service] = poll.leakSuspected[s];
      });

      const result = trackAnomalies(tracking, observations, { openBefore, leakSuspected }, config);
      tracking = result.tracking;

      const expectedRelearn: { service: ServiceName; signal: MonitoredSignal }[] = [];
      CHAIN.forEach((service, s) =>
        SIGNALS.forEach((signal, g) => {
          const p = s * SIGNALS.length + g;
          const m = model[p];
          const streakBefore = m.anomalousStreak;
          let streakCounted: number;
          if (poll.anomalous[p]) {
            streakCounted = m.anomalousStreak + 1;
            m.clearStreak = 0;
            m.lastReading = reading(service, signal, pollIndex);
            if (streakCounted === confirmPolls) m.confirmed = true;
          } else {
            streakCounted = 0;
            m.clearStreak += 1;
            if (m.clearStreak === confirmPolls && m.confirmed) {
              m.confirmed = false;
              m.lastReading = null;
            }
          }
          m.anomalousStreak = streakCounted;

          const eligible =
            streakCounted >= relearnPolls &&
            !poll.openBefore[s] &&
            !(signal === 'rssMb' && poll.leakSuspected[s]);
          if (eligible) {
            expectedRelearn.push({ service, signal });
            m.anomalousStreak = 0;
            m.clearStreak = 0;
          }

          // Streaks reset on relearn; confirmed and lastReading are untouched by the reset.
          expect(tracking[service][signal]).toEqual(m);
          onPoll({
            pollIndex,
            poll,
            pairIndex: p,
            service,
            signal,
            streakBefore,
            streakCounted,
            relearned: eligible,
          });
        }),
      );

      expect(result.relearn).toEqual(expectedRelearn);
    });
  }

  // Feature: engine-intelligence, Property 15: Relearn happens in exactly the first eligible Poll
  // **Validates: Requirements R4.8, R4.9, R4.13, R4.15**
  it('Property 15: Relearn happens in exactly the first eligible Poll', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 6 }),
        pollsArb(3, 3),
        (confirmPolls, relearnPolls, polls) => {
          checkAgainstModel(polls, confirmPolls, relearnPolls, (info) => {
            const ineligibleByFlags =
              info.poll.openBefore[Math.floor(info.pairIndex / SIGNALS.length)] ||
              (info.signal === 'rssMb' &&
                info.poll.leakSuspected[Math.floor(info.pairIndex / SIGNALS.length)]);
            // Relearn exactly when the counted streak reached the threshold and no guard applies.
            expect(info.relearned).toBe(info.streakCounted >= relearnPolls && !ineligibleByFlags);
            // The streak is never capped while suppressed: it counts on by one per anomalous Poll.
            if (info.streakCounted > 0) expect(info.streakCounted).toBe(info.streakBefore + 1);
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: engine-intelligence, Property 16: A suspected leak is never relearned as normal
  // **Validates: Requirements R4.14, R4.15, R4.16**
  it('Property 16: A suspected leak is never relearned as normal', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 6 }),
        pollsArb(1, 7),
        (confirmPolls, relearnPolls, polls) => {
          const config = { ...CONFIG.anomaly, confirmPolls, relearnPolls };
          let tracking = emptyTracking();

          polls.forEach((poll, pollIndex) => {
            const observations: PairObservation[] = [];
            const openBefore = {} as Record<ServiceName, boolean>;
            const leakSuspected = {} as Record<ServiceName, boolean>;
            CHAIN.forEach((service, s) => {
              openBefore[service] = poll.openBefore[s];
              leakSuspected[service] = poll.leakSuspected[s];
              SIGNALS.forEach((signal, g) => {
                observations.push({
                  service,
                  signal,
                  kind: 'evaluated',
                  reading: poll.anomalous[s * SIGNALS.length + g]
                    ? reading(service, signal, pollIndex)
                    : null,
                });
              });
            });

            const before = tracking;
            const result = trackAnomalies(before, observations, { openBefore, leakSuspected }, config);
            tracking = result.tracking;

            CHAIN.forEach((service, s) => {
              const rssAnomalous = poll.anomalous[s * SIGNALS.length + 2];
              const rssRelearned = result.relearn.some(
                (key) => key.service === service && key.signal === 'rssMb',
              );
              if (poll.leakSuspected[s]) {
                // Never relearned while the leak is suspected, and the streak keeps counting.
                expect(rssRelearned).toBe(false);
                expect(tracking[service].rssMb.anomalousStreak).toBe(
                  rssAnomalous ? before[service].rssMb.anomalousStreak + 1 : 0,
                );
              }
              // The other signals of the same service are not held back by Leak_Suspicion.
              for (const signal of ['latencyP95Ms', 'errorRatio'] as const) {
                const g = SIGNALS.indexOf(signal);
                const counted = poll.anomalous[s * SIGNALS.length + g]
                  ? before[service][signal].anomalousStreak + 1
                  : 0;
                const relearned = result.relearn.some(
                  (key) => key.service === service && key.signal === signal,
                );
                expect(relearned).toBe(counted >= relearnPolls && !poll.openBefore[s]);
              }
            });
          });
        },
      ),
      { numRuns: 200 },
    );
  });
});
