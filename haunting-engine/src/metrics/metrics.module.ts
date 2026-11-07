import { Module } from '@nestjs/common';
import { MetricsCollectorService } from './metrics-collector.service';
import { PrometheusClient } from './prometheus.client';

/**
 * Reads telemetry from Prometheus. Relies on the global ConfigModule for
 * `ENGINE_CONFIG`; only the collector is exported.
 */
@Module({
  providers: [PrometheusClient, MetricsCollectorService],
  exports: [MetricsCollectorService],
})
export class MetricsModule {}
