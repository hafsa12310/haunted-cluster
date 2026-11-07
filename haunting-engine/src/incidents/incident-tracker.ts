/**
 * Incident tracker: turns per-Poll attributions into incidents that open,
 * update and resolve, with recurrence and chaos evidence attached.
 *
 * Pure: `trackIncidents` never mutates its input state and gets time and IDs
 * from its caller, so whole Poll sequences can be replayed in tests.
 *
 * Requirements: 5.1–5.7, 6.1–6.3, 8.1
 */

import type {
  AffectedService,
  ChaosEvent,
  Incident,
  IncidentRecurrence,
  PeakSignals,
  ServiceHealth,
  ServiceName,
  SignalKind,
} from '@haunted-cluster/shared';
import type { EngineConfig } from '../config/engine-config';
import type { Attribution } from './attribution';

export interface Streak {
  /** Consecutive known Polls in which the service was a Root_Service. */
  asRoot: number;
  /** Consecutive known Polls in which it was not. */
  notRoot: number;
}

export interface TrackerState {
  /** At most one open incident per root service. */
  open: Record<ServiceName, Incident>;
  streaks: Record<ServiceName, Streak>;
  /** Resolved incidents, newest first, at most `incidentHistoryLimit`. */
  history: Incident[];
}

export type IncidentEvent =
  | { type: 'opened'; incident: Incident }
  | { type: 'updated'; incident: Incident }
  | { type: 'resolved'; incident: Incident };

export interface PollInput {
  /** Epoch ms. */
  now: number;
  metricsAvailable: boolean;
  health: Record<ServiceName, ServiceHealth>;
  attributions: Attribution[];
  /** Newest first. */
  chaosEvents: ChaosEvent[];
}

export function initialTrackerState(chain: ServiceName[]): TrackerState {
  return {
    open: {},
    streaks: Object.fromEntries(chain.map((s) => [s, { asRoot: 0, notRoot: 0 }])),
    history: [],
  };
}

/** Primary-kind ties are broken in this order. */
const PRIMARY_KIND_ORDER = ['errors', 'latency', 'memory'] as const;

/**
 * `"<rootService>:<primaryKind>"`: `down` if present, otherwise the kind with
 * the highest Badness, ties broken `errors` > `latency` > `memory`.
 * Requirements: 5.7
 */
export function fingerprint(
  rootService: ServiceName,
  kinds: SignalKind[],
  health: ServiceHealth,
): string {
  if (kinds.includes('down')) return `${rootService}:down`;
  let primary: (typeof PRIMARY_KIND_ORDER)[number] | undefined;
  for (const k of PRIMARY_KIND_ORDER) {
    if (!kinds.includes(k)) continue;
    // Strictly greater, so an earlier kind wins a tie.
    if (primary === undefined || health.badness[k] > health.badness[primary]) primary = k;
  }
  if (primary === undefined) {
    throw new Error(`fingerprint: no kinds for ${rootService}`);
  }
  return `${rootService}:${primary}`;
}

