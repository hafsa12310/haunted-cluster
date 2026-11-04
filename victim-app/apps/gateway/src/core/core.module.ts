import { Module } from '@nestjs/common';
import { DownstreamHttpModule } from '@app/common';
import { CoreService } from './core.service';
import { CoreController } from './core.controller';

/**
 * CoreModule wires up the Gateway's primary request-handling feature.
 *
 * - Imports `DownstreamHttpModule` to inject a pre-configured `HttpService`
 *   into `CoreService` (DOWNSTREAM_TIMEOUT_MS applied automatically).
 * - Declares and exports `CoreService` and `CoreController` so they are
 *   available to the root `AppModule` once it imports `CoreModule`.
 *
 * Requirements: 1.1, 1.7
 */
@Module({
  imports: [DownstreamHttpModule],
  controllers: [CoreController],
  providers: [CoreService],
  exports: [CoreService],
})
export class CoreModule {}
