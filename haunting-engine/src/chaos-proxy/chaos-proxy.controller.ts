import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import type { ServiceName } from '@haunted-cluster/shared';
import { ChaosProxyService, ProxyResponse, ResetResult } from './chaos-proxy.service';
import { SetErrorRateDto } from './dto/set-error-rate.dto';
import { SetLatencyDto } from './dto/set-latency.dto';
import { SetMemoryLeakDto } from './dto/set-memory-leak.dto';
import { KnownServicePipe } from './known-service.pipe';

/** The only part of the Express response the controller touches. */
interface StatusResponse {
  status(code: number): unknown;
}

/**
 * `/api/chaos/*`: the UI's way to break and repair victim services. Bodies are
 * validated by the global ValidationPipe; `:service` by KnownServicePipe.
 * Each forwarded call replies with the status the proxy mapped it to.
 *
 * Requirements: 7.1, 7.3
 */
@Controller('api/chaos')
export class ChaosProxyController {
  constructor(private readonly proxy: ChaosProxyService) {}

  // Declared before the /:service routes so "reset-all" is never taken as a service name.
  /** Requirements: 7.5 */
  @Post('reset-all')
  @HttpCode(200)
  resetAll(): Promise<{ results: ResetResult[] }> {
    return this.proxy.resetAll();
  }

  @Post(':service/latency')
  latency(
    @Param('service', KnownServicePipe) service: ServiceName,
    @Body() dto: SetLatencyDto,
    @Res({ passthrough: true }) res: StatusResponse,
  ): Promise<unknown> {
    return this.reply(res, this.proxy.forward(service, 'latency', { ms: dto.ms }));
  }

  @Post(':service/error-rate')
  errorRate(
    @Param('service', KnownServicePipe) service: ServiceName,
    @Body() dto: SetErrorRateDto,
    @Res({ passthrough: true }) res: StatusResponse,
  ): Promise<unknown> {
    return this.reply(res, this.proxy.forward(service, 'error-rate', { percentage: dto.percentage }));
  }

  @Post(':service/memory-leak')
  memoryLeak(
    @Param('service', KnownServicePipe) service: ServiceName,
    @Body() dto: SetMemoryLeakDto,
    @Res({ passthrough: true }) res: StatusResponse,
  ): Promise<unknown> {
    return this.reply(res, this.proxy.forward(service, 'memory-leak', { enabled: dto.enabled }));
  }

  @Post(':service/crash')
  crash(
    @Param('service', KnownServicePipe) service: ServiceName,
    @Res({ passthrough: true }) res: StatusResponse,
  ): Promise<unknown> {
    return this.reply(res, this.proxy.forward(service, 'crash'));
  }

  @Post(':service/reset')
  reset(
    @Param('service', KnownServicePipe) service: ServiceName,
    @Res({ passthrough: true }) res: StatusResponse,
  ): Promise<unknown> {
    return this.reply(res, this.proxy.forward(service, 'reset'));
  }

  @Get(':service/state')
  state(@Param('service', KnownServicePipe) service: ServiceName): Promise<unknown> {
    return this.proxy.state(service);
  }

  /** Sets the HTTP status from the forwarded response and returns its body. */
  private async reply(res: StatusResponse, pending: Promise<ProxyResponse>): Promise<unknown> {
    const { status, body } = await pending;
    res.status(status);
    return body;
  }
}
