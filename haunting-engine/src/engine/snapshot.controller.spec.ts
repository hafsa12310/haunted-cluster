import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { ClusterSnapshot } from '@haunted-cluster/shared';
import { ConfigModule } from '../config/config.module';
import { loadEngineConfig } from '../config/engine-config';
import { initialTrackerState } from '../incidents/incident-tracker';
import { EngineStateService } from './engine-state.service';
import { SnapshotController } from './snapshot.controller';

const CONFIG = loadEngineConfig({
  PROMETHEUS_URL: 'http://prometheus:9090',
  GATEWAY_URL: 'http://gateway:3000',
  ORDERS_URL: 'http://orders:3001',
  PAYMENTS_URL: 'http://payments:3002',
});

function snapshot(overrides: Partial<ClusterSnapshot> = {}): ClusterSnapshot {
  return {
    timestamp: '2026-11-08T12:00:00.000Z',
    metricsAvailable: true,
    services: [
      {
        service: 'orders',
        status: 'degraded',
        score: 55,
        signals: { requestRate: 10, errorRatio: 0.1, latencyP95Ms: 80, rssMb: 90, up: true },
        badness: { latency: 0, errors: 0.47, memory: 0 },
        breachedKinds: ['errors'],
      },
    ],
    dread: 0.47,
    ...overrides,
  };
}

describe('SnapshotController (Requirement 10.2)', () => {
  let app: INestApplication;
  let state: EngineStateService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(CONFIG)],
      controllers: [SnapshotController],
      providers: [EngineStateService],
    }).compile();
    app = moduleRef.createNestApplication();
    // On 127.0.0.1, where supertest connects. Left to supertest, the server binds
    // ::, and on macOS another app's 127.0.0.1 listener on the same port gets the request.
    await app.listen(0, '127.0.0.1');
    state = moduleRef.get(EngineStateService);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 503 { message: "no poll has completed yet" } before the first Poll', async () => {
    const res = await request(app.getHttpServer()).get('/api/snapshot');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ message: 'no poll has completed yet' });
  });

  it('returns 200 with the latest snapshot after a Poll', async () => {
    const first = snapshot();
    state.update(first, initialTrackerState(CONFIG.serviceChain));

    const res = await request(app.getHttpServer()).get('/api/snapshot');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(first);
  });

  it('always returns the most recent Poll', async () => {
    state.update(snapshot({ dread: 0.1 }), initialTrackerState(CONFIG.serviceChain));
    const latest = snapshot({ timestamp: '2026-11-08T12:00:02.000Z', dread: 0.9 });
    state.update(latest, initialTrackerState(CONFIG.serviceChain));

    const res = await request(app.getHttpServer()).get('/api/snapshot');

    expect(res.body).toEqual(latest);
  });

  it('returns 200, not 503, for a Poll that could not reach Prometheus', async () => {
    // A blind Poll still completed: it reports metricsAvailable: false rather than no data.
    const blind = snapshot({ metricsAvailable: false, dread: 0 });
    state.update(blind, initialTrackerState(CONFIG.serviceChain));

    const res = await request(app.getHttpServer()).get('/api/snapshot');

    expect(res.status).toBe(200);
    expect(res.body.metricsAvailable).toBe(false);
  });
});
