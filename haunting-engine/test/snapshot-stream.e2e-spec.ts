/**
 * Snapshot stream: the engine streams real cluster state over Socket.IO.
 *
 * Runs against `docker compose up`; see helpers.ts for ENGINE_URL.
 *
 * Requirements: 9.2, 12.5
 */

import { connect, EngineClient, nextEvent, resetAllChaos } from './helpers';

describe('Snapshot stream (e2e)', () => {
  let socket: EngineClient;

  beforeAll(async () => {
    socket = await connect();
  });

  afterAll(async () => {
    socket?.close();
    await resetAllChaos();
  });

  it('sends a cluster:snapshot with metricsAvailable: true within 10 s', async () => {
    const snapshot = await nextEvent(socket, 'cluster:snapshot', (s) => s.metricsAvailable, 10_000);

    expect(snapshot.services.map((h) => h.service)).toEqual(['gateway', 'orders', 'payments']);
    expect(Number.isNaN(Date.parse(snapshot.timestamp))).toBe(false);
    expect(snapshot.dread).toBeGreaterThanOrEqual(0);
    expect(snapshot.dread).toBeLessThanOrEqual(1);
  });

  it('reports all three services healthy within 30 s', async () => {
    const snapshot = await nextEvent(
      socket,
      'cluster:snapshot',
      (s) =>
        s.metricsAvailable &&
        s.services.every(
          // Healthy on real traffic from the load generator. Just after Prometheus
          // starts, rate() has too few samples and requestRate is null; such a
          // service also scores healthy, but that isn't what this test is about.
          (h) => h.status === 'healthy' && h.signals.requestRate !== null && h.signals.requestRate > 0,
        ),
      30_000,
    );

    for (const health of snapshot.services) {
      expect(health.score).toBeGreaterThanOrEqual(80);
      expect(health.breachedKinds).toEqual([]);
      expect(health.signals.up).toBe(true);
    }
  });

  it('keeps streaming, one snapshot per Poll', async () => {
    const first = await nextEvent(socket, 'cluster:snapshot', () => true, 10_000);
    const second = await nextEvent(socket, 'cluster:snapshot', () => true, 10_000);

    expect(Date.parse(second.timestamp)).toBeGreaterThan(Date.parse(first.timestamp));
  });
});
