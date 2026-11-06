import * as fc from 'fast-check';
import type {
  ServiceHealth,
  ServiceName,
  ServiceSignals,
  ServiceStatus,
  SignalKind,
} from '@haunted-cluster/shared';
import { attributeFaults, Attribution } from './attribution';

const NUM_RUNS = 200;

const PROPAGATING: readonly SignalKind[] = ['down', 'errors', 'latency'];
const isPropagating = (k: SignalKind): boolean => PROPAGATING.includes(k);

/** A chain of 1–6 unique service names, upstream first. */
const chainArb: fc.Arbitrary<ServiceName[]> = fc.uniqueArray(
  fc.stringMatching(/^[a-z][a-z-]{0,9}$/),
  { minLength: 1, maxLength: 6 },
);

const NO_SIGNALS: ServiceSignals = {
  requestRate: null,
  errorRatio: null,
  latencyP95Ms: null,
  rssMb: null,
  up: null,
};

/** A non-empty subset of the badness kinds, in the order `scoreService` reports them. */
const breachedSubsetArb: fc.Arbitrary<SignalKind[]> = fc
  .subarray<SignalKind>(['errors', 'latency', 'memory'], { minLength: 1 })
  .map((kinds) => [...kinds]);

/** A status and a set of breached kinds consistent with it, as `scoreService` would produce. */
const statusAndKindsArb: fc.Arbitrary<[ServiceStatus, SignalKind[]]> = fc.oneof(
  fc.constant<[ServiceStatus, SignalKind[]]>(['healthy', []]),
  fc.constant<[ServiceStatus, SignalKind[]]>(['unknown', []]),
  fc.constant<[ServiceStatus, SignalKind[]]>(['down', ['down']]),
  fc.tuple(fc.constantFrom<ServiceStatus>('degraded', 'critical'), breachedSubsetArb),
);

function healthFor(service: ServiceName, status: ServiceStatus, kinds: SignalKind[]): ServiceHealth {
  return {
    service,
    status,
    score: status === 'unknown' ? null : status === 'down' ? 0 : kinds.length === 0 ? 100 : 50,
    signals: { ...NO_SIGNALS, up: status === 'unknown' ? null : status !== 'down' },
    badness: { latency: 0, errors: 0, memory: 0 },
    breachedKinds: kinds,
  };
}

/** A chain together with a health entry for every service in it. */
const chainAndHealthArb: fc.Arbitrary<[ServiceName[], Record<ServiceName, ServiceHealth>]> =
  chainArb.chain((chain) =>
    fc
      .tuple(...chain.map(() => statusAndKindsArb))
      .map((entries): [ServiceName[], Record<ServiceName, ServiceHealth>] => [
        chain,
        Object.fromEntries(
          chain.map((service, i) => [service, healthFor(service, ...entries[i])]),
        ),
      ]),
  );

/** The propagating root per Requirement 4.1, written independently of the implementation. */
function expectedRoot(
  chain: ServiceName[],
  health: Record<ServiceName, ServiceHealth>,
): ServiceName | undefined {
  return [...chain]
    .reverse()
    .find(
      (s) => health[s].status !== 'unknown' && health[s].breachedKinds.some(isPropagating),
    );
}

const propagatingAttributions = (attributions: Attribution[]): Attribution[] =>
  attributions.filter((a) => a.kinds.some(isPropagating));

