import { Module } from '@nestjs/common';
import { DownstreamHttpModule } from '@app/common';
import { CoreService } from './core.service';
import { CoreController } from './core.controller';

/**
 * CoreModule wires up the Orders service's primary request-handling feature.
 *
 * - Imports `DownstreamHttpModule` to inject a pre-configured `HttpService`
 *   into `CoreService` (DOWNSTREAM_TIMEOUT_MS applied automatically).
 * - Declares `CoreController` and provides/exports `CoreService` so they are
 *   available to the root `AppModule` once it imports `CoreModule`.
 *
 * Requirements: 1.2, 1.8
 */
@Module({
  imports: [DownstreamHttpModule],
  controllers: [CoreController],
  providers: [CoreService],
  exports: [CoreService],
})
export class CoreModule {}
