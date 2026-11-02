import { Module } from '@nestjs/common';
import { ChaosService } from './chaos.service';
import { ChaosInterceptor } from './chaos.interceptor';
import { ChaosController } from './chaos.controller';

/**
 * ChaosModule
 *
 * Bundles the chaos-injection feature for use in each app module.
 * Import this module in any AppModule to expose the /chaos/* endpoints
 * and make ChaosService and ChaosInterceptor available for injection.
 *
 * Requirements: 3.1, 4.1, 5.1, 6.1, 7.1
 */
@Module({
  controllers: [ChaosController],
  providers: [ChaosService, ChaosInterceptor],
  exports: [ChaosService, ChaosInterceptor],
})
export class ChaosModule {}
