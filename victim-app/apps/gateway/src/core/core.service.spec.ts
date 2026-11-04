/**
 * Unit tests for CoreService
 *
 * Covers: happy-path forwarding, ECONNREFUSED → 502, downstream 5xx → 502,
 * and timeout codes (ETIMEDOUT / ECONNABORTED / ERR_CANCELED) → 504.
 *
 * Requirements: 1.1, 1.4, 1.5, 1.6
 */

import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { HttpException, HttpStatus } from '@nestjs/common';
import { AxiosError, AxiosHeaders, AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import { CoreService } from './core.service';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal successful AxiosResponse wrapping arbitrary data. */
function makeAxiosResponse<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
}

/**
 * Build an AxiosError that has only an error code (no HTTP response object).
 * Used to simulate connection-level failures (ECONNREFUSED, ETIMEDOUT, etc.).
 */
function makeCodeError(code: string): AxiosError {
  const err = new AxiosError('test error', code);
  err.code = code;
  return err;
}

/**
 * Build an AxiosError that carries a downstream HTTP response with the given
 * status code. The error.code is intentionally left undefined, matching the
 * real shape Axios produces when a server returns a 4xx / 5xx.
 */
function makeResponseError(status: number): AxiosError {
  const err = new AxiosError('downstream error');
  err.response = {
    status,
    statusText: String(status),
    data: { message: 'error' },
    headers: {} as AxiosHeaders,
    config: { headers: new AxiosHeaders() },
  };
  return err;
}

// ── Test suite ─────────────────────────────────────────────────────────────

describe('CoreService unit tests', () => {
  let service: CoreService;
  let httpService: jest.Mocked<HttpService>;

  beforeEach(async () => {
    // Provide a minimal mock for HttpService.
    const mockHttpService = {
      post: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoreService,
        { provide: HttpService, useValue: mockHttpService },
      ],
    }).compile();

    service = module.get<CoreService>(CoreService);
    httpService = module.get(HttpService);

    // Set the env var that CoreService reads when building the request URL.
    process.env['ORDERS_URL'] = 'http://orders:3001';
  });

  afterEach(() => {
    delete process.env['ORDERS_URL'];
    jest.clearAllMocks();
  });

  // ── 1. Happy path ──────────────────────────────────────────────────────────

  describe('processOrder() — success path', () => {
    it('resolves with the response body when HttpService returns 200 (Requirements: 1.1)', async () => {
      const payload = { itemId: 'abc', quantity: 2 };
      const responseData = { orderId: '123', status: 'created' };

      httpService.post.mockReturnValue(of(makeAxiosResponse(responseData)));

      const result = await service.processOrder(payload);

      expect(result).toEqual(responseData);
      expect(httpService.post).toHaveBeenCalledWith(
        'http://orders:3001/order',
        payload,
      );
    });

    it('passes the request body unchanged to the downstream URL (Requirements: 1.1)', async () => {
      const body = { foo: 'bar', nested: { val: 1 } };

      httpService.post.mockReturnValue(of(makeAxiosResponse({ ok: true })));

      await service.processOrder(body);

      expect(httpService.post).toHaveBeenCalledTimes(1);
      const [calledUrl, calledBody] = httpService.post.mock.calls[0] as [
        string,
        unknown,
      ];
      expect(calledUrl).toBe('http://orders:3001/order');
      expect(calledBody).toBe(body);
    });
  });

  // ── 2. Connection refused → 502 ───────────────────────────────────────────

  describe('processOrder() — ECONNREFUSED → 502', () => {
    it('throws HttpException 502 when orders service is unreachable (Requirements: 1.4)', async () => {
      httpService.post.mockReturnValue(
        throwError(() => makeCodeError('ECONNREFUSED')),
      );

      await expect(service.processOrder({})).rejects.toMatchObject({
        status: HttpStatus.BAD_GATEWAY,
      });
    });

    it('includes "service unavailable" in the error body for ECONNREFUSED (Requirements: 1.4)', async () => {
      httpService.post.mockReturnValue(
        throwError(() => makeCodeError('ECONNREFUSED')),
      );

      let thrown: unknown;
      try {
        await service.processOrder({});
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(HttpException);
      const body = (thrown as HttpException).getResponse() as {
        message: string;
      };
      expect(body.message).toBe('orders service unavailable');
    });
  });

  // ── 3. Downstream 5xx response → 502 ─────────────────────────────────────

  describe('processOrder() — downstream 5xx → 502', () => {
    it('throws HttpException 502 when orders returns 500 (Requirements: 1.5)', async () => {
      httpService.post.mockReturnValue(
        throwError(() => makeResponseError(500)),
      );

      await expect(service.processOrder({})).rejects.toMatchObject({
        status: HttpStatus.BAD_GATEWAY,
      });
    });

    it('throws HttpException 502 when orders returns 503 (Requirements: 1.5)', async () => {
      httpService.post.mockReturnValue(
        throwError(() => makeResponseError(503)),
      );

      await expect(service.processOrder({})).rejects.toMatchObject({
        status: HttpStatus.BAD_GATEWAY,
      });
    });

    it('includes "service unavailable" in the error body for a 5xx response (Requirements: 1.5)', async () => {
      httpService.post.mockReturnValue(
        throwError(() => makeResponseError(502)),
      );

      let thrown: unknown;
      try {
        await service.processOrder({});
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(HttpException);
      const body = (thrown as HttpException).getResponse() as {
        message: string;
      };
      expect(body.message).toBe('orders service unavailable');
    });
  });

  // ── 4. Timeout errors → 504 ───────────────────────────────────────────────

  describe('processOrder() — timeout codes → 504', () => {
    it.each([
      ['ETIMEDOUT'],
      ['ECONNABORTED'],
      ['ERR_CANCELED'],
    ])(
      'throws HttpException 504 for %s (Requirements: 1.6)',
      async (code: string) => {
        httpService.post.mockReturnValue(
          throwError(() => makeCodeError(code)),
        );

        await expect(service.processOrder({})).rejects.toMatchObject({
          status: HttpStatus.GATEWAY_TIMEOUT,
        });
      },
    );

    it('includes "timed out" in the error body for a timeout error (Requirements: 1.6)', async () => {
      httpService.post.mockReturnValue(
        throwError(() => makeCodeError('ETIMEDOUT')),
      );

      let thrown: unknown;
      try {
        await service.processOrder({});
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(HttpException);
      const body = (thrown as HttpException).getResponse() as {
        message: string;
      };
      expect(body.message).toBe('orders timed out');
    });
  });

  // ── 5. Non-Axios errors are re-thrown as-is ───────────────────────────────

  describe('processOrder() — non-Axios error passthrough', () => {
    it('rethrows non-Axios errors without wrapping them (Requirements: 1.1)', async () => {
      const unexpected = new Error('unexpected failure');

      httpService.post.mockReturnValue(throwError(() => unexpected));

      await expect(service.processOrder({})).rejects.toThrow(
        'unexpected failure',
      );
    });
  });
});
