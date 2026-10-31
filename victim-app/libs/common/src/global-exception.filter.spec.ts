import { ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';

// Feature: victim-app — GlobalExceptionFilter unit tests
// Requirements: 1.4, 1.5, 1.6

/**
 * Builds a minimal mock `ArgumentsHost` that captures the status code and
 * JSON body written by the filter.
 */
function makeHost(): {
  host: ArgumentsHost;
  getStatus: () => number | undefined;
  getJson: () => unknown;
} {
  let capturedStatus: number | undefined;
  let capturedJson: unknown;

  const res = {
    status: jest.fn().mockImplementation((code: number) => {
      capturedStatus = code;
      return res;
    }),
    json: jest.fn().mockImplementation((body: unknown) => {
      capturedJson = body;
      return res;
    }),
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
    }),
  } as unknown as ArgumentsHost;

  return {
    host,
    getStatus: () => capturedStatus,
    getJson: () => capturedJson,
  };
}

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    // Silence logger output during tests
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // HttpException pass-through (Requirements 1.4, 1.5, 1.6)
  // -------------------------------------------------------------------------

  describe('HttpException pass-through', () => {
    it('passes through a 400 Bad Request with its original body', () => {
      const { host, getStatus, getJson } = makeHost();
      const exception = new HttpException({ message: 'bad input' }, HttpStatus.BAD_REQUEST);

      filter.catch(exception, host);

      expect(getStatus()).toBe(400);
      expect(getJson()).toEqual({ message: 'bad input' });
    });

    it('passes through a 404 Not Found with its original body', () => {
      const { host, getStatus, getJson } = makeHost();
      const exception = new HttpException({ message: 'not found' }, HttpStatus.NOT_FOUND);

      filter.catch(exception, host);

      expect(getStatus()).toBe(404);
      expect(getJson()).toEqual({ message: 'not found' });
    });

    it('passes through a 401 Unauthorized with its original body', () => {
      const { host, getStatus, getJson } = makeHost();
      const exception = new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);

      filter.catch(exception, host);

      expect(getStatus()).toBe(401);
      expect(getJson()).toBe('Unauthorized');
    });

    it('passes through a 502 Bad Gateway created by mapDownstreamError (Requirement 1.4)', () => {
      const { host, getStatus, getJson } = makeHost();
      const exception = new HttpException(
        { message: 'payments service unavailable' },
        HttpStatus.BAD_GATEWAY,
      );

      filter.catch(exception, host);

      expect(getStatus()).toBe(502);
      expect(getJson()).toEqual({ message: 'payments service unavailable' });
    });

    it('passes through a 504 Gateway Timeout created by mapDownstreamError (Requirement 1.6)', () => {
      const { host, getStatus, getJson } = makeHost();
      const exception = new HttpException(
        { message: 'orders timed out' },
        HttpStatus.GATEWAY_TIMEOUT,
      );

      filter.catch(exception, host);

      expect(getStatus()).toBe(504);
      expect(getJson()).toEqual({ message: 'orders timed out' });
    });

    it('preserves an object body with multiple fields intact', () => {
      const { host, getStatus, getJson } = makeHost();
      const body = { message: 'validation failed', fields: ['email', 'name'] };
      const exception = new HttpException(body, HttpStatus.UNPROCESSABLE_ENTITY);

      filter.catch(exception, host);

      expect(getStatus()).toBe(422);
      expect(getJson()).toEqual(body);
    });

    it('does NOT call logger.error for HttpException', () => {
      const { host } = makeHost();
      const logSpy = jest.spyOn(Logger.prototype, 'error');
      const exception = new HttpException('conflict', HttpStatus.CONFLICT);

      filter.catch(exception, host);

      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Unknown / non-HttpException errors → 500 (Requirements 1.4, 1.5)
  // -------------------------------------------------------------------------

  describe('unknown error → 500 internal server error', () => {
    it('returns 500 with { message: "internal server error" } for a plain Error', () => {
      const { host, getStatus, getJson } = makeHost();

      filter.catch(new Error('something went wrong'), host);

      expect(getStatus()).toBe(500);
      expect(getJson()).toEqual({ message: 'internal server error' });
    });

    it('returns 500 for a thrown string', () => {
      const { host, getStatus, getJson } = makeHost();

      filter.catch('oops', host);

      expect(getStatus()).toBe(500);
      expect(getJson()).toEqual({ message: 'internal server error' });
    });

    it('returns 500 for a thrown object', () => {
      const { host, getStatus, getJson } = makeHost();

      filter.catch({ code: 'UNKNOWN' }, host);

      expect(getStatus()).toBe(500);
      expect(getJson()).toEqual({ message: 'internal server error' });
    });

    it('returns 500 for null', () => {
      const { host, getStatus, getJson } = makeHost();

      filter.catch(null, host);

      expect(getStatus()).toBe(500);
      expect(getJson()).toEqual({ message: 'internal server error' });
    });

    it('returns 500 for undefined', () => {
      const { host, getStatus, getJson } = makeHost();

      filter.catch(undefined, host);

      expect(getStatus()).toBe(500);
      expect(getJson()).toEqual({ message: 'internal server error' });
    });

    it('calls logger.error once for an unknown error', () => {
      const { host } = makeHost();
      const logSpy = jest.spyOn(Logger.prototype, 'error');
      const err = new Error('database exploded');

      filter.catch(err, host);

      expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it('logs the error stack when given an Error instance', () => {
      const { host } = makeHost();
      const logSpy = jest.spyOn(Logger.prototype, 'error');
      const err = new Error('disk full');

      filter.catch(err, host);

      // Second arg to logger.error should be the stack trace string
      expect(logSpy).toHaveBeenCalledWith('Unhandled exception', err.stack);
    });

    it('logs String(exception) when the thrown value is not an Error', () => {
      const { host } = makeHost();
      const logSpy = jest.spyOn(Logger.prototype, 'error');

      filter.catch('raw string error', host);

      expect(logSpy).toHaveBeenCalledWith('Unhandled exception', 'raw string error');
    });

    it('does NOT leak stack traces in the HTTP response body', () => {
      const { host, getJson } = makeHost();
      const err = new Error('secret internal detail');

      filter.catch(err, host);

      const body = getJson() as Record<string, unknown>;
      expect(body).not.toHaveProperty('stack');
      expect(JSON.stringify(body)).not.toContain('secret internal detail');
    });
  });
});
