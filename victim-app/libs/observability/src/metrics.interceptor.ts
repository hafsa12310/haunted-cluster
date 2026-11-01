import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { IncomingMessage, ServerResponse } from 'http';
import { isExcludedRoute } from '@app/common';
import { MetricsService } from './metrics.service';

/**
 * MetricsInterceptor
 *
 * Records per-request metrics for every non-excluded route by hooking into
 * the Node.js ServerResponse `close` event. Using `close` (rather than
 * `finish`) means the callback fires for both normally-completed responses
 * and client-aborted connections, allowing aborted requests to be recorded
 * with status 499.
 *
 * Registration order: MetricsInterceptor is registered FIRST (outermost),
 * so it wraps ChaosInterceptor. This means injected latency and chaos-
 * injected 500s are both captured in the recorded metrics.
 *
 * Requirements: 2.2, 2.3, 2.4, 2.5
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metricsService: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<IncomingMessage & {
      route?: { path?: string };
    }>();
    const res = context.switchToHttp().getResponse<ServerResponse>();

    const path: string = (req as IncomingMessage & { path?: string }).path
      ?? (req.url ?? '');

    // Skip all instrumentation for excluded operational routes.
    if (isExcludedRoute(path)) {
      return next.handle();
    }

    const startTime = performance.now();
    const method = req.method ?? 'GET';

    // Register the `close` listener before returning next.handle() so it is
    // in place regardless of how quickly the response completes.
    res.once('close', () => {
      const durationSeconds = (performance.now() - startTime) / 1000;

      // Read the matched route pattern (e.g. "/order"), not the raw URL, to
      // avoid high cardinality from path params.  Falls back to "unmatched"
      // when no route was matched (e.g. 404).
      const route = (req as typeof req & { route?: { path?: string } }).route?.path
        ?? 'unmatched';

      // If the response was not fully written (client disconnected mid-flight),
      // record 499 to distinguish aborted requests from completed ones.
      const statusCode = res.writableFinished === false
        ? 499
        : res.statusCode;

      this.metricsService.recordRequest(method, route, statusCode, durationSeconds);
    });

    return next.handle();
  }
}
