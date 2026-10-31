import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { DownstreamHttpModule } from './downstream-http.module';
import { GlobalExceptionFilter } from './global-exception.filter';

/**
 * Shared module imported by every app (Gateway, Orders, Payments).
 *
 * Provides:
 * - `DownstreamHttpModule` — re-exported so importing apps get `HttpService`
 *   pre-configured with `DOWNSTREAM_TIMEOUT_MS` (Requirements: 1.6, 11.2).
 * - `GlobalExceptionFilter` registered globally via `APP_FILTER` so every app
 *   that imports `CommonModule` gets consistent exception handling without
 *   registering a local filter (Requirements: 1.4, 1.5).
 *
 * Pure-function exports (`mapDownstreamError`, `isExcludedRoute`,
 * `validateRequiredEnv`) are plain TypeScript exports from the barrel
 * `index.ts` and do not need to be wired as NestJS providers.
 */
@Module({
  imports: [DownstreamHttpModule],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
  exports: [DownstreamHttpModule],
})
export class CommonModule {}
