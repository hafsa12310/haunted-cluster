import * as fc from 'fast-check';
import { AxiosError, AxiosHeaders } from 'axios';
import { HttpException, HttpStatus } from '@nestjs/common';
import { mapDownstreamError } from './map-downstream-error';

// Feature: victim-app, Property 10: mapDownstreamError maps error codes to correct HTTP status

/**
 * Helper: build a minimal AxiosError with only an error code (no response object).
 */
function makeCodeError(code: string): AxiosError {
  const err = new AxiosError('test error', code);
  err.code = code;
  return err;
}

/**
 * Helper: build an AxiosError that carries a downstream HTTP response with a given status.
 * The error code is left undefined (not a timeout/network code).
 */
function makeResponseError(status: number): AxiosError {
  const err = new AxiosError('downstream error');
  err.response = {
    status,
    statusText: String(status),
    data: {},
    headers: {} as AxiosHeaders,
    config: { headers: new AxiosHeaders() },
  };
  // Deliberately no error.code — this simulates a received HTTP response.
  return err;
}

describe('mapDownstreamError — property-based tests (Property 10)', () => {
  /**
   * Property 10a: Timeout error codes → 504 Gateway Timeout.
   *
   * For any of ECONNABORTED, ETIMEDOUT, ERR_CANCELED, the function SHALL
   * return an HttpException with status 504.
   *
   * Validates: Requirement 1.6
   */
  it('Property 10a — timeout codes (ECONNABORTED, ETIMEDOUT, ERR_CANCELED) always return 504', () => {
    // Feature: victim-app, Property 10: mapDownstreamError maps error codes to correct HTTP status
    fc.assert(
      fc.property(
        fc.constantFrom('ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED'),
        fc.string({ minLength: 1, maxLength: 50 }),
        (code, serviceName) => {
          const error = makeCodeError(code);
          const result = mapDownstreamError(error, serviceName);

          expect(result).toBeInstanceOf(HttpException);
          expect(result.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT); // 504
          const body = result.getResponse() as { message: string };
          expect(body.message).toBe(`${serviceName} timed out`);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 10b: No-response network error codes → 502 Bad Gateway.
   *
   * For any of ECONNREFUSED, ECONNRESET, ENOTFOUND, EAI_AGAIN, the function
   * SHALL return an HttpException with status 502.
   *
   * Validates: Requirement 1.4
   */
  it('Property 10b — no-response network codes (ECONNREFUSED, ECONNRESET, ENOTFOUND, EAI_AGAIN) always return 502', () => {
    // Feature: victim-app, Property 10: mapDownstreamError maps error codes to correct HTTP status
    fc.assert(
      fc.property(
        fc.constantFrom('ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'),
        fc.string({ minLength: 1, maxLength: 50 }),
        (code, serviceName) => {
          const error = makeCodeError(code);
          const result = mapDownstreamError(error, serviceName);

          expect(result).toBeInstanceOf(HttpException);
          expect(result.getStatus()).toBe(HttpStatus.BAD_GATEWAY); // 502
          const body = result.getResponse() as { message: string };
          expect(body.message).toBe(`${serviceName} service unavailable`);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 10c: Downstream 4xx responses → 502 Bad Gateway.
   *
   * When the downstream service replied with any 4xx HTTP status, the function
   * SHALL return an HttpException with status 502.
   *
   * Validates: Requirement 1.4
   */
  it('Property 10c — downstream 4xx responses always return 502', () => {
    // Feature: victim-app, Property 10: mapDownstreamError maps error codes to correct HTTP status
    fc.assert(
      fc.property(
        fc.integer({ min: 400, max: 499 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        (status, serviceName) => {
          const error = makeResponseError(status);
          const result = mapDownstreamError(error, serviceName);

          expect(result).toBeInstanceOf(HttpException);
          expect(result.getStatus()).toBe(HttpStatus.BAD_GATEWAY); // 502
          const body = result.getResponse() as { message: string };
          expect(body.message).toBe(`${serviceName} service unavailable`);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 10d: Downstream 5xx responses → 502 Bad Gateway.
   *
   * When the downstream service replied with any 5xx HTTP status, the function
   * SHALL return an HttpException with status 502.
   *
   * Validates: Requirement 1.5
   */
  it('Property 10d — downstream 5xx responses always return 502', () => {
    // Feature: victim-app, Property 10: mapDownstreamError maps error codes to correct HTTP status
    fc.assert(
      fc.property(
        fc.integer({ min: 500, max: 599 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        (status, serviceName) => {
          const error = makeResponseError(status);
          const result = mapDownstreamError(error, serviceName);

          expect(result).toBeInstanceOf(HttpException);
          expect(result.getStatus()).toBe(HttpStatus.BAD_GATEWAY); // 502
          const body = result.getResponse() as { message: string };
          expect(body.message).toBe(`${serviceName} service unavailable`);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 10e: Unknown / arbitrary error codes → 502 Bad Gateway.
   *
   * For any error code that is NOT one of the three timeout codes, the function
   * SHALL return an HttpException with status 502. This covers any future or
   * unexpected AxiosError codes.
   *
   * Validates: Requirements 1.4, 1.5
   */
  it('Property 10e — arbitrary non-timeout error codes always return 502', () => {
    // Feature: victim-app, Property 10: mapDownstreamError maps error codes to correct HTTP status
    const timeoutCodes = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED']);

    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 30 })
          .filter((code) => !timeoutCodes.has(code)),
        fc.string({ minLength: 1, maxLength: 50 }),
        (code, serviceName) => {
          const error = makeCodeError(code);
          const result = mapDownstreamError(error, serviceName);

          expect(result).toBeInstanceOf(HttpException);
          expect(result.getStatus()).toBe(HttpStatus.BAD_GATEWAY); // 502
          const body = result.getResponse() as { message: string };
          expect(body.message).toBe(`${serviceName} service unavailable`);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 10f: Errors with no error.code (undefined) → 502 Bad Gateway.
   *
   * An AxiosError without any code set (plain network error with no code) SHALL
   * return HttpException 502, never 504.
   *
   * Validates: Requirements 1.4, 1.5
   */
  it('Property 10f — errors with undefined code always return 502', () => {
    // Feature: victim-app, Property 10: mapDownstreamError maps error codes to correct HTTP status
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        (serviceName) => {
          const error = new AxiosError('no code error');
          // error.code is deliberately left undefined
          const result = mapDownstreamError(error, serviceName);

          expect(result).toBeInstanceOf(HttpException);
          expect(result.getStatus()).toBe(HttpStatus.BAD_GATEWAY); // 502
        },
      ),
      { numRuns: 100 },
    );
  });
});
