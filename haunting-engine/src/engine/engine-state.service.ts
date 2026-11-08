import { Inject, Injectable } from '@nestjs/common';
import type { ClusterSnapshot, Incident } from '@haunted-cluster/shared';
import { ENGINE_CONFIG } from '../config/config.module';
import type { EngineConfig } from '../config/engine-config';
import { initialTrackerState, TrackerState } from '../incidents/incident-tracker';

/**
 * The single owner of the engine's mutable state: the latest Cluster_Snapshot
 * and the incident tracker's state. PollerService is the only writer;
 * controllers and the gateway only read.
 *
 * Requirements: 9.4, 10.2, 10.3
 */
@Injectable()
export class EngineStateService {
  private snapshot: ClusterSnapshot | null = null;
  private trackerState: TrackerState;

  constructor(@Inject(ENGINE_CONFIG) private readonly config: EngineConfig) {
    this.trackerState = initialTrackerState(config.serviceChain);
  }

  /** null until the first Poll completes. */
  get latestSnapshot(): ClusterSnapshot | null {
    return this.snapshot;
  }

  get tracker(): TrackerState {
    return this.trackerState;
  }

  /** Replaces both at once, so readers never see a snapshot and tracker from different Polls. */
  update(snapshot: ClusterSnapshot, tracker: TrackerState): void {
    this.snapshot = snapshot;
    this.trackerState = tracker;
  }

  /** Open incidents in SERVICE_CHAIN order, upstream first. */
  openIncidents(): Incident[] {
    const open = this.trackerState.open;
    return this.config.serviceChain.flatMap((s) => open[s] ?? []);
  }

  /** Resolved incidents, newest first. */
  resolvedIncidents(): Incident[] {
    return [...this.trackerState.history];
  }
}
