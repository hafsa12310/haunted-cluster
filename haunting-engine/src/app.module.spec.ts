import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './app.module';
import { ChaosLogService } from './chaos-proxy/chaos-log.service';
import { CHAOS_NOTIFIER, ChaosProxyService } from './chaos-proxy/chaos-proxy.service';
import { loadEngineConfig } from './config/engine-config';
import { EngineStateService } from './engine/engine-state.service';
import { EventsGateway } from './engine/events.gateway';
import { PollerService } from './engine/poller.service';
import { IncidentsModule } from './incidents/incidents.module';
import { LabelKey, PrometheusClient, Vector } from './metrics/prometheus.client';

/**
 * Builds the real AppModule, as main.ts does, with only Prometheus and the
 * poller's timers replaced. Catches wiring mistakes (a provider not exported,
 * a missing global token, a circular import) that per-class tests can't see.
 *
 * Requirements: 9.1
 */

const CONFIG = loadEngineConfig({
  PROMETHEUS_URL: 'http://prometheus:9090',
  GATEWAY_URL: 'http://gateway:3000',
  ORDERS_URL: 'http://orders:3001',
  PAYMENTS_URL: 'http://payments:3002',
});

/** A healthy cluster: every query answers for every service in the chain. */
async function fakeQuery(promql: string, _labelKey: LabelKey): Promise<Vector> {
  const value = promql.startsWith('up{')
    ? 1
    : promql.includes('process_rss_bytes')
      ? 50 * 1_048_576
      : promql.includes('http_request_duration_seconds_bucket')
        ? 0.05
        : promql.includes('http_errors_total')
          ? 0
          : 10;
  return new Map(CONFIG.serviceChain.map((s) => [s, value]));
}

/** Requirements: 13.1 */
describe('AppModule boot with the intelligence layer', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(CONFIG)] })
      .overrideProvider(PrometheusClient)
      .useValue({ query: jest.fn(fakeQuery) })
      .compile();
    app = moduleRef.createNestApplication();
    // Fake timers only while starting, so the first Poll runs once and later timers never fire.
    jest.useFakeTimers();
    try {
      await expect(app.init()).resolves.toBeDefined();
      await jest.advanceTimersByTimeAsync(0);
    } finally {
      jest.useRealTimers();
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('stores a first snapshot with empty anomalies and forecasts', () => {
    const snapshot = moduleRef.get(EngineStateService).latestSnapshot;
    expect(snapshot).toBeDefined();
    expect(snapshot?.anomalies).toEqual([]);
    expect(snapshot?.forecasts).toEqual([]);
  });
});

describe('AppModule', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let query: jest.Mock<Promise<Vector>, [string, LabelKey]>;

  beforeEach(async () => {
    query = jest.fn(fakeQuery);
    moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(CONFIG)] })
      .overrideProvider(PrometheusClient)
      .useValue({ query })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));

    // Fake timers only while starting: init schedules the first Poll, which we run
    // by hand. Timers the poller schedules after that stay fake and never fire.
    jest.useFakeTimers();
    // On 127.0.0.1, where supertest connects. Left to supertest, the server binds
    // ::, and on macOS another app's 127.0.0.1 listener on the same port gets the request.
    await app.listen(0, '127.0.0.1');
    await jest.advanceTimersByTimeAsync(0);
    jest.useRealTimers();
  });

  afterEach(async () => {
    await app.close();
  });

  it('compiles, initialises and runs a first Poll through the real pipeline', () => {
    // Five queries per Poll, from the real MetricsCollectorService.
    expect(query).toHaveBeenCalledTimes(5);
    const snapshot = moduleRef.get(EngineStateService).latestSnapshot;
    expect(snapshot?.metricsAvailable).toBe(true);
    expect(snapshot?.services.map((h) => [h.service, h.status])).toEqual([
      ['gateway', 'healthy'],
      ['orders', 'healthy'],
      ['payments', 'healthy'],
    ]);
  });

  it('serves every read route', async () => {
    const server = app.getHttpServer();

    const health = await request(server).get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok', service: 'haunting-engine' });

    const snapshot = await request(server).get('/api/snapshot');
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.metricsAvailable).toBe(true);

    const incidents = await request(server).get('/api/incidents');
    expect(incidents.status).toBe(200);
    expect(incidents.body).toEqual({ open: [], resolved: [] });
  });

  it('serves the chaos proxy routes, with KnownServicePipe and the DTOs applied', async () => {
    const server = app.getHttpServer();

    const unknown = await request(server).post('/api/chaos/billing/crash');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ message: 'unknown service: billing' });

    const invalid = await request(server).post('/api/chaos/orders/latency').send({ ms: -1 });
    expect(invalid.status).toBe(400);
  });

  it('provides CHAOS_NOTIFIER as the EventsGateway, so accepted chaos reaches Socket.IO', async () => {
    const gateway = moduleRef.get(EventsGateway);
    expect(moduleRef.get(CHAOS_NOTIFIER)).toBe(gateway);

    const emitChaos = jest.spyOn(gateway, 'emitChaos').mockImplementation(() => undefined);
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ message: 'latency set', ms: 100 })));
    try {
      const res = await request(app.getHttpServer()).post('/api/chaos/orders/latency').send({ ms: 100 });

      expect(res.status).toBe(200);
      expect(emitChaos).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'orders', action: 'latency', params: { ms: 100 } }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('shares one instance of each stateful service between modules', () => {
    // The poller writes EngineStateService; IncidentsController reads it from IncidentsModule.
    const state = moduleRef.get(EngineStateService);
    expect(moduleRef.select(IncidentsModule).get(EngineStateService, { strict: false })).toBe(state);

    // The proxy records to ChaosLogService; the poller reads it for chaos evidence.
    const chaosLog = moduleRef.get(ChaosLogService);
    const proxy = moduleRef.get(ChaosProxyService);
    expect((proxy as unknown as { chaosLog: ChaosLogService }).chaosLog).toBe(chaosLog);
    expect((moduleRef.get(PollerService) as unknown as { chaosLog: ChaosLogService }).chaosLog).toBe(
      chaosLog,
    );
  });

  it('stops polling when the app closes', async () => {
    jest.useFakeTimers();
    try {
      const calls = query.mock.calls.length;
      await app.close();
      await jest.advanceTimersByTimeAsync(10 * CONFIG.pollIntervalMs);

      expect(query.mock.calls.length).toBe(calls);
    } finally {
      jest.useRealTimers();
    }
  });
});
