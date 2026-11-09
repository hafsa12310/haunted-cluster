import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigError, EngineConfig, loadEngineConfig } from './config/engine-config';
import { CorsIoAdapter } from './engine/cors-io.adapter';

/**
 * Haunting-engine entry point.
 *
 * - Validates the environment before the Nest app is created, so a
 *   misconfigured container exits immediately with a clear message.
 * - Enables a global `ValidationPipe` with `whitelist: true` for the chaos proxy bodies.
 * - Allows `CORS_ORIGIN` on both the REST API and Socket.IO, served on one port.
 * - Listens on `PORT` (default 4000).
 *
 * Requirements: 9.1, 9.5, 13.1, 13.3
 */
function loadConfigOrExit(): EngineConfig {
  try {
    return loadEngineConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[Bootstrap] ${error.message}. Exiting.`);
      process.exit(1);
    }
    throw error;
  }
}

async function bootstrap(): Promise<void> {
  const config = loadConfigOrExit();

  const app = await NestFactory.create(AppModule.forRoot(config));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.enableCors({ origin: config.corsOrigin });
  app.useWebSocketAdapter(new CorsIoAdapter(app));
  // Runs onModuleDestroy on SIGTERM (docker stop), so the poller stops cleanly.
  app.enableShutdownHooks();

  await app.listen(config.port);
}

bootstrap();
