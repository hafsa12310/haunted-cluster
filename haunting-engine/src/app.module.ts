import { DynamicModule, Module } from '@nestjs/common';
import { ChaosProxyModule } from './chaos-proxy/chaos-proxy.module';
import { ConfigModule } from './config/config.module';
import type { EngineConfig } from './config/engine-config';
import { EngineModule } from './engine/engine.module';
import { IncidentsModule } from './incidents/incidents.module';
import { MetricsModule } from './metrics/metrics.module';

/**
 * Root module. Takes an already-loaded config, like ConfigModule, so `main.ts`
 * can validate the environment before Nest starts.
 *
 * Requirements: 9.1
 */
@Module({})
export class AppModule {
  static forRoot(config: EngineConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        MetricsModule,
        ChaosProxyModule,
        IncidentsModule,
        EngineModule,
      ],
    };
  }
}
