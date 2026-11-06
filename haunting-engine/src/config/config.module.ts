import { DynamicModule, Global, Module } from '@nestjs/common';
import { EngineConfig } from './engine-config';

/** Injection token for the validated `EngineConfig`. */
export const ENGINE_CONFIG = Symbol('ENGINE_CONFIG');

/** Injection token for the `Clock`. */
export const CLOCK = Symbol('CLOCK');

/** Source of the current time in epoch milliseconds, injectable so tests can control it. */
export interface Clock {
  now(): number;
}

/**
 * Global module providing `ENGINE_CONFIG` and `CLOCK` to every other module.
 *
 * It takes an already-loaded config rather than reading `process.env` itself:
 * `main.ts` calls `loadEngineConfig` before `NestFactory.create`, so an invalid
 * environment exits with a clear log line instead of failing inside DI.
 *
 * Requirements: 13.2
 */
@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: EngineConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [
        { provide: ENGINE_CONFIG, useValue: config },
        { provide: CLOCK, useValue: { now: () => Date.now() } satisfies Clock },
      ],
      exports: [ENGINE_CONFIG, CLOCK],
    };
  }
}
