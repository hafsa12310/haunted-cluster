import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { validateRequiredEnv } from '@app/common';
import { AppModule } from './app.module';

/**
 * Gateway entry point.
 *
 * - Validates required env vars before the Nest app is created, so a
 *   misconfigured container exits immediately with a clear message.
 * - Enables a global `ValidationPipe` with `whitelist: true` so unknown
 *   properties are stripped from incoming DTOs.
 * - Listens on `PORT` (default 3000).
 *
 * Requirements: 11.1, 11.3, 11.4
 */
async function bootstrap(): Promise<void> {
  validateRequiredEnv(['ORDERS_URL']);

  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
}

bootstrap();
