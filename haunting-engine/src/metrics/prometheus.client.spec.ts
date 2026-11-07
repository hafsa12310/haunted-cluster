import { EngineConfig, loadEngineConfig } from '../config/engine-config';
import { MetricsUnavailableError, PrometheusClient } from './prometheus.client';

function config(overrides: NodeJS.ProcessEnv = {}): EngineConfig {
  return loadEngineConfig({
    PROMETHEUS_URL: 'http://prometheus:9090',
    GATEWAY_URL: 'http://gateway:3000',
    ORDERS_URL: 'http://orders:3001',
    PAYMENTS_URL: 'http://payments:3002',
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const VECTOR_BODY = {
  status: 'success',
  data: {
    resultType: 'vector',
    result: [
      { metric: { service: 'orders' }, value: [1_700_000_000, '2.5'] },
      { metric: { service: 'payments' }, value: [1_700_000_000, 'NaN'] },
    ],
  },
};

/**
 * The error Node's fetch rejects with on a network failure. Built with
 * Object.assign because the ES2021 lib has no `{ cause }` Error option.
 */
function fetchFailed(cause: Error): TypeError {
  return Object.assign(new TypeError('fetch failed'), { cause });
}

/** Runs `promise`, asserts it rejects with a MetricsUnavailableError, and returns it. */
async function unavailable(promise: Promise<unknown>): Promise<MetricsUnavailableError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MetricsUnavailableError);
    return error as MetricsUnavailableError;
  }
  throw new Error('expected a MetricsUnavailableError, but the query resolved');
}

describe('PrometheusClient', () => {
  let fetchMock: jest.SpyInstance<Promise<Response>, Parameters<typeof fetch>>;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  describe('successful queries (Requirement 2.2)', () => {
    it('GETs /api/v1/query with the encoded PromQL and parses the vector', async () => {
      fetchMock.mockResolvedValue(jsonResponse(VECTOR_BODY));
      const promql = 'up{job=~"gateway|orders"}';

      const vector = await new PrometheusClient(config()).query(promql, 'service');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe(`http://prometheus:9090/api/v1/query?query=${encodeURIComponent(promql)}`);
      expect(new URL(String(url)).searchParams.get('query')).toBe(promql);
      expect(vector).toEqual(
        new Map([
          ['orders', 2.5],
          ['payments', null],
        ]),
      );
    });

    it('does not double the slash when PROMETHEUS_URL ends with one', async () => {
      fetchMock.mockResolvedValue(jsonResponse(VECTOR_BODY));

      await new PrometheusClient(config({ PROMETHEUS_URL: 'http://prometheus:9090/' })).query('up', 'job');

      expect(String(fetchMock.mock.calls[0][0])).toBe('http://prometheus:9090/api/v1/query?query=up');
    });

    it('keys the vector by the requested label', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          status: 'success',
          data: {
            resultType: 'vector',
            result: [{ metric: { job: 'gateway', service: 'ignored' }, value: [1, '1'] }],
          },
        }),
      );

      const vector = await new PrometheusClient(config()).query('up', 'job');

      expect(vector).toEqual(new Map([['gateway', 1]]));
    });

    it('passes an abort signal that fires after PROMETHEUS_TIMEOUT_MS (Requirement 2.8)', async () => {
      fetchMock.mockResolvedValue(jsonResponse(VECTOR_BODY));

      await new PrometheusClient(config({ PROMETHEUS_TIMEOUT_MS: '50' })).query('up', 'job');

      const signal = fetchMock.mock.calls[0][1]?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(signal?.aborted).toBe(true);
      expect((signal?.reason as Error).name).toBe('TimeoutError');
    });
  });

  describe('whole-query failures throw MetricsUnavailableError (Requirements 2.8, 11.1)', () => {
    it('non-2xx response, with the Prometheus error in the message', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ status: 'error', errorType: 'bad_data', error: 'parse error at char 4' }, 400),
      );

      const error = await unavailable(new PrometheusClient(config()).query('up{', 'job'));

      expect(error.message).toBe('Prometheus returned HTTP 400: bad_data: parse error at char 4 for: up{');
    });

    it('non-2xx response without a JSON body', async () => {
      fetchMock.mockResolvedValue(new Response('Service Unavailable', { status: 503 }));

      const error = await unavailable(new PrometheusClient(config()).query('up', 'job'));

      expect(error.message).toBe('Prometheus returned HTTP 503 for: up');
    });

    it('2xx response with status "error" in the body', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ status: 'error', errorType: 'timeout', error: 'query timed out in expression evaluation' }),
      );

      const error = await unavailable(new PrometheusClient(config()).query('up', 'job'));

      expect(error.message).toBe('Prometheus query failed: timeout: query timed out in expression evaluation');
    });

    it('2xx response that is not JSON', async () => {
      fetchMock.mockResolvedValue(new Response('<html>proxy error</html>', { status: 200 }));

      const error = await unavailable(new PrometheusClient(config()).query('up', 'job'));

      expect(error.message).toBe('Prometheus query failed: unexpected response body');
    });

    it('2xx response that is not an instant vector', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ status: 'success', data: { resultType: 'matrix', result: [] } }),
      );

      const error = await unavailable(new PrometheusClient(config()).query('up[1m]', 'job'));

      expect(error.message).toBe('Prometheus response is not an instant vector');
    });

    it('timeout, with the TimeoutError as cause', async () => {
      // Never answers; rejects only when the client's signal aborts, as real fetch does.
      fetchMock.mockImplementation(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      );

      const started = Date.now();
      const error = await unavailable(
        new PrometheusClient(config({ PROMETHEUS_TIMEOUT_MS: '50' })).query('up', 'job'),
      );

      expect(Date.now() - started).toBeLessThan(1000);
      expect(error.message).toBe('Prometheus query timed out after 50ms: up');
      expect((error.cause as Error).name).toBe('TimeoutError');
    });

    it('network error, with the system error code in the message and the fetch error as cause', async () => {
      const fetchError = fetchFailed(
        Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:9090'), { code: 'ECONNREFUSED' }),
      );
      fetchMock.mockRejectedValue(fetchError);

      const error = await unavailable(new PrometheusClient(config()).query('up', 'job'));

      expect(error.message).toBe(
        'Prometheus unreachable at http://prometheus:9090: fetch failed (ECONNREFUSED)',
      );
      expect(error.cause).toBe(fetchError);
    });

    it('network error without a code falls back to the cause message', async () => {
      fetchMock.mockRejectedValue(fetchFailed(new Error('bad port')));

      const error = await unavailable(new PrometheusClient(config()).query('up', 'job'));

      expect(error.message).toBe('Prometheus unreachable at http://prometheus:9090: fetch failed (bad port)');
    });

    it('is an Error named MetricsUnavailableError', async () => {
      fetchMock.mockResolvedValue(new Response('', { status: 500 }));

      const error = await unavailable(new PrometheusClient(config()).query('up', 'job'));

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('MetricsUnavailableError');
    });
  });
});
