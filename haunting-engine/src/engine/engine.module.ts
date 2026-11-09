import { Global, Module } from '@nestjs/common';
import { ChaosProxyModule } from '../chaos-proxy/chaos-proxy.module';
import { CHAOS_NOTIFIER } from '../chaos-proxy/chaos-proxy.service';
import { MetricsModule } from '../metrics/metrics.module';
import { EngineStateService } from './engine-state.service';
import { EventsGateway } from './events.gateway';
import { HealthController } from './health.controller';
import { PollerService } from './poller.service';
import { SnapshotController } from './snapshot.controller';

/**
 * The live loop: state, poller, Socket.IO gateway and the snapshot/health
 * endpoints.
 *
 * Global so ChaosProxyModule can inject `CHAOS_NOTIFIER` (this gateway) without
 * importing this module, which would be circular: this module imports
 * ChaosProxyModule for the poller's `ChaosLogService`.
 *
 * Requirements: 9.1
 */
@Global()
@Module({
  imports: [MetricsModule, ChaosProxyModule],
  controllers: [SnapshotController, HealthController],
  providers: [
    EngineStateService,
    PollerService,
    EventsGateway,
    { provide: CHAOS_NOTIFIER, useExisting: EventsGateway },
  ],
  exports: [EngineStateService, CHAOS_NOTIFIER],
})
export class EngineModule {}
