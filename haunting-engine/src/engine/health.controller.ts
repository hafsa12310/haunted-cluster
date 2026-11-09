import { Controller, Get } from '@nestjs/common';

/**
 * Liveness check for docker compose's healthcheck. Answers even before the
 * first Poll and while Prometheus is down: it reports the engine, not the cluster.
 *
 * Requirements: 10.1
 */
@Controller('health')
export class HealthController {
  @Get()
  health(): { status: 'ok'; service: 'haunting-engine' } {
    return { status: 'ok', service: 'haunting-engine' };
  }
}
