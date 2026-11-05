/**
 * Incidents tracked by the haunting-engine, from opening to resolution.
 *
 * Requirements: 1.1
 */
import type { ChaosEvent } from './chaos';
import type { ServiceName, SignalKind } from './service-health';

export interface AffectedService {
  service: ServiceName;
  kinds: SignalKind[];
}

/** Worst values seen on the root service while the incident was open. */
export interface PeakSignals {
  latencyP95Ms: number | null;
  errorRatio: number | null;
  rssMb: number | null;
  minScore: number | null;
}

/** Earlier resolved incidents with the same fingerprint. */
export interface IncidentRecurrence {
  count: number;
  lastIncidentId: string;
  lastResolvedAt: string;
  lastDurationMs: number;
}

export interface Incident {
  /** UUID v4. */
  id: string;
  status: 'open' | 'resolved';
  rootService: ServiceName;
  kinds: SignalKind[];
  affected: AffectedService[];
  /** "<rootService>:<primaryKind>". */
  fingerprint: string;
  /** ISO 8601. */
  openedAt: string;
  resolvedAt: string | null;
  durationMs: number | null;
  peak: PeakSignals;
  recurrence: IncidentRecurrence | null;
  /** Chaos commands on the root service shortly before opening, newest first. */
  relatedChaos: ChaosEvent[];
}
