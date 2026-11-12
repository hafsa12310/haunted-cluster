// Feature: engine-intelligence
// Applies similarity matching to incidents that open or resolve in a Poll
// (R8.6, R8.9, R8.11 to R8.14, R7.4). Pure: no I/O, no clock reads, no mutation of inputs.
import type { Incident, ServiceName, SimilarIncident } from '@haunted-cluster/shared';
import type { EngineConfig } from '../../config/engine-config';
import type { IncidentEvent, TrackerState } from '../../incidents/incident-tracker';
import {
  extractFeatures,
  withoutDuration,
  type FeatureConfig,
  type FeatureVector,
} from './feature-extractor';
import { selectSimilar, type Candidate, type Match } from './similarity-matcher';

/** Rounds similarity to 3 decimals and the matched duration to whole seconds. */
export function toSimilarIncident(match: Match): SimilarIncident {
  const { incident, similarity } = match;
  const durationMs = incident.durationMs ?? 0;
  return {
    id: incident.id,
    fingerprint: incident.fingerprint,
    resolvedAt: incident.resolvedAt ?? '',
    durationSeconds: Math.round(durationMs / 1000),
    similarity: Math.round(similarity * 1000) / 1000,
  };
}

function featureConfig(config: EngineConfig): FeatureConfig {
  return {
    latencyCriticalMs: config.latencyMs.critical,
    errorRatioCritical: config.errorRatio.critical,
    memoryLimitMb: config.memoryLimitMb,
    durationCapSeconds: config.similarity.durationCapSeconds,
  };
}

/** Compares Comparison_Vectors (no duration entry) against every history incident (R8.6). */
export function matchOnOpen(
  incident: Incident,
  history: readonly Incident[],
  nowMs: number,
  chain: readonly ServiceName[],
  config: EngineConfig,
): SimilarIncident | null {
  const fc = featureConfig(config);
  const target = withoutDuration(extractFeatures(incident, nowMs, chain, fc));
  const candidates: Candidate[] = history.map((h) => ({
    incident: h,
    vector: withoutDuration(extractFeatures(h, nowMs, chain, fc)),
  }));
  const match = selectSimilar(target, candidates, config.similarity.threshold);
  return match === null ? null : toSimilarIncident(match);
}

/** Compares full vectors, excluding the incident's own id from the candidates (R8.11, R8.12). */
export function matchOnResolve(
  incident: Incident,
  history: readonly Incident[],
  chain: readonly ServiceName[],
  config: EngineConfig,
): SimilarIncident | null {
  const fc = featureConfig(config);
  // A resolved incident's duration comes from durationMs, so nowMs is not read.
  const nowMs = incident.resolvedAt === null ? 0 : Date.parse(incident.resolvedAt);
  const target: FeatureVector = extractFeatures(incident, nowMs, chain, fc);
  const candidates: Candidate[] = history
    .filter((h) => h.id !== incident.id)
    .map((h) => ({ incident: h, vector: extractFeatures(h, nowMs, chain, fc) }));
  const match = selectSimilar(target, candidates, config.similarity.threshold);
  return match === null ? null : toSimilarIncident(match);
}

export interface SimilarityFailure {
  incidentId: string;
  phase: 'open' | 'resolve';
  error: unknown;
}

export function applySimilarity(
  tracker: TrackerState,
  events: readonly IncidentEvent[],
  nowMs: number,
  chain: readonly ServiceName[],
  config: EngineConfig,
): { tracker: TrackerState; events: IncidentEvent[]; failures: SimilarityFailure[] } {
  const failures: SimilarityFailure[] = [];
  const open = { ...tracker.open };
  let history = tracker.history;
  const outEvents: IncidentEvent[] = [];

  for (const event of events) {
    if (event.type === 'updated') {
      outEvents.push(event);
      continue;
    }

    const phase: SimilarityFailure['phase'] = event.type === 'opened' ? 'open' : 'resolve';
    let similar: SimilarIncident | null;
    try {
      similar =
        event.type === 'opened'
          ? matchOnOpen(event.incident, tracker.history, nowMs, chain, config)
          : matchOnResolve(event.incident, tracker.history, chain, config);
    } catch (error) {
      similar = null;
      failures.push({ incidentId: event.incident.id, phase, error });
    }

    const patched: Incident = { ...event.incident, similar };
    outEvents.push({ type: event.type, incident: patched });

    if (event.type === 'opened') {
      const root = event.incident.rootService;
      if (open[root]?.id === event.incident.id) open[root] = { ...open[root], similar };
    } else {
      history = history.map((h) => (h.id === event.incident.id ? { ...h, similar } : h));
    }
  }

  return { tracker: { ...tracker, open, history }, events: outEvents, failures };
}
