import { Controller, Get, Res } from '@nestjs/common';
import { ServerResponse } from 'http';
import { MetricsService } from './metrics.service';

/**
 * MetricsController
 *
 * Exposes a single `GET /metrics` endpoint that returns the Prometheus
 * text-format metrics output from this service's private registry.
 *
 * The `Content-Type` header is set to `text/plain; version=0.0.4` as
 * required by the Prometheus exposition format so scrapers can correctly
 * parse the response.
 *
 * Requirements: 2.1
 */
@Controller()
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get('metrics')
  async getMetrics(@Res() res: ServerResponse): Promise<void> {
    const metrics = await this.metricsService.getMetrics();
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.end(metrics);
  }
}
