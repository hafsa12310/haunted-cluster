import * as fc from 'fast-check';
import type { Incident, ServiceName, SignalKind } from '@haunted-cluster/shared';
import { extractFeatures, featureVectorLength, FeatureConfig } from './feature-extractor';

const NUM_RUNS = 100;
const KINDS: SignalKind[] = ['latency', 'errors', 'memory', 'down'];
const POOL = ['gateway', 'orders', 'payments', 'billing', 'search', 'auth'];

const chainArb: fc.Arbitrary<ServiceName[]> = fc
  .integer({ min: 1, max: POOL.length })
  .map((n) => POOL.slice(0, n));

const configArb: fc.Arbitrary<FeatureConfig> = fc.record({
  latencyCriticalMs: fc.double({ min: 1, max: 60_000, noNaN: true }),
  errorRatioCritical: fc.double({ min: 0.001, max: 1, noNaN: true }),
  memoryLimitMb: fc.double({ min: 1, max: 8192, noNaN: true }),
  durationCapSeconds: fc.double({ min: 1, max: 86_400, noNaN: true }),
});

// Peaks may be null, negative, huge or non-finite to exercise clamping.
const peakArb = fc.oneof(
  fc.constant(null),
  fc.double({ min: -1e6, max: 1e9, noNaN: true }),
  fc.constantFrom(Infinity, -Infinity, NaN),
);

const subsetArb = <T>(items: readonly T[]): fc.Arbitrary<T[]> =>
  fc.subarray([...items]);

const MIN_MS = Date.parse('2020-01-01T00:00:00.000Z');
const MAX_MS = Date.parse('2030-01-01T00:00:00.000Z');
const msArb = fc.integer({ min: MIN_MS, max: MAX_MS });

interface Case {
  incident: Incident;
  chain: ServiceName[];
  config: FeatureConfig;
  nowMs: number;
}

const caseArb: fc.Arbitrary<Case> = fc
  .record({
    chain: chainArb,
    config: configArb,
    // Root may be outside the chain (unknown root).
    rootService: fc.constantFrom(...POOL, 'mystery'),
    kinds: subsetArb(KINDS),
    affectedServices: subsetArb(POOL),
    id: fc.uuid(),
    status: fc.constantFrom<'open' | 'resolved'>('open', 'resolved'),
    openedMs: msArb,
    nowOffsetMs: fc.integer({ min: -1_000_000, max: 10_000_000_000 }),
    durationMs: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 10_000_000_000 })),
    latencyP95Ms: peakArb,
    errorRatio: peakArb,
    rssMb: peakArb,
  })
  .map((r) => {
    const incident: Incident = {
      id: r.id,
      status: r.status,
      rootService: r.rootService,
      kinds: r.kinds,
      affected: r.affectedServices.map((service) => ({ service, kinds: [] })),
      fingerprint: `${r.rootService}:latency`,
      openedAt: new Date(r.openedMs).toISOString(),
      resolvedAt:
        r.status === 'resolved' ? new Date(r.openedMs + (r.durationMs ?? 0)).toISOString() : null,
      durationMs: r.status === 'resolved' ? r.durationMs : null,
      peak: {
        latencyP95Ms: r.latencyP95Ms,
        errorRatio: r.errorRatio,
        rssMb: r.rssMb,
        minScore: null,
      },
      recurrence: null,
      relatedChaos: [],
      similar: null,
    };
    return { incident, chain: r.chain, config: r.config, nowMs: r.openedMs + r.nowOffsetMs };
  });

describe('feature-extractor properties', () => {
  // Feature: engine-intelligence, Property 27: Feature vectors have the specified shape and range
  it('Property 27: shape and range', () => {
    // Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
    fc.assert(
      fc.property(caseArb, ({ incident, chain, config, nowMs }) => {
        const n = chain.length;
        const v = extractFeatures(incident, nowMs, chain, config);

        expect(v).toHaveLength(featureVectorLength(n));
        expect(v).toHaveLength(2 * n + 8);

        const rootPart = v.slice(0, n);
        const known = chain.includes(incident.rootService);
        rootPart.forEach((x, i) => {
          expect(x).toBe(known && chain[i] === incident.rootService ? 1 : 0);
        });
        if (!known) expect(rootPart.every((x) => x === 0)).toBe(true);

        const affectedNames = new Set(incident.affected.map((a) => a.service));
        v.slice(n, 2 * n).forEach((x, i) => {
          expect(x).toBe(affectedNames.has(chain[i]) ? 1 : 0);
        });

        v.slice(2 * n, 2 * n + 4).forEach((x, i) => {
          expect(x).toBe(incident.kinds.includes(KINDS[i]) ? 1 : 0);
        });

        const peaks = v.slice(2 * n + 4, 2 * n + 7);
        peaks.forEach((x) => {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(1);
        });
        const peakValues = [
          incident.peak.latencyP95Ms,
          incident.peak.errorRatio,
          incident.peak.rssMb,
        ];
        peakValues.forEach((p, i) => {
          if (p === null) expect(peaks[i]).toBe(0);
        });

        const duration = v[2 * n + 7];
        expect(duration).toBeGreaterThanOrEqual(0);
        expect(duration).toBeLessThanOrEqual(1);

        v.forEach((x) => expect(Number.isFinite(x)).toBe(true));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 28: Feature vectors depend on content, not identity
  it('Property 28: identifiers do not change the vector and input is not mutated', () => {
    // Validates: Requirements 7.7, 7.8
    fc.assert(
      fc.property(
        caseArb,
        fc.uuid(),
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        ({ incident, chain, config, nowMs }, otherId, shiftMs) => {
          const before = structuredClone(incident);
          const v1 = extractFeatures(incident, nowMs, chain, config);
          expect(incident).toEqual(before);

          // Open incidents derive duration from openedAt, so only id and resolvedAt change there.
          const shifted = (iso: string): string => new Date(Date.parse(iso) + shiftMs).toISOString();
          const other: Incident = {
            ...incident,
            id: otherId,
            openedAt: incident.status === 'resolved' ? shifted(incident.openedAt) : incident.openedAt,
            resolvedAt: incident.resolvedAt === null ? null : shifted(incident.resolvedAt),
          };
          const v2 = extractFeatures(other, nowMs, chain, config);
          expect(v2).toEqual(v1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 28: Feature vectors depend on content, not identity
  it('Property 28: an open incident at its opening time has duration entry 0', () => {
    fc.assert(
      fc.property(caseArb, ({ incident, chain, config }) => {
        const open: Incident = { ...incident, status: 'open', resolvedAt: null, durationMs: null };
        const v = extractFeatures(open, Date.parse(open.openedAt), chain, config);
        expect(v[v.length - 1]).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
