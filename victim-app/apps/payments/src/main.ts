import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { validateMemoryGaugeInterval } from '@app/common';
import { AppModule } from './app.module';

/**
 * Payments entry point.
 *
 * - No required env vars: Payments is the end of the call chain and has no
 *   downstream URL to validate.
 * - Enables a global `ValidationPipe` with `whitelist: true` so unknown
 *   properties are stripped from incoming DTOs.
 * - Listens on `PORT` (default 3002).
 *
 * Requirements: 11.1
 */
async function bootstrap(): Promise<void> {
  validateMemoryGaugeInterval();

  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));

  const port = Number(process.env.PORT) || 3002;
  await app.listen(port);
}

bootstrap();
