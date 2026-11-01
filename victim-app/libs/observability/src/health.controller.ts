import { Controller, Get, Inject } from '@nestjs/common';
import { METRICS_SERVICE_NAME } from './metrics.service';

/**
 * HealthController
 *
 * Exposes GET /health returning a static JSON object with the service name.
 * Makes no downstream calls — pure in-process response only.
 *
 * Requirements: 8.1, 8.2
 */
@Controller()
export class HealthController {
  constructor(
    @Inject(METRICS_SERVICE_NAME) private readonly serviceName: string,
  ) {}

  @Get('health')
  getHealth(): { status: string; service: string } {
    return { status: 'ok', service: this.serviceName };
  }
}
