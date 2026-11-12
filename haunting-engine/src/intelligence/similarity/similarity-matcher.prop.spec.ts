import * as fc from 'fast-check';
import type { Incident } from '@haunted-cluster/shared';
import { cosineSimilarity, selectSimilar, Candidate } from './similarity-matcher';
import type { FeatureVector } from './feature-extractor';

const NUM_RUNS = 100;

// Entries are either exactly 0 or comfortably away from underflow/overflow
// when squared, so norm arithmetic stays exact enough for the 1e-9 checks.
const entryArb = fc.oneof(fc.constant(0), fc.double({ min: 1e-3, max: 1e3, noNaN: true }));
const vectorArb = (len: number): fc.Arbitrary<FeatureVector> =>
  fc.array(entryArb, { minLength: len, maxLength: len });

const pairArb = fc
  .integer({ min: 1, max: 20 })
  .chain((len) => fc.tuple(vectorArb(len), vectorArb(len)));

const nonZeroVectorArb = fc
  .integer({ min: 1, max: 20 })
  .chain((len) => vectorArb(len))
  .filter((v) => v.some((x) => x > 0));

describe('similarity-matcher properties', () => {
  // Feature: engine-intelligence, Property 29: Cosine similarity laws
  it('Property 29: result is finite, in [0, 1] and symmetric', () => {
    // Validates: Requirements 8.1, 8.2
    fc.assert(
      fc.property(pairArb, ([a, b]) => {
        const ab = cosineSimilarity(a, b);
        expect(Number.isFinite(ab)).toBe(true);
        expect(ab).toBeGreaterThanOrEqual(0);
        expect(ab).toBeLessThanOrEqual(1);
        expect(cosineSimilarity(b, a)).toBeCloseTo(ab, 12);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 29: Cosine similarity laws
  it('Property 29: identical non-zero vectors give 1 within 1e-9', () => {
    // Validates: Requirements 8.3
    fc.assert(
      fc.property(nonZeroVectorArb, (a) => {
        expect(Math.abs(cosineSimilarity(a, [...a]) - 1)).toBeLessThan(1e-9);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 29: Cosine similarity laws
  it('Property 29: a zero-norm vector gives 0', () => {
    // Validates: Requirements 8.4
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }).chain((len) =>
          fc.tuple(vectorArb(len), fc.boolean()),
        ),
        ([v, zeroFirst]) => {
          const zero = v.map(() => 0);
          expect(cosineSimilarity(zeroFirst ? zero : v, zeroFirst ? v : zero)).toBe(0);
          expect(cosineSimilarity(zero, zero)).toBe(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 29: Cosine similarity laws
  it('Property 29: different lengths give 0 and never throw', () => {
    // Validates: Requirements 8.5
    fc.assert(
      fc.property(
        fc.array(entryArb, { maxLength: 20 }),
        fc.array(entryArb, { maxLength: 20 }),
        (a, b) => {
          fc.pre(a.length !== b.length);
          expect(() => cosineSimilarity(a, b)).not.toThrow();
          expect(cosineSimilarity(a, b)).toBe(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 29: Cosine similarity laws
  it('Property 29: positive scaling of one vector does not change the result', () => {
    // Validates: Requirements 8.1, 8.3
    fc.assert(
      fc.property(pairArb, fc.double({ min: 0.1, max: 100, noNaN: true }), ([a, b], k) => {
        const scaled = a.map((x) => x * k);
        expect(Math.abs(cosineSimilarity(scaled, b) - cosineSimilarity(a, b))).toBeLessThan(1e-9);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

const BASE_MS = Date.parse('2024-01-01T00:00:00.000Z');

function makeIncident(id: string, resolvedOffset: number | null): Incident {
  return {
    id,
    status: resolvedOffset === null ? 'open' : 'resolved',
    rootService: 'orders',
    kinds: ['latency'],
    affected: [],
    fingerprint: 'orders:latency',
    openedAt: new Date(BASE_MS).toISOString(),
    resolvedAt: resolvedOffset === null ? null : new Date(BASE_MS + resolvedOffset * 1000).toISOString(),
    durationMs: resolvedOffset === null ? null : resolvedOffset * 1000,
    peak: { latencyP95Ms: null, errorRatio: null, rssMb: null, minScore: null },
    recurrence: null,
    relatedChaos: [],
    similar: null,
  };
}

// Small integer entries make exact similarity ties (including duplicate
// vectors) common; the few distinct resolvedAt values make time ties common.
const smallVectorArb = (len: number): fc.Arbitrary<FeatureVector> =>
  fc.array(fc.integer({ min: 0, max: 2 }), { minLength: len, maxLength: len });

const matchCaseArb = fc.integer({ min: 1, max: 4 }).chain((len) =>
  fc.record({
    target: smallVectorArb(len),
    candidates: fc
      .array(
        fc.record({ vector: smallVectorArb(len), offset: fc.integer({ min: 0, max: 3 }) }),
        { maxLength: 8 },
      )
      .map((list): Candidate[] =>
        list.map((c, i) => ({ incident: makeIncident(`inc-${i}`, c.offset), vector: c.vector })),
      ),
    threshold: fc.double({ min: -0.5, max: 1.5, noNaN: true }),
    useExactBest: fc.boolean(),
  }),
);

describe('selectSimilar properties', () => {
  // Feature: engine-intelligence, Property 30: The best candidate wins, ties go to the latest, and the threshold decides
  it('Property 30: best candidate wins, ties go to latest resolvedAt, threshold decides', () => {
    // Validates: Requirements 8.7, 8.8, 8.10
    fc.assert(
      fc.property(matchCaseArb, ({ target, candidates, threshold, useExactBest }) => {
        const sims = candidates.map((c) => cosineSimilarity(target, c.vector));
        const best = sims.length === 0 ? null : Math.max(...sims);
        // Optionally put the threshold exactly on the best value: >= must pass.
        const t = useExactBest && best !== null ? best : threshold;

        const result = selectSimilar(target, candidates, t);

        if (best === null || best < t) {
          expect(result).toBeNull();
          return;
        }
        expect(result).not.toBeNull();
        if (result === null) return;

        // Unrounded maximum, and never below the threshold.
        expect(result.similarity).toBe(best);
        expect(result.similarity).toBeGreaterThanOrEqual(t);

        // Among exact ties, the winner has the latest resolvedAt.
        const tiedIdx = sims.flatMap((s, i) => (s === best ? [i] : []));
        const latest = Math.max(
          ...tiedIdx.map((i) => Date.parse(candidates[i].incident.resolvedAt as string)),
        );
        const winner = candidates.find((c) => c.incident.id === result.incident.id);
        expect(winner).toBeDefined();
        expect(tiedIdx.map((i) => candidates[i].incident.id)).toContain(result.incident.id);
        expect(Date.parse(winner?.incident.resolvedAt as string)).toBe(latest);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: engine-intelligence, Property 30: The best candidate wins, ties go to the latest, and the threshold decides
  it('Property 30: empty candidate list gives null', () => {
    // Validates: Requirements 8.8
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 6 }),
        fc.double({ min: -1, max: 2, noNaN: true }),
        (target, threshold) => {
          expect(selectSimilar(target, [], threshold)).toBeNull();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
