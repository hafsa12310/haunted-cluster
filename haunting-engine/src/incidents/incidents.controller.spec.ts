import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { ClusterSnapshot, Incident } from '@haunted-cluster/shared';
import { ConfigModule } from '../config/config.module';
import { loadEngineConfig } from '../config/engine-config';
import { EngineStateService } from '../engine/engine-state.service';
import { IncidentsController } from './incidents.controller';
import { initialTrackerState, TrackerState } from './incident-tracker';

const CONFIG = loadEngineConfig({
  PROMETHEUS_URL: 'http://prometheus:9090',
  GATEWAY_URL: 'http://gateway:3000',
  ORDERS_URL: 'http://orders:3001',
  PAYMENTS_URL: 'http://payments:3002',
});

const SNAPSHOT: ClusterSnapshot = {
  timestamp: '2026-11-08T12:00:00.000Z',
  metricsAvailable: true,
  services: [],
  dread: 0,
  anomalies: [],
  forecasts: [],
};

function incident(id: string, rootService: string, resolvedAt: string | null = null): Incident {
  return {
    id,
    status: resolvedAt ? 'resolved' : 'open',
    rootService,
    kinds: ['latency'],
    affected: [],
    fingerprint: `${rootService}:latency`,
    openedAt: '2026-11-08T11:00:00.000Z',
    resolvedAt,
    durationMs: resolvedAt ? Date.parse(resolvedAt) - Date.parse('2026-11-08T11:00:00.000Z') : null,
    peak: { latencyP95Ms: 900, errorRatio: null, rssMb: null, minScore: 30 },
    recurrence: null,
    relatedChaos: [],
    similar: null,
  };
}

describe('IncidentsController (Requirement 10.3)', () => {
  let app: INestApplication;
  let state: EngineStateService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(CONFIG)],
      controllers: [IncidentsController],
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

  function setTracker(tracker: Partial<TrackerState>): void {
    state.update(SNAPSHOT, { ...initialTrackerState(CONFIG.serviceChain), ...tracker });
  }

  it('returns empty lists before any incident, even before the first Poll', async () => {
    const res = await request(app.getHttpServer()).get('/api/incidents');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ open: [], resolved: [] });
  });

  it('lists open incidents in SERVICE_CHAIN order, upstream first', async () => {
    const gateway = incident('g1', 'gateway');
    const orders = incident('o1', 'orders');
    const payments = incident('p1', 'payments');
    // Stored downstream first, so the order has to come from the chain.
    setTracker({ open: { payments, gateway, orders } });

    const res = await request(app.getHttpServer()).get('/api/incidents');

    expect(res.body.open).toEqual([gateway, orders, payments]);
  });

  it('lists resolved incidents newest first', async () => {
    const newest = incident('r3', 'orders', '2026-11-08T11:30:00.000Z');
    const middle = incident('r2', 'payments', '2026-11-08T11:20:00.000Z');
    const oldest = incident('r1', 'orders', '2026-11-08T11:10:00.000Z');
    setTracker({ history: [newest, middle, oldest] });

    const res = await request(app.getHttpServer()).get('/api/incidents');

    expect(res.body.resolved.map((i: Incident) => i.id)).toEqual(['r3', 'r2', 'r1']);
  });

  it('returns open and resolved together, with the full incidents', async () => {
    const open = incident('o2', 'orders');
    const resolved = incident('o1', 'orders', '2026-11-08T11:05:00.000Z');
    setTracker({ open: { orders: open }, history: [resolved] });

    const res = await request(app.getHttpServer()).get('/api/incidents');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ open: [open], resolved: [resolved] });
  });
});
