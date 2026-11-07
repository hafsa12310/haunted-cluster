import * as fc from 'fast-check';
import type { Incident, ServiceHealth, ServiceName, SignalKind } from '@haunted-cluster/shared';
import { EngineConfig, loadEngineConfig } from '../config/engine-config';
import type { Attribution } from './attribution';
import {
  fingerprint,
  IncidentEvent,
  initialTrackerState,
  PollInput,
  trackIncidents,
  TrackerState,
} from './incident-tracker';

const NUM_RUNS = 200;

const DEFAULT_CONFIG = loadEngineConfig({
  PROMETHEUS_URL: 'http://prometheus:9090',
  GATEWAY_URL: 'http://gateway:3000',
  ORDERS_URL: 'http://orders:3001',
  PAYMENTS_URL: 'http://payments:3002',
});

const CHAIN = DEFAULT_CONFIG.serviceChain;

/** Default config, or one with other open/close thresholds so the hysteresis isn't only tested at 2/3. */
const configArb: fc.Arbitrary<EngineConfig> = fc.oneof(
  fc.constant(DEFAULT_CONFIG),
  fc
    .record({
      openAfterPolls: fc.integer({ min: 1, max: 4 }),
      closeAfterPolls: fc.integer({ min: 1, max: 4 }),
    })
    .map((overrides) => ({ ...DEFAULT_CONFIG, ...overrides })),
);

/** One service in one Poll: not a root, invisible to Prometheus, or a root with these kinds. */
type ServicePoll = 'clear' | 'unknown' | SignalKind[];

/** A Poll as a per-service root set, plus whether Prometheus answered. */
interface PollSpec {
  metricsAvailable: boolean;
  services: Record<ServiceName, ServicePoll>;
}

/** Root kinds without `down`, so only the normal open threshold applies. */
const nonDownKindsArb: fc.Arbitrary<SignalKind[]> = fc
  .subarray<SignalKind>(['errors', 'latency', 'memory'], { minLength: 1 })
  .map((kinds) => [...kinds]);

const servicePollArb: fc.Arbitrary<ServicePoll> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<ServicePoll>('clear') },
  { weight: 1, arbitrary: fc.constant<ServicePoll>('unknown') },
  { weight: 4, arbitrary: nonDownKindsArb },
);

const pollSpecArb: fc.Arbitrary<PollSpec> = fc.record({
  // Mostly available, with enough blind Polls to test that they don't count.
  metricsAvailable: fc.oneof(
    { weight: 4, arbitrary: fc.constant(true) },
    { weight: 1, arbitrary: fc.constant(false) },
  ),
  services: fc.record(Object.fromEntries(CHAIN.map((s) => [s, servicePollArb]))),
});

/** 1–40 Polls. */
const pollsArb = fc.array(pollSpecArb, { minLength: 1, maxLength: 40 });

function healthFor(service: ServiceName, poll: ServicePoll): ServiceHealth {
  if (Array.isArray(poll) && poll.includes('down')) {
    // As scoreService reports a crashed service.
    return {
      service,
      status: 'down',
      score: 0,
      signals: { requestRate: null, errorRatio: null, latencyP95Ms: null, rssMb: null, up: false },
      badness: { latency: 0, errors: 0, memory: 0 },
      breachedKinds: ['down'],
    };
  }
  const unknown = poll === 'unknown';
  const kinds = Array.isArray(poll) ? poll : [];
  return {
    service,
    status: unknown ? 'unknown' : kinds.length > 0 ? 'degraded' : 'healthy',
    score: unknown ? null : kinds.length > 0 ? 50 : 100,
    signals: {
      requestRate: unknown ? null : 10,
      errorRatio: unknown ? null : kinds.includes('errors') ? 0.1 : 0,
      latencyP95Ms: unknown ? null : kinds.includes('latency') ? 500 : 50,
      rssMb: unknown ? null : kinds.includes('memory') ? 180 : 100,
      up: unknown ? null : true,
    },
    badness: {
      errors: kinds.includes('errors') ? 0.5 : 0,
      latency: kinds.includes('latency') ? 0.5 : 0,
      memory: kinds.includes('memory') ? 0.5 : 0,
    },
    breachedKinds: kinds,
  };
}

