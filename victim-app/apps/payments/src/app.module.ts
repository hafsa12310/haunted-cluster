import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ObservabilityModule, MetricsInterceptor } from '@app/observability';
import { ChaosModule, ChaosInterceptor } from '@app/chaos';
import { CommonModule } from '@app/common';
import { CoreModule } from './core/core.module';

/**
 * AppModule — root module for the Payments service.
 *
 * Module imports:
 * - `ObservabilityModule.forRoot` — wires MetricsService, MetricsInterceptor,
 *   MetricsController (/metrics), and HealthController (/health) with the
 *   'payments' service label applied to all Prometheus metrics.
 * - `ChaosModule` — exposes /chaos/* endpoints and makes ChaosService and
 *   ChaosInterceptor available for global APP_INTERCEPTOR registration.
 * - `CoreModule` — Payments feature logic (CoreController, CoreService).
 * - `CommonModule` — provides GlobalExceptionFilter via APP_FILTER.
 *   No local APP_FILTER needed here.
 *
 * Interceptor registration order is intentional:
 *   1. MetricsInterceptor (outermost) — captures all traffic including any
 *      chaos-injected latency and errors in the recorded metrics.
 *   2. ChaosInterceptor (inner) — injects latency / errors on non-excluded routes.
 *
 * Requirements: 1.3, 2.2, 3.1, 4.1
 */
@Module({
  imports: [
    ObservabilityModule.forRoot({ serviceName: 'payments' }),
    ChaosModule,
    CoreModule,
    CommonModule,
  ],
  providers: [
    // MetricsInterceptor must be first (outermost) so chaos-injected latency
    // and errors are reflected in the Prometheus metrics. Requirements: 2.2
    {
      provide: APP_INTERCEPTOR,
      useClass: MetricsInterceptor,
    },
    // ChaosInterceptor is second (inner) — delays and error injection happen
    // inside the metrics timing window. Requirements: 3.1, 4.1
    {
      provide: APP_INTERCEPTOR,
      useClass: ChaosInterceptor,
    },
  ],
})
export class AppModule {}
