/**
 * Incident lifecycle with chaos evidence: break orders through the engine's
 * chaos proxy, watch the incident open with the right root cause and evidence,
 * then repair it and watch the same incident resolve.
 *
 * Runs against `docker compose up`; see helpers.ts for ENGINE_URL.
 *
 * Requirements: 4.1, 4.2, 5.2, 5.5, 7.6, 8.1, 9.3
 */

import type { ChaosEvent, Incident } from '@haunted-cluster/shared';
import {
  connect,
  ENGINE_URL,
  EngineClient,
  nextEvent,
  postJson,
  resetAllChaos,
  waitForNoOpenIncidents,
} from './helpers';

/** Rate window (15 s) for errors to show, plus OPEN_AFTER_POLLS Polls, with margin. */
const OPEN_TIMEOUT_MS = 40_000;
/** design.md: 15 s rate window decay + 3 close Polls. */
const RESOLVE_TIMEOUT_MS = 45_000;

describe('Incident lifecycle with chaos evidence (e2e)', () => {
  let socket: EngineClient;
  let chaos: ChaosEvent | undefined;
  let opened: Incident | undefined;

  beforeAll(async () => {
    socket = await connect();
    await resetAllChaos();
    await waitForNoOpenIncidents();
  }, 90_000);

  afterAll(async () => {
    socket?.close();
    await resetAllChaos();
  });

  it('opens an incident rooted at orders, with gateway affected and the chaos command as evidence', async () => {
    // Listen before acting: nextEvent only sees events that arrive after it is called.
    const triggered = nextEvent(
      socket,
      'chaos:triggered',
      (e) => e.service === 'orders' && e.action === 'error-rate',
      10_000,
    );
    const incidentOpened = nextEvent(
      socket,
      'incident:opened',
      (i) => i.rootService === 'orders',
      OPEN_TIMEOUT_MS,
    );

    const res = await postJson('/api/chaos/orders/error-rate', { percentage: 100 });
    expect(res.ok).toBe(true);

    // Requirement 7.6: the accepted command is announced to clients.
    chaos = await triggered;
    expect(chaos.params).toEqual({ percentage: 100 });

    opened = await incidentOpened;
    expect(opened.status).toBe('open');
    // Requirement 4.1: orders is the most downstream service with errors.
    expect(opened.kinds).toContain('errors');
    expect(opened.fingerprint).toBe('orders:errors');
    // Requirement 4.2: gateway fails only because orders does.
    const gateway = opened.affected.find((a) => a.service === 'gateway');
    expect(gateway?.kinds).toContain('errors');
    expect(opened.affected.map((a) => a.service)).not.toContain('orders');
    // Requirement 8.1: the command that caused it is attached as evidence.
    expect(opened.relatedChaos).toContainEqual(chaos);
  }, OPEN_TIMEOUT_MS + 20_000);

  it('resolves the same incident after orders is reset', async () => {
    if (!opened) throw new Error('no incident opened in the previous step');
    const id = opened.id;

    const incidentResolved = nextEvent(socket, 'incident:resolved', (i) => i.id === id, RESOLVE_TIMEOUT_MS);
    const res = await postJson('/api/chaos/orders/reset');
    expect(res.ok).toBe(true);

    const resolved = await incidentResolved;
    expect(resolved.status).toBe('resolved');
    expect(resolved.rootService).toBe('orders');
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.durationMs).toBe(Date.parse(resolved.resolvedAt!) - Date.parse(resolved.openedAt));
    // The peak keeps the breach that opened it. How high it gets depends on how
    // much of the 15 s rate window filled before the reset, so only check that it
    // passed the breach line: ok + 0.2 × (critical − ok) with the default 0.01 / 0.2.
    expect(resolved.peak.errorRatio).toBeGreaterThan(0.01 + 0.2 * (0.2 - 0.01));

    // It is now history, not open.
    const { open, resolved: history } = (await (await fetch(`${ENGINE_URL}/api/incidents`)).json()) as {
      open: Incident[];
      resolved: Incident[];
    };
    expect(open.map((i) => i.id)).not.toContain(id);
    expect(history[0].id).toBe(id);
  }, RESOLVE_TIMEOUT_MS + 20_000);
});
