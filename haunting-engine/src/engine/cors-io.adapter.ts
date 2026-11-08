import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';
import { ENGINE_CONFIG } from '../config/config.module';
import type { EngineConfig } from '../config/engine-config';

/**
 * Socket.IO adapter that allows `CORS_ORIGIN`. `@WebSocketGateway` options are
 * read when the class is defined, before DI exists, so CORS can't come from the
 * config there; this adapter reads it from the app instead.
 *
 * Requirements: 9.1, 9.5
 */
export class CorsIoAdapter extends IoAdapter {
  private readonly corsOrigin: string;

  constructor(app: INestApplicationContext) {
    super(app);
    this.corsOrigin = app.get<EngineConfig>(ENGINE_CONFIG).corsOrigin;
  }

  override createIOServer(port: number, options?: Partial<ServerOptions>): unknown {
    return super.createIOServer(port, { ...options, cors: { origin: this.corsOrigin } });
  }
}
