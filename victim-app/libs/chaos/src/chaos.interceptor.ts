import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { isExcludedRoute } from '@app/common';
import { ChaosService } from './chaos.service';

/**
 * Pauses execution for the given number of milliseconds.
 * Using a local helper keeps the interceptor free of any global timer
 * references and makes it easy to replace in tests.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ChaosInterceptor
 *
 * Registered globally as APP_INTERCEPTOR (second, after MetricsInterceptor).
 * For every non-excluded inbound request it:
 *   1. Optionally waits `latencyMs` milliseconds (latency injection).
 *   2. Optionally throws an HTTP 500 at the configured probability (error-rate injection).
 *
 * Excluded routes (/metrics, /health, /chaos/*) are passed through
 * immediately — no delay, no error injection.
 *
 * Requirements: 3.1, 3.2, 4.1, 4.2, 7.6
 */
@Injectable()
export class ChaosInterceptor implements NestInterceptor {
  constructor(private readonly chaosService: ChaosService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<{ path: string }>();

    // Skip all chaos logic for operational routes. Requirements: 7.6
    if (isExcludedRoute(req.path)) {
      return next.handle();
    }

    // Latency injection — delay the request before passing to the handler.
    // Requirements: 3.1, 3.2
    const { latencyMs, errorRatePercent } = this.chaosService.state;

    if (latencyMs > 0) {
      await sleep(latencyMs);
    }

    // Error-rate injection — probabilistically abort the request with HTTP 500.
    // Requirements: 4.1, 4.2
    if (errorRatePercent > 0) {
      const roll = Math.random() * 100;
      if (roll < errorRatePercent) {
        throw new HttpException(
          { message: 'chaos: injected error' },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    }

    return next.handle();
  }
}
