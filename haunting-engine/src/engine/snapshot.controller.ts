import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import type { ClusterSnapshot } from '@haunted-cluster/shared';
import { EngineStateService } from './engine-state.service';

/** Requirements: 10.2 */
@Controller('api/snapshot')
export class SnapshotController {
  constructor(private readonly state: EngineStateService) {}

  /** The latest Cluster_Snapshot, or 503 until the first Poll completes. */
  @Get()
  snapshot(): ClusterSnapshot {
    const snapshot = this.state.latestSnapshot;
    if (!snapshot) {
      // An object body, so the response is exactly { message } (design.md, Error Handling).
      throw new ServiceUnavailableException({ message: 'no poll has completed yet' });
    }
    return snapshot;
  }
}
