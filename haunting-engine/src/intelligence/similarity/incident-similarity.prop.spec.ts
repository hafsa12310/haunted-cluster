import * as fc from 'fast-check';
import type {
  Incident,
  ServiceHealth,
  ServiceName,
  SignalKind,
} from '@haunted-cluster/shared';
import { EngineConfig, loadEngineConfig } from '../../config/engine-config';
import type { Attribution } from '../../incidents/attribution';
import {
  IncidentEvent,
  initialTrackerState,
  PollInput,
  trackIncidents,
  TrackerState,
} from '../../incidents/incident-tracker';
import { applySimilarity, matchOnOpen, matchOnResolve } from './incident-similarity';

const NUM_RUNS = 100;
const KINDS: SignalKind[] = ['latency', 'errors', 'memory', 'down'];

const BASE_CONFIG = loadEngineConfig({
  PROMETHEUS_URL: 'http://prometheus:9090',
  GATEWAY_URL: 'http://gateway:3000',
  ORDERS_URL: 'http://orders:3001',
  PAYMENTS_URL: 'http://payments:3002',
});
const CHAIN = BASE_CONFIG.serviceChain;

/** Threshold in thousandths, so rounding to 3 decimals cannot drop below it. */
const configArb: fc.Arbitrary<EngineConfig> = fc
  .record({
    threshold: fc.integer({ min: 0, max: 1000 }).map((k) => k / 1000),
    durationCapSeconds: fc.integer({ min: 1, max: 3600 }),
  })
  .map(({ threshold, durationCapSeconds }) => ({
    ...BASE_CONFIG,
    similarity: { ...BASE_CONFIG.similarity, threshold, durationCapSeconds },
  }));

const T0 = Date.parse('2025-01-01T00:00:00.000Z');

const peakArb = fc.oneof(fc.constant(null), fc.double({ min: 0, max: 5000, noNaN: true }));

interface IncidentSeed {
  root: ServiceName;
  kinds: SignalKind[];
  affected: ServiceName[];
  latencyP95Ms: number | null;
  errorRatio: number | null;
  rssMb: number | null;
  durationMs: number;
  openedOffsetMs: number;
}

const seedArb: fc.Arbitrary<IncidentSeed> = fc.record({
  root: fc.constantFrom(...CHAIN),
  kinds: fc.subarray(KINDS, { minLength: 1 }),
  affected: fc.subarray([...CHAIN]),
  latencyP95Ms: peakArb,
  errorRatio: peakArb,
  rssMb: peakArb,
  durationMs: fc.integer({ min: 0, max: 2_000_000 }),
  openedOffsetMs: fc.integer({ min: 0, max: 1_000_000_000 }),
});

function buildIncident(seed: IncidentSeed, id: string, resolved: boolean): Incident {
  const openedMs = T0 + seed.openedOffsetMs;
  return {
    id,
    status: resolved ? 'resolved' : 'open',
    rootService: seed.root,
    kinds: seed.kinds,
    affected: seed.affected.map((service) => ({ service, kinds: [] })),
    fingerprint: `${seed.root}:${seed.kinds[0]}`,
    openedAt: new Date(openedMs).toISOString(),
    resolvedAt: resolved ? new Date(openedMs + seed.durationMs).toISOString() : null,
    durationMs: resolved ? seed.durationMs : null,
    peak: {
      latencyP95Ms: seed.latencyP95Ms,
      errorRatio: seed.errorRatio,
      rssMb: seed.rssMb,
      minScore: null,
    },
    recurrence: null,
    relatedChaos: [],
    similar: null,
  };
}

/** Resolved history entries with unique ids and unique resolvedAt-independent content. */
const historyArb: fc.Arbitrary<Incident[]> = fc
  .array(seedArb, { minLength: 0, maxLength: 8 })
  .map((seeds) => seeds.map((s, i) => buildIncident(s, `h-${i}`, true)));

