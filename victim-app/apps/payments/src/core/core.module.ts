import { Module } from '@nestjs/common';
import { CoreService } from './core.service';
import { CoreController } from './core.controller';

/**
 * CoreModule wires up the Payments service's primary request-handling feature.
 *
 * Payments is the end of the call chain and makes no downstream calls, so
 * unlike Gateway and Orders it does not import `DownstreamHttpModule`.
 *
 * Requirements: 1.3
 */
@Module({
  controllers: [CoreController],
  providers: [CoreService],
  exports: [CoreService],
})
export class CoreModule {}
