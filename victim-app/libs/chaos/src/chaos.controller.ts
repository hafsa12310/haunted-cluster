import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ChaosService } from './chaos.service';
import { SetLatencyDto } from './dto/set-latency.dto';
import { SetErrorRateDto } from './dto/set-error-rate.dto';
import { SetMemoryLeakDto } from './dto/set-memory-leak.dto';
import { ChaosStateResponse } from './chaos.service';

/**
 * ChaosController
 *
 * Exposes the chaos-injection API under the `/chaos` prefix.
 * Every mutating endpoint is a POST; the read endpoint is a GET.
 *
 * Requirements: 3.1, 3.3, 3.4, 3.5, 4.1, 4.3, 4.4, 4.5,
 *               5.1, 5.4, 5.5, 6.1, 6.2, 7.1, 7.2, 7.3, 7.5
 */
@Controller('chaos')
export class ChaosController {
  constructor(private readonly chaosService: ChaosService) {}

  /**
   * Set synthetic latency for every subsequent request.
   * Requirements: 3.1, 3.3, 3.4, 3.5
   */
  @Post('latency')
  setLatency(@Body() dto: SetLatencyDto): { message: string; ms: number } {
    this.chaosService.setLatency(dto.ms);
    return { message: 'latency set', ms: dto.ms };
  }

  /**
   * Set the error-injection rate (0–100 %).
   * Requirements: 4.1, 4.3, 4.4, 4.5
   */
  @Post('error-rate')
  setErrorRate(
    @Body() dto: SetErrorRateDto,
  ): { message: string; percentage: number } {
    this.chaosService.setErrorRate(dto.percentage);
    return { message: 'error rate set', percentage: dto.percentage };
  }

  /**
   * Enable or disable the simulated memory leak.
   * Requirements: 5.1, 5.4, 5.5
   */
  @Post('memory-leak')
  setMemoryLeak(@Body() dto: SetMemoryLeakDto): { message: string } {
    if (dto.enabled) {
      this.chaosService.enableMemoryLeak();
      return { message: 'memory leak enabled' };
    } else {
      this.chaosService.disableMemoryLeak();
      return { message: 'memory leak disabled' };
    }
  }

  /**
   * Trigger a process crash 100 ms after the 202 response is sent.
   * Requirements: 6.1, 6.2
   */
  @Post('crash')
  @HttpCode(202)
  crash(): { message: string } {
    // Return the body first; ChaosService.crash() schedules process.exit(1)
    // 100 ms later so the response is flushed before termination.
    const response = { message: 'crashing' };
    this.chaosService.crash();
    return response;
  }

  /**
   * Reset all active chaos settings and free retained memory.
   * Requirements: 7.1, 7.2, 7.3
   */
  @Post('reset')
  reset(): { message: string } {
    this.chaosService.reset();
    return { message: 'chaos reset' };
  }

  /**
   * Return a serialisable snapshot of the current chaos state.
   * Requirements: 7.5
   */
  @Get('state')
  getState(): ChaosStateResponse {
    return this.chaosService.getState();
  }
}