describe('incident-similarity properties', () => {
  // Feature: engine-intelligence, Property 31: Matching at open time ignores durations
  it('Property 31: matchOnOpen is unchanged when durations change', () => {
    // Validates: Requirements R8.6, R7.4
    fc.assert(
      fc.property(
        configArb,
        seedArb,
        historyArb,
        fc.array(fc.integer({ min: 0, max: 5_000_000 }), { minLength: 8, maxLength: 8 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        (config, targetSeed, history, newDurations, nowOffsetA, nowOffsetB) => {
          const target = buildIncident(targetSeed, 'target', false);
          const openedMs = Date.parse(target.openedAt);

          // Same history, other durations. resolvedAt stays, since it breaks ties.
          const changed = history.map((h, i) => ({ ...h, durationMs: newDurations[i] }));

          const a = matchOnOpen(target, history, openedMs + nowOffsetA, CHAIN, config);
          const b = matchOnOpen(target, changed, openedMs + nowOffsetB, CHAIN, config);

          if (a === null || b === null) {
            expect(b).toBe(a);
            return;
          }
          // The reported duration is the matched incident's own; everything else must be equal.
          const { durationSeconds: _da, ...restA } = a;
          const { durationSeconds: _db, ...restB } = b;
          expect(restB).toEqual(restA);
          const matched = changed.find((h) => h.id === b.id);
          expect(b.durationSeconds).toBe(Math.round((matched?.durationMs ?? 0) / 1000));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 32: Matching at resolve time excludes the incident itself and reports a well-formed record
  it('Property 32: matchOnResolve excludes itself and is well formed', () => {
    // Validates: Requirements R8.11, R8.12, R8.13
    fc.assert(
      fc.property(
        configArb,
        seedArb,
        historyArb,
        fc.nat({ max: 8 }),
        (config, targetSeed, others, insertAt) => {
          const target = buildIncident(targetSeed, 'target', true);
          const pos = Math.min(insertAt, others.length);
          const withSelf = [...others.slice(0, pos), target, ...others.slice(pos)];

          const result = matchOnResolve(target, withSelf, CHAIN, config);

          // Same as if the incident were not in the history at all.
          expect(result).toEqual(matchOnResolve(target, others, CHAIN, config));

          if (result === null) return;
          expect(result.id).not.toBe(target.id);
          const matched = others.find((h) => h.id === result.id);
          expect(matched).toBeDefined();
          expect(result.fingerprint).toBe(matched?.fingerprint);
          expect(result.resolvedAt).toBe(matched?.resolvedAt);
          expect(Number.isInteger(result.durationSeconds)).toBe(true);
          expect(result.durationSeconds).toBe(Math.round((matched?.durationMs ?? 0) / 1000));
          expect(Math.round(result.similarity * 1000) / 1000).toBe(result.similarity);
          expect(result.similarity).toBeGreaterThanOrEqual(config.similarity.threshold - 1e-9);
          expect(result.similarity).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---- Property 18 ----

interface ServicePollSpec {
  state: 'clear' | 'unknown' | 'faulty';
  kinds: SignalKind[];
  affected: ServiceName[];
  latencyP95Ms: number;
  rssMb: number;
}

interface PollSpec {
  metricsAvailable: boolean;
  services: Record<ServiceName, ServicePollSpec>;
}

const servicePollArb: fc.Arbitrary<ServicePollSpec> = fc.record({
  state: fc.constantFrom<ServicePollSpec['state']>('clear', 'clear', 'unknown', 'faulty', 'faulty', 'faulty'),
  kinds: fc.subarray(KINDS, { minLength: 1 }),
  affected: fc.subarray([...CHAIN]),
  latencyP95Ms: fc.double({ min: 10, max: 3000, noNaN: true }),
  rssMb: fc.double({ min: 50, max: 250, noNaN: true }),
});

const pollSpecArb: fc.Arbitrary<PollSpec> = fc.record({
  metricsAvailable: fc.oneof(
    { weight: 5, arbitrary: fc.constant(true) },
    { weight: 1, arbitrary: fc.constant(false) },
  ),
  services: fc.record(Object.fromEntries(CHAIN.map((s) => [s, servicePollArb]))),
});

function healthFor(service: ServiceName, p: ServicePollSpec): ServiceHealth {
  if (p.state === 'faulty' && p.kinds.includes('down')) {
    return {
      service,
      status: 'down',
      score: 0,
      signals: { requestRate: null, errorRatio: null, latencyP95Ms: null, rssMb: null, up: false },
      badness: { latency: 0, errors: 0, memory: 0 },
      breachedKinds: ['down'],
    };
  }
  const unknown = p.state === 'unknown';
  const kinds = p.state === 'faulty' ? p.kinds : [];
  return {
    service,
    status: unknown ? 'unknown' : kinds.length > 0 ? 'degraded' : 'healthy',
    score: unknown ? null : kinds.length > 0 ? 50 : 100,
    signals: {
      requestRate: unknown ? null : 10,
      errorRatio: unknown ? null : kinds.includes('errors') ? 0.1 : 0,
      latencyP95Ms: unknown ? null : p.latencyP95Ms,
      rssMb: unknown ? null : p.rssMb,
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

function toInput(spec: PollSpec, now: number): PollInput {
  const health = Object.fromEntries(CHAIN.map((s) => [s, healthFor(s, spec.services[s])]));
  const attributions: Attribution[] = CHAIN.flatMap((s): Attribution[] => {
    const p = spec.services[s];
    if (p.state !== 'faulty') return [];
    const kinds = p.kinds.includes('down') ? (['down'] as SignalKind[]) : p.kinds;
    return [
      {
        rootService: s,
        kinds,
        affected: p.affected.filter((a) => a !== s).map((service) => ({ service, kinds: ['errors'] })),
      },
    ];
  });
  return { now, metricsAvailable: spec.metricsAvailable, health, attributions, chaosEvents: [] };
}

/** Replaces `similar` with null on every incident, so the rest can be compared. */
function withoutSimilar(i: Incident): Incident {
  return { ...i, similar: null };
}

function stripState(s: TrackerState): TrackerState {
  return {
    ...s,
    open: Object.fromEntries(Object.entries(s.open).map(([k, v]) => [k, withoutSimilar(v)])),
    history: s.history.map(withoutSimilar),
  };
}

function stripEvents(events: readonly IncidentEvent[]): IncidentEvent[] {
  return events.map((e) => ({ type: e.type, incident: withoutSimilar(e.incident) }));
}

describe('similarity does not change existing decisions', () => {
  // Feature: engine-intelligence, Property 18: Existing decisions do not depend on the intelligence layer
  it('Property 18: trackIncidents with and without applySimilarity agree except for similar', () => {
    // Validates: Requirements R4.19, R9.7
    fc.assert(
      fc.property(
        fc.array(pollSpecArb, { minLength: 1, maxLength: 40 }),
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 0, max: 1000 }).map((k) => k / 1000),
        (polls, openAfterPolls, closeAfterPolls, threshold) => {
          const config: EngineConfig = {
            ...BASE_CONFIG,
            openAfterPolls,
            closeAfterPolls,
            similarity: { ...BASE_CONFIG.similarity, threshold },
          };
          let plainCounter = 0;
          let withCounter = 0;
          let plain = initialTrackerState(CHAIN);
          let withSim = initialTrackerState(CHAIN);

          polls.forEach((spec, i) => {
            const now = T0 + i * config.pollIntervalMs;
            const input = toInput(spec, now);

            const a = trackIncidents(plain, input, config, () => `incident-${++plainCounter}`);
            plain = a.state;

            const b = trackIncidents(withSim, input, config, () => `incident-${++withCounter}`);
            const applied = applySimilarity(b.state, b.events, now, CHAIN, config);
            withSim = applied.tracker;

            expect(applied.failures).toEqual([]);
            expect(stripEvents(applied.events)).toEqual(stripEvents(a.events));
            expect(applied.events.map((e) => e.type)).toEqual(a.events.map((e) => e.type));
            expect(stripState(withSim)).toEqual(stripState(plain));
          });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
