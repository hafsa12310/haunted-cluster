/**
 * Thin client for the Prometheus instant-query API.
 *
 * Anything that makes a whole query unusable (network failure, timeout,
 * non-2xx, error or non-vector body) throws `MetricsUnavailableError`, which
 * fails the whole Poll. A bad individual sample only becomes `null`.
 *
 * Requirements: 2.2, 2.6, 2.8, 11.1
 */

import { Inject, Injectable } from '@nestjs/common';
import { ENGINE_CONFIG } from '../config/config.module';
import type { EngineConfig } from '../config/engine-config';

/** Label value → sample; null for NaN, ±Inf or an unparseable value. */
export type Vector = Map<string, number | null>;

export type LabelKey = 'service' | 'job';

/** A query could not be answered at all; `cause` holds the underlying error, if any. */
export class MetricsUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MetricsUnavailableError';
  }
}

@Injectable()
export class PrometheusClient {
  private readonly endpoint: string;

  constructor(@Inject(ENGINE_CONFIG) private readonly config: EngineConfig) {
    this.endpoint = `${config.prometheusUrl.replace(/\/+$/, '')}/api/v1/query`;
  }

  /** Requirements: 2.2, 2.8, 11.1 */
  async query(promql: string, labelKey: LabelKey): Promise<Vector> {
    const url = `${this.endpoint}?query=${encodeURIComponent(promql)}`;
    const timeoutMs = this.config.prometheusTimeoutMs;

    let response: Response;
    let body: unknown;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      body = await response.json().catch(() => undefined);
    } catch (error) {
      // AbortSignal.timeout rejects with a DOMException named TimeoutError. Checked
      // by name: fetch's errors can come from another realm, failing instanceof.
      if (isRecord(error) && error.name === 'TimeoutError') {
        throw new MetricsUnavailableError(
          `Prometheus query timed out after ${timeoutMs}ms: ${promql}`,
          error,
        );
      }
      throw new MetricsUnavailableError(
        `Prometheus unreachable at ${this.config.prometheusUrl}: ${describe(error)}`,
        error,
      );
    }

    if (!response.ok) {
      const detail = errorText(body);
      throw new MetricsUnavailableError(
        `Prometheus returned HTTP ${response.status}${detail ? `: ${detail}` : ''} for: ${promql}`,
      );
    }
    return parseVector(body, labelKey);
  }
}

/**
 * Parses an instant-query response body into a Vector keyed by `labelKey`.
 * Throws `MetricsUnavailableError` only when the body as a whole is unusable;
 * a bad sample value becomes `null`, and a series without the label is skipped.
 * Requirements: 2.6, 11.1
 */
export function parseVector(body: unknown, labelKey: string): Vector {
  if (!isRecord(body) || body.status !== 'success') {
    const detail = errorText(body);
    throw new MetricsUnavailableError(
      `Prometheus query failed${detail ? `: ${detail}` : ': unexpected response body'}`,
    );
  }
  const data = body.data;
  if (!isRecord(data) || data.resultType !== 'vector' || !Array.isArray(data.result)) {
    throw new MetricsUnavailableError('Prometheus response is not an instant vector');
  }

  const vector: Vector = new Map();
  for (const series of data.result) {
    if (!isRecord(series) || !isRecord(series.metric)) continue;
    const label = series.metric[labelKey];
    if (typeof label !== 'string') continue;
    vector.set(label, parseSample(series.value));
  }
  return vector;
}

/**
 * A decimal number, optionally signed and with an exponent: the only numeric
 * form Prometheus writes. Checked first because Number() also accepts "",
 * whitespace and hex/binary/octal ("0x10" → 16), which would turn garbage into data.
 */
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** `[<timestamp>, "<value>"]` → a finite number, or null. */
function parseSample(value: unknown): number | null {
  if (!Array.isArray(value) || typeof value[1] !== 'string') return null;
  if (!DECIMAL.test(value[1])) return null;
  const n = Number(value[1]);
  // Very large exponents ("1e999") overflow to Infinity.
  return Number.isFinite(n) ? n : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Prometheus error bodies look like `{ status: "error", errorType, error }`. */
function errorText(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const parts = [body.errorType, body.error].filter((p): p is string => typeof p === 'string');
  return parts.length > 0 ? parts.join(': ') : undefined;
}

/** fetch hides the real reason (e.g. ECONNREFUSED) on `error.cause`. */
function describe(error: unknown): string {
  if (!isRecord(error) || typeof error.message !== 'string') return String(error);
  const cause = error.cause;
  if (!isRecord(cause)) return error.message;
  const reason = typeof cause.code === 'string' ? cause.code : cause.message;
  return typeof reason === 'string' ? `${error.message} (${reason})` : error.message;
}
