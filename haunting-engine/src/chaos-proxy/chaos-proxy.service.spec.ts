import { HttpException } from '@nestjs/common';
import type { ChaosEvent } from '@haunted-cluster/shared';
import { loadEngineConfig } from '../config/engine-config';
import { ChaosLogService } from './chaos-log.service';
import { ChaosProxyService } from './chaos-proxy.service';

const CONFIG = loadEngineConfig({
  PROMETHEUS_URL: 'http://prometheus:9090',
  GATEWAY_URL: 'http://gateway:3000',
  ORDERS_URL: 'http://orders:3001/',
  PAYMENTS_URL: 'http://payments:3002',
  CHAOS_PROXY_TIMEOUT_MS: '50',
});

const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** What Node's fetch rejects with when nothing is listening. */
function connectionRefused(): TypeError {
  const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

/** A fetch that never answers and rejects when its signal aborts, as real fetch does. */
function hangingFetch(_url: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  });
}

describe('ChaosProxyService', () => {
  let fetchMock: jest.SpyInstance<Promise<Response>, Parameters<typeof fetch>>;
  let chaosLog: ChaosLogService;
  let emitted: ChaosEvent[];
  let proxy: ChaosProxyService;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
    chaosLog = new ChaosLogService();
    emitted = [];
    proxy = new ChaosProxyService(
      CONFIG,
      { now: () => NOW },
      { emitChaos: (e) => emitted.push(e) },
      chaosLog,
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  /** Asserts no Chaos_Event was recorded or emitted. */
  function expectNoEvent(): void {
    expect(chaosLog.recent()).toEqual([]);
    expect(emitted).toEqual([]);
  }

  describe('forward — accepted commands (Requirements 7.1, 7.6)', () => {
    it('POSTs the body as JSON to the service /chaos/<action> endpoint', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ message: 'latency set', ms: 1500 }));

      await proxy.forward('payments', 'latency', { ms: 1500 });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://payments:3002/chaos/latency');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({ 'content-type': 'application/json' });
      expect(init?.body).toBe(JSON.stringify({ ms: 1500 }));
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('does not double the slash when the service URL ends with one', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ message: 'chaos reset' }));

      await proxy.forward('orders', 'reset');

      expect(fetchMock.mock.calls[0][0]).toBe('http://orders:3001/chaos/reset');
    });

    it('passes a 200 through and records and emits a Chaos_Event', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ message: 'error rate set', percentage: 40 }));

      const result = await proxy.forward('orders', 'error-rate', { percentage: 40 });

      expect(result).toEqual({ status: 200, body: { message: 'error rate set', percentage: 40 } });
      const [event] = chaosLog.recent();
      expect(event).toEqual<ChaosEvent>({
        id: expect.stringMatching(UUID_V4),
        service: 'orders',
        action: 'error-rate',
        params: { percentage: 40 },
        at: new Date(NOW).toISOString(),
      });
      expect(emitted).toEqual([event]);
    });

    it('passes the 202 from /crash through, sends no body, and records the event with empty params', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ message: 'crashing in 100ms' }, 202));

      const result = await proxy.forward('payments', 'crash');

      expect(result).toEqual({ status: 202, body: { message: 'crashing in 100ms' } });
      const init = fetchMock.mock.calls[0][1];
      expect(init?.body).toBeUndefined();
      expect(init?.headers).toBeUndefined();
      expect(chaosLog.recent()).toEqual([
        expect.objectContaining({ service: 'payments', action: 'crash', params: {} }),
      ]);
      expect(emitted).toHaveLength(1);
    });

    it('gives each recorded event its own id', async () => {
      fetchMock.mockImplementation(async () => jsonResponse({ message: 'ok' }));

      await proxy.forward('orders', 'reset');
      await proxy.forward('orders', 'reset');

      const [second, first] = chaosLog.recent();
      expect(second.id).not.toBe(first.id);
    });
  });

  describe('forward — failures record nothing (Requirements 7.4, 7.6)', () => {
    it('passes a 4xx through unchanged', async () => {
      const body = { statusCode: 400, message: ['ms must be an integer number'], error: 'Bad Request' };
      fetchMock.mockResolvedValue(jsonResponse(body, 400));

      const result = await proxy.forward('orders', 'latency', { ms: 1.5 });

      expect(result).toEqual({ status: 400, body });
      expectNoEvent();
    });

    it.each([500, 503])('maps a %i to 502 "<service> chaos endpoint failed"', async (status) => {
      fetchMock.mockResolvedValue(jsonResponse({ message: 'boom' }, status));

      const result = await proxy.forward('orders', 'memory-leak', { enabled: true });

      expect(result).toEqual({ status: 502, body: { message: 'orders chaos endpoint failed' } });
      expectNoEvent();
    });

    it('maps a network error to 502 "<service> service unavailable"', async () => {
      fetchMock.mockRejectedValue(connectionRefused());

      const result = await proxy.forward('payments', 'latency', { ms: 100 });

      expect(result).toEqual({ status: 502, body: { message: 'payments service unavailable' } });
      expectNoEvent();
    });

    it('maps a timeout to 504 "<service> timed out" after chaosProxyTimeoutMs', async () => {
      fetchMock.mockImplementation(hangingFetch);

      const started = Date.now();
      const result = await proxy.forward('gateway', 'latency', { ms: 100 });

      expect(Date.now() - started).toBeLessThan(1000);
      expect(result).toEqual({ status: 504, body: { message: 'gateway timed out' } });
      expectNoEvent();
    });

    it('maps an AbortError to 504 as well', async () => {
      fetchMock.mockRejectedValue(
        Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
      );

      const result = await proxy.forward('gateway', 'reset');

      expect(result).toEqual({ status: 504, body: { message: 'gateway timed out' } });
      expectNoEvent();
    });
  });

  describe('state (Requirements 7.1, 7.4)', () => {
    it('GETs /chaos/state and returns the body without recording anything', async () => {
      const state = { latencyMs: 0, errorRate: 0, memoryLeak: false };
      fetchMock.mockResolvedValue(jsonResponse(state));

      expect(await proxy.state('orders')).toEqual(state);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://orders:3001/chaos/state');
      expect(init?.method).toBe('GET');
      expectNoEvent();
    });

    it('throws an HttpException with the mapped status and message on failure', async () => {
      fetchMock.mockRejectedValue(connectionRefused());

      const error = await proxy.state('payments').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(502);
      expect((error as HttpException).getResponse()).toEqual({ message: 'payments service unavailable' });
    });

    it('turns a text error body into a message', async () => {
      fetchMock.mockResolvedValue(new Response('Not Found', { status: 404 }));

      const error = (await proxy.state('orders').catch((e: unknown) => e)) as HttpException;

      expect(error.getStatus()).toBe(404);
      expect(error.getResponse()).toEqual({ message: 'Not Found' });
    });
  });

  describe('resetAll (Requirements 7.5, 7.6)', () => {
    it('resets every service in the chain and records one event per success', async () => {
      fetchMock.mockImplementation(async () => jsonResponse({ message: 'chaos reset' }));

      const result = await proxy.resetAll();

      expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual([
        'http://gateway:3000/chaos/reset',
        'http://orders:3001/chaos/reset',
        'http://payments:3002/chaos/reset',
      ]);
      expect(result).toEqual({
        results: [
          { service: 'gateway', ok: true, status: 200 },
          { service: 'orders', ok: true, status: 200 },
          { service: 'payments', ok: true, status: 200 },
        ],
      });
      expect(chaosLog.recent().map((e) => [e.service, e.action]).sort()).toEqual([
        ['gateway', 'reset'],
        ['orders', 'reset'],
        ['payments', 'reset'],
      ]);
      expect(emitted).toHaveLength(3);
    });

    it('reports each failure per service without failing the others', async () => {
      fetchMock.mockImplementation(async (url) => {
        const target = String(url);
        if (target.startsWith('http://orders')) throw connectionRefused();
        if (target.startsWith('http://payments')) return jsonResponse({ message: 'boom' }, 500);
        return jsonResponse({ message: 'chaos reset' });
      });

      const result = await proxy.resetAll();

      expect(result).toEqual({
        results: [
          { service: 'gateway', ok: true, status: 200 },
          { service: 'orders', ok: false, status: 502, message: 'orders service unavailable' },
          { service: 'payments', ok: false, status: 502, message: 'payments chaos endpoint failed' },
        ],
      });
      // Only the successful reset is recorded.
      expect(chaosLog.recent()).toEqual([expect.objectContaining({ service: 'gateway', action: 'reset' })]);
      expect(emitted).toHaveLength(1);
    });

    it('reports a timeout as a 504 for that service', async () => {
      fetchMock.mockImplementation((url, init) =>
        String(url).startsWith('http://gateway')
          ? hangingFetch(url, init)
          : Promise.resolve(jsonResponse({ message: 'chaos reset' })),
      );

      const { results } = await proxy.resetAll();

      expect(results[0]).toEqual({ service: 'gateway', ok: false, status: 504, message: 'gateway timed out' });
      expect(results.slice(1).every((r) => r.ok)).toBe(true);
    });

    it('still resolves when every service is down', async () => {
      fetchMock.mockRejectedValue(connectionRefused());

      const { results } = await proxy.resetAll();

      expect(results.map((r) => [r.service, r.ok, r.status])).toEqual([
        ['gateway', false, 502],
        ['orders', false, 502],
        ['payments', false, 502],
      ]);
      expectNoEvent();
    });
  });
});