/** Builds the tracker input for a Poll; attributions come straight from the root set. */
function toInput(spec: PollSpec, now: number): PollInput {
  const health = Object.fromEntries(CHAIN.map((s) => [s, healthFor(s, spec.services[s])]));
  const attributions: Attribution[] = CHAIN.flatMap((s) => {
    const poll = spec.services[s];
    return Array.isArray(poll) ? [{ rootService: s, kinds: poll, affected: [] }] : [];
  });
  return { now, metricsAvailable: spec.metricsAvailable, health, attributions, chaosEvents: [] };
}

/** Feeds Polls to the tracker, one `pollIntervalMs` apart, with a counter for IDs. */
function* runPolls(
  polls: PollSpec[],
  config: EngineConfig,
): Generator<{ spec: PollSpec; state: TrackerState; events: IncidentEvent[] }> {
  let state = initialTrackerState(CHAIN);
  let nextId = 0;
  const newId = (): string => `incident-${++nextId}`;
  for (const [i, spec] of polls.entries()) {
    const result = trackIncidents(state, toInput(spec, i * config.pollIntervalMs), config, newId);
    state = result.state;
    yield { spec, state, events: result.events };
  }
}

describe('trackIncidents — property-based tests (Property 5)', () => {
  // Feature: haunting-engine, Property 5: Hysteresis on open and close
  it('Property 5: incidents open exactly when a service has been root for openAfterPolls consecutive available Polls, and resolve exactly after closeAfterPolls Polls not root', () => {
    fc.assert(
      fc.property(configArb, pollsArb, (config, polls) => {
        // Consecutive available Polls in which each service was visible and (not) root,
        // counted independently of the tracker.
        const asRoot: Record<ServiceName, number> = Object.fromEntries(CHAIN.map((s) => [s, 0]));
        const notRoot: Record<ServiceName, number> = Object.fromEntries(CHAIN.map((s) => [s, 0]));
        const open = new Set<ServiceName>();

        for (const { spec, events } of runPolls(polls, config)) {
          if (spec.metricsAvailable) {
            for (const s of CHAIN) {
              const poll = spec.services[s];
              if (poll === 'unknown') continue;
              if (Array.isArray(poll)) {
                asRoot[s] += 1;
                notRoot[s] = 0;
              } else {
                notRoot[s] += 1;
                asRoot[s] = 0;
              }
            }
          }

          const opened = new Set(
            events.filter((e) => e.type === 'opened').map((e) => e.incident.rootService),
          );
          const resolved = new Set(
            events.filter((e) => e.type === 'resolved').map((e) => e.incident.rootService),
          );

          for (const s of CHAIN) {
            const shouldOpen = !open.has(s) && asRoot[s] >= config.openAfterPolls;
            const shouldResolve = open.has(s) && notRoot[s] >= config.closeAfterPolls;
            expect({ service: s, opened: opened.has(s) }).toEqual({ service: s, opened: shouldOpen });
            expect({ service: s, resolved: resolved.has(s) }).toEqual({
              service: s,
              resolved: shouldResolve,
            });
            if (shouldOpen) open.add(s);
            if (shouldResolve) open.delete(s);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 5: Hysteresis on open and close
  it('Property 5: there is never more than one open incident per root', () => {
    fc.assert(
      fc.property(configArb, pollsArb, (config, polls) => {
        const open = new Set<ServiceName>();
        for (const { state, events } of runPolls(polls, config)) {
          for (const e of events) {
            const s = e.incident.rootService;
            if (e.type === 'opened') {
              expect(open.has(s)).toBe(false);
              open.add(s);
            } else {
              expect(open.has(s)).toBe(true);
              if (e.type === 'resolved') open.delete(s);
            }
          }
          // The state agrees with the events, and each open incident is keyed by its own root.
          expect(new Set(Object.keys(state.open))).toEqual(open);
          for (const [root, incident] of Object.entries(state.open)) {
            expect(incident.rootService).toBe(root);
            expect(incident.status).toBe('open');
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 5: Hysteresis on open and close
  it('Property 5: a root streak shorter than openAfterPolls never opens an incident', () => {
    // Random Polls rarely produce near-miss streaks, so build them directly:
    // root for k < openAfterPolls Polls, then clear, repeated.
    const nearMissArb = fc
      .integer({ min: 2, max: 4 })
      .chain((openAfterPolls) =>
        fc.tuple(
          fc.constant({ ...DEFAULT_CONFIG, openAfterPolls }),
          fc.array(fc.integer({ min: 1, max: openAfterPolls - 1 }), { minLength: 1, maxLength: 10 }),
          fc.constantFrom(...CHAIN),
          nonDownKindsArb,
        ),
      );
    fc.assert(
      fc.property(nearMissArb, ([config, runs, service, kinds]) => {
        const clear = Object.fromEntries(CHAIN.map((s) => [s, 'clear' as ServicePoll]));
        const polls: PollSpec[] = runs.flatMap((k) => [
          ...Array.from({ length: k }, () => ({
            metricsAvailable: true,
            services: { ...clear, [service]: kinds },
          })),
          { metricsAvailable: true, services: clear },
        ]);
        for (const { events } of runPolls(polls, config)) {
          expect(events).toEqual([]);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

/** Replays Polls and returns the final tracker state. */
function stateAfter(polls: PollSpec[], config: EngineConfig): TrackerState {
  let state = initialTrackerState(CHAIN);
  for (const step of runPolls(polls, config)) state = step.state;
  return state;
}

describe('trackIncidents — property-based tests (Property 6)', () => {
  // Feature: haunting-engine, Property 6: `down` opens immediately
  it('Property 6: one available Poll with a service down opens an incident for it, from any state without one', () => {
    fc.assert(
      fc.property(
        configArb,
        // Any state the tracker can reach, including the initial one.
        fc.array(pollSpecArb, { maxLength: 40 }),
        fc.constantFrom(...CHAIN),
        // The rest of the cluster in the same Poll.
        fc.record(Object.fromEntries(CHAIN.map((s) => [s, servicePollArb]))),
        (config, prefix, service, others) => {
          const before = stateAfter(prefix, config);
          fc.pre(before.open[service] === undefined);

          const spec: PollSpec = {
            metricsAvailable: true,
            services: { ...others, [service]: ['down'] },
          };
          const now = prefix.length * config.pollIntervalMs;
          const { state, events } = trackIncidents(
            before,
            toInput(spec, now),
            config,
            () => 'down-incident',
          );

          const opened = events.filter(
            (e) => e.type === 'opened' && e.incident.rootService === service,
          );
          expect(opened).toHaveLength(1);
          const incident = opened[0].incident;
          expect(incident.id).toBe('down-incident');
          expect(incident.status).toBe('open');
          expect(incident.kinds).toEqual(['down']);
          expect(incident.fingerprint).toBe(`${service}:down`);
          expect(incident.openedAt).toBe(new Date(now).toISOString());
          expect(state.open[service]).toEqual(incident);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 6: `down` opens immediately
  it('Property 6: down opens on the first Poll even when openAfterPolls is large', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 100 }), fc.constantFrom(...CHAIN), (openAfterPolls, service) => {
        const config = { ...DEFAULT_CONFIG, openAfterPolls };
        const clear = Object.fromEntries(CHAIN.map((s) => [s, 'clear' as ServicePoll]));
        const { events } = trackIncidents(
          initialTrackerState(CHAIN),
          toInput({ metricsAvailable: true, services: { ...clear, [service]: ['down'] } }, 0),
          config,
          () => 'down-incident',
        );
        expect(events.map((e) => [e.type, e.incident.rootService])).toEqual([['opened', service]]);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

/** Any service state in a Poll, including a crash, so blind Polls are tested around `down` too. */
const anyServicePollArb: fc.Arbitrary<ServicePoll> = fc.oneof(
  { weight: 6, arbitrary: servicePollArb },
  { weight: 1, arbitrary: fc.constant<ServicePoll>(['down']) },
);

const servicesArb = fc.record(Object.fromEntries(CHAIN.map((s) => [s, anyServicePollArb])));

const anyPollSpecArb: fc.Arbitrary<PollSpec> = fc.record({
  metricsAvailable: pollSpecArb.map((p) => p.metricsAvailable),
  services: servicesArb,
});

/** A blind Poll; its health and roots are random and must be ignored. */
const blindPollArb: fc.Arbitrary<PollSpec> = servicesArb.map((services) => ({
  metricsAvailable: false,
  services,
}));

/** Replays Polls and returns every event plus the final state. */
function replay(
  polls: PollSpec[],
  config: EngineConfig,
): { events: IncidentEvent[]; state: TrackerState } {
  let state = initialTrackerState(CHAIN);
  const events: IncidentEvent[] = [];
  for (const step of runPolls(polls, config)) {
    events.push(...step.events);
    state = step.state;
  }
  return { events, state };
}

/** Events compared by type, root and kinds; IDs and timestamps shift when Polls are inserted. */
const eventSummary = (events: IncidentEvent[]) =>
  events.map((e) => ({ type: e.type, root: e.incident.rootService, kinds: e.incident.kinds }));

/** Open incidents compared by root and kinds. */
const openSummary = (state: TrackerState) =>
  Object.values(state.open)
    .map((i) => ({ root: i.rootService, kinds: i.kinds }))
    .sort((a, b) => a.root.localeCompare(b.root));

describe('trackIncidents — property-based tests (Property 7)', () => {
  // Feature: haunting-engine, Property 7: Blind Polls are no-ops
  it('Property 7: inserting blind Polls anywhere changes neither the events nor the final open incidents', () => {
    fc.assert(
      fc.property(
        configArb,
        fc.array(anyPollSpecArb, { minLength: 1, maxLength: 40 }),
        fc.array(fc.tuple(fc.nat(), blindPollArb), { minLength: 1, maxLength: 20 }),
        (config, polls, insertions) => {
          const withBlind = [...polls];
          for (const [at, blind] of insertions) {
            withBlind.splice(at % (withBlind.length + 1), 0, blind);
          }

          const base = replay(polls, config);
          const blinded = replay(withBlind, config);

          expect(eventSummary(blinded.events)).toEqual(eventSummary(base.events));
          expect(openSummary(blinded.state)).toEqual(openSummary(base.state));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 7: Blind Polls are no-ops
  it('Property 7: a blind Poll returns the state unchanged and no events, from any reachable state', () => {
    fc.assert(
      fc.property(
        configArb,
        fc.array(anyPollSpecArb, { maxLength: 40 }),
        blindPollArb,
        (config, prefix, blind) => {
          const before = replay(prefix, config).state;
          const snapshot = structuredClone(before);
          const now = prefix.length * config.pollIntervalMs;

          const { state, events } = trackIncidents(before, toInput(blind, now), config, () => {
            throw new Error('a blind Poll must not create an incident');
          });

          expect(events).toEqual([]);
          expect(state).toEqual(snapshot);
          // The input state is not mutated either.
          expect(before).toEqual(snapshot);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

/** Quick open/close and a small history limit, so incidents recur and the history overflows. */
const churnConfigArb: fc.Arbitrary<EngineConfig> = fc
  .record({
    openAfterPolls: fc.integer({ min: 1, max: 2 }),
    closeAfterPolls: fc.integer({ min: 1, max: 2 }),
    incidentHistoryLimit: fc.oneof(fc.integer({ min: 1, max: 5 }), fc.constant(50)),
  })
  .map((overrides) => ({ ...DEFAULT_CONFIG, ...overrides }));

/** Recurrence per Requirement 6.2/6.3, written independently of the implementation. */
function expectedRecurrence(print: string, history: Incident[]): Incident['recurrence'] {
  const matches = history.filter((i) => i.fingerprint === print);
  if (matches.length === 0) return null;
  return {
    count: matches.length,
    lastIncidentId: matches[0].id,
    lastResolvedAt: matches[0].resolvedAt as string,
    lastDurationMs: matches[0].durationMs as number,
  };
}

describe('trackIncidents — property-based tests (Property 8)', () => {
  // Feature: haunting-engine, Property 8: Recurrence and bounded history
  it('Property 8: every opened incident carries the recurrence of the history at that moment, and the history stays newest first and bounded', () => {
    fc.assert(
      fc.property(
        churnConfigArb,
        fc.array(anyPollSpecArb, { minLength: 1, maxLength: 40 }),
        (config, polls) => {
          // Resolved incidents, newest first, kept from the events alone.
          let history: Incident[] = [];

          for (const { state, events } of runPolls(polls, config)) {
            // Events come in the order the tracker handled them, so a resolve
            // earlier in the same Poll is already in the history for a later open.
            for (const e of events) {
              if (e.type === 'opened') {
                expect(e.incident.recurrence).toEqual(
                  expectedRecurrence(e.incident.fingerprint, history),
                );
              } else if (e.type === 'resolved') {
                history = [e.incident, ...history].slice(0, config.incidentHistoryLimit);
              }
            }

            expect(state.history.length).toBeLessThanOrEqual(config.incidentHistoryLimit);
            expect(state.history.map((i) => i.id)).toEqual(history.map((i) => i.id));
            for (const i of state.history) {
              expect(i.status).toBe('resolved');
              expect(i.resolvedAt).not.toBeNull();
              expect(i.durationMs).toBe(Date.parse(i.resolvedAt!) - Date.parse(i.openedAt));
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 8: Recurrence and bounded history
  it('Property 8: for any history, a newly opened incident counts its fingerprint matches and links the newest one', () => {
    // Random Polls only reach a few history shapes, so build the history directly.
    const resolvedArb: fc.Arbitrary<Incident> = fc.record({
      id: fc.uuid(),
      status: fc.constant<'resolved'>('resolved'),
      rootService: fc.constantFrom(...CHAIN),
      kinds: fc.constant<SignalKind[]>([]),
      affected: fc.constant([]),
      fingerprint: fc.constantFrom(...CHAIN.flatMap((s) => [`${s}:down`, `${s}:errors`])),
      openedAt: fc.constant(new Date(0).toISOString()),
      resolvedAt: fc.integer({ min: 0, max: 1e9 }).map((t) => new Date(t).toISOString()),
      durationMs: fc.nat(),
      peak: fc.constant({ latencyP95Ms: null, errorRatio: null, rssMb: null, minScore: null }),
      recurrence: fc.constant(null),
      relatedChaos: fc.constant([]),
    });

    fc.assert(
      fc.property(
        fc.array(resolvedArb, { maxLength: 20 }),
        fc.constantFrom(...CHAIN),
        (history, service) => {
          const state: TrackerState = { ...initialTrackerState(CHAIN), history };
          const clear = Object.fromEntries(CHAIN.map((s) => [s, 'clear' as ServicePoll]));
          const { events } = trackIncidents(
            state,
            toInput({ metricsAvailable: true, services: { ...clear, [service]: ['down'] } }, 2e9),
            DEFAULT_CONFIG,
            () => 'new-incident',
          );

          expect(events).toHaveLength(1);
          const { recurrence } = events[0].incident;
          expect(recurrence).toEqual(expectedRecurrence(`${service}:down`, history));
          if (recurrence !== null) {
            const newest = history.find((i) => i.fingerprint === `${service}:down`)!;
            expect(recurrence.lastIncidentId).toBe(newest.id);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 8: Recurrence and bounded history
  it('Property 8: the history never exceeds incidentHistoryLimit and drops the oldest first', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 15 }),
        fc.constantFrom(...CHAIN),
        (limit, cycles, service) => {
          const config = { ...DEFAULT_CONFIG, openAfterPolls: 1, closeAfterPolls: 1, incidentHistoryLimit: limit };
          const clear = Object.fromEntries(CHAIN.map((s) => [s, 'clear' as ServicePoll]));
          // Open then resolve `cycles` times: one incident resolved per pair of Polls.
          const polls: PollSpec[] = Array.from({ length: cycles }, () => [
            { metricsAvailable: true, services: { ...clear, [service]: ['errors'] as SignalKind[] } },
            { metricsAvailable: true, services: clear },
          ]).flat();

          const ids: string[] = [];
          let state = initialTrackerState(CHAIN);
          for (const step of runPolls(polls, config)) {
            for (const e of step.events) if (e.type === 'resolved') ids.unshift(e.incident.id);
            state = step.state;
          }

          expect(ids).toHaveLength(cycles);
          expect(state.history.map((i) => i.id)).toEqual(ids.slice(0, limit));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

/** Badness values with plenty of exact ties, plus any value in [0, 1]. */
const badnessValueArb = fc.oneof(
  fc.constantFrom(0, 0.25, 0.5, 1),
  fc.double({ min: 0, max: 1, noNaN: true }),
);

/** A non-empty set of kinds, in any order. */
const kindsArb: fc.Arbitrary<SignalKind[]> = fc.shuffledSubarray<SignalKind>(
  ['down', 'errors', 'latency', 'memory'],
  { minLength: 1 },
);

const rootArb = fc.stringMatching(/^[a-z][a-z-]{0,9}$/);

/** Health carrying only what `fingerprint` reads: the badness of each kind. */
function healthWithBadness(
  service: ServiceName,
  badness: ServiceHealth['badness'],
  kinds: SignalKind[],
): ServiceHealth {
  return { ...healthFor(service, 'clear'), badness, breachedKinds: kinds };
}

const fingerprintInputArb = fc.tuple(
  rootArb,
  kindsArb,
  fc.record({ errors: badnessValueArb, latency: badnessValueArb, memory: badnessValueArb }),
);

/** The primary kind per Requirement 5.7, written independently of the implementation. */
function expectedPrimaryKind(kinds: SignalKind[], badness: ServiceHealth['badness']): SignalKind {
  if (kinds.includes('down')) return 'down';
  const tieOrder = ['errors', 'latency', 'memory'] as const;
  const candidates = tieOrder.filter((k) => kinds.includes(k));
  const best = Math.max(...candidates.map((k) => badness[k]));
  return candidates.find((k) => badness[k] === best)!;
}

describe('fingerprint — property-based tests (Property 10)', () => {
  // Feature: haunting-engine, Property 10: Fingerprint follows the primary-kind rule
  it('Property 10: fingerprint is "<root>:<primaryKind>" by the primary-kind rule', () => {
    fc.assert(
      fc.property(fingerprintInputArb, ([root, kinds, badness]) => {
        expect(fingerprint(root, kinds, healthWithBadness(root, badness, kinds))).toBe(
          `${root}:${expectedPrimaryKind(kinds, badness)}`,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 10: Fingerprint follows the primary-kind rule
  it('Property 10: down wins whatever the other kinds and their badness', () => {
    fc.assert(
      fc.property(fingerprintInputArb, ([root, kinds, badness]) => {
        const withDown: SignalKind[] = kinds.includes('down') ? kinds : [...kinds, 'down'];
        expect(fingerprint(root, withDown, healthWithBadness(root, badness, withDown))).toBe(
          `${root}:down`,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 10: Fingerprint follows the primary-kind rule
  it('Property 10: equal badness is broken errors > latency > memory', () => {
    fc.assert(
      fc.property(
        rootArb,
        fc.shuffledSubarray<SignalKind>(['errors', 'latency', 'memory'], { minLength: 1 }),
        badnessValueArb,
        (root, kinds, b) => {
          const badness = { errors: b, latency: b, memory: b };
          const first = (['errors', 'latency', 'memory'] as const).find((k) => kinds.includes(k));
          expect(fingerprint(root, kinds, healthWithBadness(root, badness, kinds))).toBe(
            `${root}:${first}`,
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 10: Fingerprint follows the primary-kind rule
  it('Property 10: only the badness of the given kinds matters', () => {
    fc.assert(
      fc.property(
        fingerprintInputArb,
        fc.record({ errors: badnessValueArb, latency: badnessValueArb, memory: badnessValueArb }),
        ([root, kinds, badness], other) => {
          // Replace the badness of every kind not in `kinds`.
          const changed = { ...badness };
          for (const k of ['errors', 'latency', 'memory'] as const) {
            if (!kinds.includes(k)) changed[k] = other[k];
          }
          expect(fingerprint(root, kinds, healthWithBadness(root, changed, kinds))).toBe(
            fingerprint(root, kinds, healthWithBadness(root, badness, kinds)),
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 10: Fingerprint follows the primary-kind rule
  it('Property 10: identical inputs give identical fingerprints, whatever the order of the kinds', () => {
    fc.assert(
      fc.property(fingerprintInputArb, fc.nat(), ([root, kinds, badness], seed) => {
        const health = healthWithBadness(root, badness, kinds);
        const rotated = [...kinds.slice(seed % kinds.length), ...kinds.slice(0, seed % kinds.length)];
        const print = fingerprint(root, kinds, health);
        expect(fingerprint(root, [...kinds], structuredClone(health))).toBe(print);
        expect(fingerprint(root, rotated, health)).toBe(print);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
