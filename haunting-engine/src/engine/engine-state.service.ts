import { Inject, Injectable } from '@nestjs/common';
import type { ClusterSnapshot, Incident } from '@haunted-cluster/shared';
import { ENGINE_CONFIG } from '../config/config.module';
import type { EngineConfig } from '../config/engine-config';
import { initialTrackerState, TrackerState } from '../incidents/incident-tracker';
import { initialIntelligenceState } from '../intelligence/intelligence-step';
import type { IntelligenceState } from '../intelligence/intelligence-types';

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
  private intelligenceState: IntelligenceState;

  constructor(@Inject(ENGINE_CONFIG) private readonly config: EngineConfig) {
    this.trackerState = initialTrackerState(config.serviceChain);
    this.intelligenceState = initialIntelligenceState(config.serviceChain);
  }

  /** null until the first Poll completes. */
  get latestSnapshot(): ClusterSnapshot | null {
    return this.snapshot;
  }

  get tracker(): TrackerState {
    return this.trackerState;
  }

  get intelligence(): IntelligenceState {
    return this.intelligenceState;
  }

  /** Replaces all three at once, so readers never see state from different Polls. */
  update(snapshot: ClusterSnapshot, tracker: TrackerState, intelligence: IntelligenceState): void {
    this.snapshot = snapshot;
    this.trackerState = tracker;
    this.intelligenceState = intelligence;
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
