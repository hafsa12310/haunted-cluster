import { DynamicModule, Module } from '@nestjs/common';
import { METRICS_SERVICE_NAME, MetricsService } from './metrics.service';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsController } from './metrics.controller';
import { HealthController } from './health.controller';

export interface ObservabilityModuleOptions {
  serviceName: string;
}

/**
 * ObservabilityModule
 *
 * Dynamic module providing Prometheus metrics and a health endpoint to each
 * app.  Call `ObservabilityModule.forRoot({ serviceName })` in the app's
 * `AppModule` imports.  The `serviceName` string is bound to the
 * `METRICS_SERVICE_NAME` injection token so both `MetricsService` and
 * `HealthController` receive it automatically.
 *
 * APP_INTERCEPTOR registration is intentionally left to each app's AppModule
 * so that interceptor order (MetricsInterceptor first, then ChaosInterceptor)
 * can be controlled per-application.
 *
 * Requirements: 2.1, 2.8, 8.1
 */
@Module({})
export class ObservabilityModule {
  static forRoot(options: ObservabilityModuleOptions): DynamicModule {
    return {
      module: ObservabilityModule,
      controllers: [MetricsController, HealthController],
      providers: [
        {
          provide: METRICS_SERVICE_NAME,
          useValue: options.serviceName,
        },
        MetricsService,
        MetricsInterceptor,
      ],
      exports: [
        METRICS_SERVICE_NAME,
        MetricsService,
        MetricsInterceptor,
        MetricsController,
        HealthController,
      ],
    };
  }
}
