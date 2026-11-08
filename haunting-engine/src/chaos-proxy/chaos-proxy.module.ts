import { Module } from '@nestjs/common';
import { ChaosLogService } from './chaos-log.service';
import { ChaosProxyController } from './chaos-proxy.controller';
import { ChaosProxyService } from './chaos-proxy.service';
import { KnownServicePipe } from './known-service.pipe';

/**
 * `/api/chaos/*` and the log of accepted chaos commands.
 *
 * Relies on the global ConfigModule for `ENGINE_CONFIG` and `CLOCK`, and on a
 * globally provided `CHAOS_NOTIFIER` (the EventsGateway). The notifier isn't
 * imported here because the engine module, which owns the gateway, imports this
 * module for `ChaosLogService`; importing it back would make the two circular.
 *
 * Requirements: 7.1
 */
@Module({
  controllers: [ChaosProxyController],
  providers: [ChaosLogService, ChaosProxyService, KnownServicePipe],
  exports: [ChaosLogService],
})
export class ChaosProxyModule {}
