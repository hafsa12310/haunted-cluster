import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

/**
 * Global exception filter registered via `APP_FILTER` in `CommonModule`.
 *
 * - `HttpException` instances pass through unchanged, preserving status code
 *   and response body set by the throwing code or NestJS built-ins.
 * - All other errors (truly unknown / unexpected) are logged and returned as
 *   HTTP 500 `{ "message": "internal server error" }` so nothing leaks stack
 *   traces to the caller and no exception is swallowed silently.
 *
 * This is the stub created in task 2.7. Task 2.8 will flesh out the full
 * implementation and add comprehensive logging.
 *
 * Requirements: 1.4, 1.5, 1.6
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = ctx.getResponse<any>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json(body);
      return;
    }

    // Unknown / unexpected error — log and return 500.
    this.logger.error(
      'Unhandled exception',
      exception instanceof Error ? exception.stack : String(exception),
    );
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ message: 'internal server error' });
  }
}