/** Requirements: 5.1–5.7, 6.1–6.3, 8.1 */
export function trackIncidents(
  state: TrackerState,
  input: PollInput,
  config: EngineConfig,
  newId: () => string,
): { state: TrackerState; events: IncidentEvent[] } {
  // Requirement 5.6: a blind Poll changes nothing, not even the streaks.
  if (!input.metricsAvailable) return { state, events: [] };

  const roots = new Map(input.attributions.map((a) => [a.rootService, a]));
  const open = { ...state.open };
  const streaks = { ...state.streaks };
  let history = state.history;
  const events: IncidentEvent[] = [];

  for (const s of config.serviceChain) {
    const health = input.health[s];
    // Unknown services keep their streaks frozen until they are visible again.
    if (health === undefined || health.status === 'unknown') continue;

    const prev = streaks[s] ?? { asRoot: 0, notRoot: 0 };
    const current = open[s];
    const attribution = roots.get(s);

    if (attribution) {
      streaks[s] = { asRoot: prev.asRoot + 1, notRoot: 0 };
      if (
        current === undefined &&
        (streaks[s].asRoot >= config.openAfterPolls || attribution.kinds.includes('down'))
      ) {
        const incident = openIncident(attribution, health, history, input, config, newId);
        open[s] = incident;
        events.push({ type: 'opened', incident });
      } else if (current !== undefined) {
        const kinds = unionKinds(current.kinds, attribution.kinds);
        const changed =
          kinds.length !== current.kinds.length ||
          !sameAffected(current.affected, attribution.affected);
        const incident: Incident = {
          ...current,
          kinds,
          affected: attribution.affected.map((a) => ({ service: a.service, kinds: [...a.kinds] })),
          peak: raisePeak(current.peak, health),
        };
        open[s] = incident;
        if (changed) events.push({ type: 'updated', incident });
      }
    } else {
      streaks[s] = { asRoot: 0, notRoot: prev.notRoot + 1 };
      if (current !== undefined && streaks[s].notRoot >= config.closeAfterPolls) {
        const incident: Incident = {
          ...current,
          status: 'resolved',
          resolvedAt: new Date(input.now).toISOString(),
          durationMs: input.now - Date.parse(current.openedAt),
        };
        delete open[s];
        history = [incident, ...history].slice(0, config.incidentHistoryLimit);
        events.push({ type: 'resolved', incident });
      }
    }
  }

  return { state: { open, streaks, history }, events };
}

function openIncident(
  attribution: Attribution,
  health: ServiceHealth,
  history: Incident[],
  input: PollInput,
  config: EngineConfig,
  newId: () => string,
): Incident {
  const root = attribution.rootService;
  const kinds = [...attribution.kinds];
  const print = fingerprint(root, kinds, health);
  const since = input.now - config.chaosEvidenceWindowSeconds * 1000;

  return {
    id: newId(),
    status: 'open',
    rootService: root,
    kinds,
    affected: attribution.affected.map((a) => ({ service: a.service, kinds: [...a.kinds] })),
    fingerprint: print,
    openedAt: new Date(input.now).toISOString(),
    resolvedAt: null,
    durationMs: null,
    peak: {
      latencyP95Ms: health.signals.latencyP95Ms,
      errorRatio: health.signals.errorRatio,
      rssMb: health.signals.rssMb,
      minScore: health.score,
    },
    recurrence: recurrenceFor(print, history),
    relatedChaos: input.chaosEvents
      .filter((e) => e.service === root && Date.parse(e.at) >= since)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
  };
}

/** Requirements: 6.2, 6.3 */
function recurrenceFor(print: string, history: Incident[]): IncidentRecurrence | null {
  const matches = history.filter((i) => i.fingerprint === print);
  if (matches.length === 0) return null;
  const last = matches[0];
  return {
    count: matches.length,
    lastIncidentId: last.id,
    // History only ever holds resolved incidents, so both are set.
    lastResolvedAt: last.resolvedAt!,
    lastDurationMs: last.durationMs!,
  };
}

/** Kinds only grow while an incident is open: existing order kept, new kinds appended. */
function unionKinds(existing: SignalKind[], incoming: SignalKind[]): SignalKind[] {
  return [...existing, ...incoming.filter((k) => !existing.includes(k))];
}

function sameAffected(a: AffectedService[], b: AffectedService[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (x, i) =>
        x.service === b[i].service &&
        x.kinds.length === b[i].kinds.length &&
        x.kinds.every((k, j) => k === b[i].kinds[j]),
    )
  );
}

/** Max of each signal and min score, ignoring nulls. */
function raisePeak(peak: PeakSignals, health: ServiceHealth): PeakSignals {
  return {
    latencyP95Ms: maxOf(peak.latencyP95Ms, health.signals.latencyP95Ms),
    errorRatio: maxOf(peak.errorRatio, health.signals.errorRatio),
    rssMb: maxOf(peak.rssMb, health.signals.rssMb),
    minScore: minOf(peak.minScore, health.score),
  };
}

function maxOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function minOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}
