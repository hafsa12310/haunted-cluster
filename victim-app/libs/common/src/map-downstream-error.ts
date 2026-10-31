import { HttpException, HttpStatus } from '@nestjs/common';
import type { AxiosError } from 'axios';

/**
 * The set of error codes that indicate a downstream timeout.
 * All three are treated as 504 Gateway Timeout.
 *
 * - ECONNABORTED: Axios aborts the request when the adapter-level timeout fires.
 * - ETIMEDOUT:    OS-level connection or socket timeout.
 * - ERR_CANCELED: Node.js AbortController cancellation (used by axios >= 1.x with signal).
 */
const TIMEOUT_CODES = new Set<string>(['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED']);

/**
 * Maps an AxiosError from a downstream HTTP call to a NestJS HttpException.
 *
 * Pure function — no side effects, no NestJS injection.
 * The caller is responsible for throwing the returned exception.
 *
 * Mapping rules:
 *   - error.code in { ECONNABORTED, ETIMEDOUT, ERR_CANCELED }
 *       → 504 { message: "<serviceName> timed out" }
 *   - everything else (ECONNREFUSED, ECONNRESET, ENOTFOUND, EAI_AGAIN,
 *     downstream 4xx, downstream 5xx, unknown / unexpected shapes)
 *       → 502 { message: "<serviceName> service unavailable" }
 *
 * Requirements: 1.4, 1.5, 1.6
 */
export function mapDownstreamError(
  error: AxiosError,
  serviceName: string,
): HttpException {
  const code = error.code ?? '';

  if (TIMEOUT_CODES.has(code)) {
    return new HttpException(
      { message: `${serviceName} timed out` },
      HttpStatus.GATEWAY_TIMEOUT, // 504
    );
  }

  return new HttpException(
    { message: `${serviceName} service unavailable` },
    HttpStatus.BAD_GATEWAY, // 502
  );
}
