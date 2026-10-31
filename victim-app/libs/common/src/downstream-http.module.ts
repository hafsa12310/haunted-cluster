import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';

/**
 * Provides a configured `HttpService` to any module that imports `DownstreamHttpModule`.
 *
 * Reads `DOWNSTREAM_TIMEOUT_MS` from the environment at startup (default 5000 ms).
 * The timeout is applied to every Axios request made via the injected `HttpService`,
 * which lets Gateway and Orders abort slow downstream calls and surface a 504 response.
 *
 * Requirements: 1.6, 11.2
 */
@Module({
  imports: [
    HttpModule.registerAsync({
      useFactory: () => ({
        timeout: parseInt(process.env.DOWNSTREAM_TIMEOUT_MS ?? '5000', 10),
      }),
    }),
  ],
  exports: [HttpModule],
})
export class DownstreamHttpModule {}
