import type { Incident, ServiceName, SignalKind } from '@haunted-cluster/shared';
import { EngineConfig, loadEngineConfig } from '../../config/engine-config';
import { IncidentEvent, initialTrackerState, TrackerState } from '../../incidents/incident-tracker';
import { applySimilarity, matchOnOpen, matchOnResolve } from './incident-similarity';

const BASE_CONFIG = loadEngineConfig({
  PROMETHEUS_URL: 'http://prometheus:9090',
  GATEWAY_URL: 'http://gateway:3000',
  ORDERS_URL: 'http://orders:3001',
  PAYMENTS_URL: 'http://payments:3002',
});
const CHAIN = BASE_CONFIG.serviceChain;
const CONFIG: EngineConfig = {
  ...BASE_CONFIG,
  similarity: { ...BASE_CONFIG.similarity, threshold: 0.5 },
};
const T0 = Date.parse('2025-01-01T00:00:00.000Z');
const NOW = T0 + 3_600_000;

interface Opts {
  root?: ServiceName;
  kinds?: SignalKind[];
  resolved?: boolean;
  offsetMs?: number;
  durationMs?: number;
}

function incident(id: string, opts: Opts = {}): Incident {
  const root = opts.root ?? 'payments';
  const resolved = opts.resolved ?? false;
  const openedMs = T0 + (opts.offsetMs ?? 0);
  const durationMs = opts.durationMs ?? 60_000;
  return {
    id,
    status: resolved ? 'resolved' : 'open',
    rootService: root,
    kinds: opts.kinds ?? ['latency'],
    affected: [{ service: 'orders', kinds: [] }],
    fingerprint: `${root}:${(opts.kinds ?? ['latency'])[0]}`,
    openedAt: new Date(openedMs).toISOString(),
    resolvedAt: resolved ? new Date(openedMs + durationMs).toISOString() : null,
    durationMs: resolved ? durationMs : null,
    peak: { latencyP95Ms: 1000, errorRatio: null, rssMb: null, minScore: null },
    recurrence: null,
    relatedChaos: [],
    similar: null,
  };
}

/** An incident whose `kinds` access throws, so feature extraction fails for it only. */
function poisoned(id: string): Incident {
  const base = incident(id);
  // Non-enumerable, so copying the incident (spread) does not trigger the getter.
  Object.defineProperty(base, 'kinds', {
    enumerable: false,
    get(): SignalKind[] {
      throw new Error('boom');
    },
  });
  return base;
}

function trackerWith(history: Incident[], open: Incident[] = []): TrackerState {
  const state = initialTrackerState(CHAIN);
  const openMap = { ...state.open };
  for (const o of open) openMap[o.rootService] = o;
  return { ...state, open: openMap, history };
}

describe('applySimilarity', () => {
  it('turns a throwing matcher into similar: null plus a failure, and keeps matching the rest', () => {
    // Validates: Requirements R8.14
    const past = incident('past', { resolved: true });
    const bad = poisoned('bad');
    const good = incident('good', { offsetMs: 10_000, root: 'payments' });
    const events: IncidentEvent[] = [
      { type: 'opened', incident: bad },
      { type: 'opened', incident: good },
    ];

    const result = applySimilarity(trackerWith([past]), events, NOW, CHAIN, CONFIG);

    expect(result.events).toHaveLength(2);
    expect(result.events[0].type).toBe('opened');
    expect(result.events[0].incident.id).toBe('bad');
    expect(result.events[0].incident.similar).toBeNull();

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ incidentId: 'bad', phase: 'open' });
    expect((result.failures[0].error as Error).message).toBe('boom');

    expect(result.events[1].incident.id).toBe('good');
    expect(result.events[1].incident.similar?.id).toBe('past');
  });

  it('reports phase "resolve" when the failing event is a resolution', () => {
    // Validates: Requirements R8.14
    const bad = poisoned('bad');
    const result = applySimilarity(
      trackerWith([]),
      [{ type: 'resolved', incident: bad }],
      NOW,
      CHAIN,
      CONFIG,
    );
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ incidentId: 'bad', phase: 'resolve' });
    expect(result.events[0].incident.similar).toBeNull();
  });

  it('lets two incidents resolving in the same Poll each see the other', () => {
    // Validates: Requirements R8.11
    const a = incident('a', { resolved: true, offsetMs: 0 });
    const b = incident('b', { resolved: true, offsetMs: 5_000 });
    const events: IncidentEvent[] = [
      { type: 'resolved', incident: a },
      { type: 'resolved', incident: b },
    ];

    const result = applySimilarity(trackerWith([a, b]), events, NOW, CHAIN, CONFIG);

    expect(result.failures).toEqual([]);
    expect(result.events[0].incident.similar?.id).toBe('b');
    expect(result.events[1].incident.similar?.id).toBe('a');
    // History entries are patched with the result too.
    expect(result.tracker.history.find((h) => h.id === 'a')?.similar?.id).toBe('b');
    expect(result.tracker.history.find((h) => h.id === 'b')?.similar?.id).toBe('a');
  });

  it('lets an opening incident see incidents resolved in the same Poll', () => {
    // Validates: Requirements R8.8
    const resolved = incident('resolved-now', { resolved: true });
    const opening = incident('opening', { offsetMs: 120_000 });
    const events: IncidentEvent[] = [
      { type: 'resolved', incident: resolved },
      { type: 'opened', incident: opening },
    ];

    const result = applySimilarity(
      trackerWith([resolved], [opening]),
      events,
      NOW,
      CHAIN,
      CONFIG,
    );

    expect(result.events[1].incident.similar?.id).toBe('resolved-now');
    expect(result.tracker.open[opening.rootService]?.similar?.id).toBe('resolved-now');
  });
});

describe('matching below the threshold', () => {
  const strict: EngineConfig = {
    ...BASE_CONFIG,
    similarity: { ...BASE_CONFIG.similarity, threshold: 0.99 },
  };
  const unlike = incident('unlike', {
    resolved: true,
    root: 'gateway',
    kinds: ['memory', 'down'],
  });

  it('returns null from matchOnOpen and matchOnResolve', () => {
    // Validates: Requirements R8.8
    const target = incident('t', { root: 'payments', kinds: ['latency'] });
    expect(matchOnOpen(target, [unlike], NOW, CHAIN, strict)).toBeNull();
    const resolvedTarget = incident('t', { resolved: true, root: 'payments', kinds: ['latency'] });
    expect(matchOnResolve(resolvedTarget, [unlike], CHAIN, strict)).toBeNull();
  });

  it('yields similar: null through applySimilarity without a failure', () => {
    // Validates: Requirements R8.8
    const target = incident('t', { root: 'payments', kinds: ['latency'] });
    const result = applySimilarity(
      trackerWith([unlike]),
      [{ type: 'opened', incident: target }],
      NOW,
      CHAIN,
      strict,
    );
    expect(result.failures).toEqual([]);
    expect(result.events[0].incident.similar).toBeNull();
  });

  it('returns null for an empty history', () => {
    const target = incident('t');
    expect(matchOnOpen(target, [], NOW, CHAIN, CONFIG)).toBeNull();
  });
});