describe('attributeFaults — property-based tests (Property 4)', () => {
  // Feature: haunting-engine, Property 4: Attribution is complete and well-formed
  it('Property 4: at most one attribution has a propagating kind, rooted at the most downstream propagating breach', () => {
    fc.assert(
      fc.property(chainAndHealthArb, ([chain, health]) => {
        const propagating = propagatingAttributions(attributeFaults(chain, health));
        const root = expectedRoot(chain, health);

        expect(propagating.length).toBeLessThanOrEqual(1);
        if (root === undefined) {
          expect(propagating).toEqual([]);
        } else {
          expect(propagating).toHaveLength(1);
          expect(propagating[0].rootService).toBe(root);
          expect(propagating[0].kinds).toEqual(health[root].breachedKinds);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 4: Attribution is complete and well-formed
  it('Property 4: affected services are upstream of the root, in chain order, with their own propagating kinds', () => {
    fc.assert(
      fc.property(chainAndHealthArb, ([chain, health]) => {
        const attributions = attributeFaults(chain, health);
        const root = expectedRoot(chain, health);
        const rootIndex = root === undefined ? -1 : chain.indexOf(root);

        const expectedAffected = chain
          .slice(0, Math.max(rootIndex, 0))
          .filter((s) => health[s].status !== 'unknown')
          .map((s) => ({ service: s, kinds: health[s].breachedKinds.filter(isPropagating) }))
          .filter((a) => a.kinds.length > 0);

        for (const a of attributions) {
          expect(a.affected).toEqual(a.rootService === root ? expectedAffected : []);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 4: Attribution is complete and well-formed
  it("Property 4: every memory breach appears in its own service's attribution", () => {
    fc.assert(
      fc.property(chainAndHealthArb, ([chain, health]) => {
        const attributions = attributeFaults(chain, health);
        for (const s of chain) {
          if (health[s].status === 'unknown' || !health[s].breachedKinds.includes('memory')) continue;
          const own = attributions.filter((a) => a.rootService === s);
          expect(own).toHaveLength(1);
          expect(own[0].kinds).toContain('memory');
        }
        // And memory is never attributed to a service that did not breach it.
        for (const a of attributions) {
          if (a.kinds.includes('memory')) {
            expect(health[a.rootService].breachedKinds).toContain('memory');
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 4: Attribution is complete and well-formed
  it('Property 4: every breached service appears exactly once as the propagating root or one of its affected, unless it is only a memory root', () => {
    fc.assert(
      fc.property(chainAndHealthArb, ([chain, health]) => {
        const attributions = attributeFaults(chain, health);
        const [propagating] = propagatingAttributions(attributions);
        const covered = propagating
          ? [propagating.rootService, ...propagating.affected.map((a) => a.service)]
          : [];
        const roots = attributions.map((a) => a.rootService);

        for (const s of chain) {
          const h = health[s];
          if (h.status === 'unknown' || h.breachedKinds.length === 0) continue;
          const appearances = covered.filter((c) => c === s).length;
          if (h.breachedKinds.some(isPropagating)) {
            expect(appearances).toBe(1);
          } else {
            // Only a memory breach: its own root, outside the propagating attribution's affected.
            expect(roots).toContain(s);
            expect(propagating?.affected.map((a) => a.service) ?? []).not.toContain(s);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 4: Attribution is complete and well-formed
  it('Property 4: no unknown service appears anywhere', () => {
    fc.assert(
      fc.property(chainAndHealthArb, ([chain, health]) => {
        const mentioned = attributeFaults(chain, health).flatMap((a) => [
          a.rootService,
          ...a.affected.map((x) => x.service),
        ]);
        for (const s of mentioned) expect(health[s].status).not.toBe('unknown');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 4: Attribution is complete and well-formed
  it('Property 4: unknown services are ignored even if they carry breached kinds', () => {
    // scoreService never produces this, but attribution must not rely on that.
    fc.assert(
      fc.property(
        chainAndHealthArb,
        fc.nat(),
        fc.subarray<SignalKind>(['down', 'errors', 'latency', 'memory'], { minLength: 1 }),
        ([chain, health], pick, kinds) => {
          const target = chain[pick % chain.length];
          const blinded = { ...health, [target]: healthFor(target, 'unknown', [...kinds]) };
          const healthy = { ...health, [target]: healthFor(target, 'healthy', []) };
          expect(attributeFaults(chain, blinded)).toEqual(attributeFaults(chain, healthy));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 4: Attribution is complete and well-formed
  it('Property 4: attributions are well-formed and in chain order', () => {
    fc.assert(
      fc.property(chainAndHealthArb, ([chain, health]) => {
        const attributions = attributeFaults(chain, health);
        const rootIndices = attributions.map((a) => chain.indexOf(a.rootService));

        // Roots are chain members, unique, and in chain order.
        expect(rootIndices.every((i) => i >= 0)).toBe(true);
        expect(rootIndices).toEqual([...new Set(rootIndices)].sort((a, b) => a - b));

        for (const a of attributions) {
          expect(a.kinds.length).toBeGreaterThan(0);
          expect(new Set(a.kinds).size).toBe(a.kinds.length);
          // Kinds are the root's own, in the order it reported them.
          expect(a.kinds).toEqual(
            health[a.rootService].breachedKinds.filter((k) => a.kinds.includes(k)),
          );
          for (const x of a.affected) expect(x.kinds.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
