/**
 * Recurrence: break orders the same way twice. The second incident must
 * recognise the first as the same fault happening again.
 *
 * Runs against `docker compose up`; see helpers.ts for ENGINE_URL.
 *
 * Requirements: 6.2
 */

import type { Incident } from '@haunted-cluster/shared';
import {
  connect,
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

describe('Recurrence (e2e)', () => {
  let socket: EngineClient;
  let first: Incident | undefined;
  let firstResolved: Incident | undefined;
  let second: Incident | undefined;

  /** 16.3's scenario: 100 % errors on orders until an orders incident opens. */
  async function breakOrders(): Promise<Incident> {
    const opened = nextEvent(socket, 'incident:opened', (i) => i.rootService === 'orders', OPEN_TIMEOUT_MS);
    const res = await postJson('/api/chaos/orders/error-rate', { percentage: 100 });
    expect(res.ok).toBe(true);
    const incident = await opened;
    expect(incident.fingerprint).toBe('orders:errors');
    return incident;
  }

  /** Resets orders and waits for `incident` to resolve. */
  async function repairOrders(incident: Incident): Promise<Incident> {
    const resolved = nextEvent(socket, 'incident:resolved', (i) => i.id === incident.id, RESOLVE_TIMEOUT_MS);
    const res = await postJson('/api/chaos/orders/reset');
    expect(res.ok).toBe(true);
    return resolved;
  }

  beforeAll(async () => {
    socket = await connect();
    await resetAllChaos();
    await waitForNoOpenIncidents();
  }, 90_000);

  afterAll(async () => {
    socket?.close();
    await resetAllChaos();
  });

  it('opens and resolves a first orders:errors incident', async () => {
    first = await breakOrders();
    firstResolved = await repairOrders(first);
    expect(firstResolved.status).toBe('resolved');
  }, OPEN_TIMEOUT_MS + RESOLVE_TIMEOUT_MS + 10_000);

  it('links the second incident to the first through its recurrence', async () => {
    if (!first || !firstResolved) throw new Error('the first incident did not complete');

    second = await breakOrders();

    expect(second.id).not.toBe(first.id);
    expect(second.recurrence).not.toBeNull();
    // ≥ 1, not = 1: earlier runs against the same stack leave older matches in history.
    expect(second.recurrence!.count).toBeGreaterThanOrEqual(1);
    // The newest match is the incident this test just resolved.
    expect(second.recurrence!.lastIncidentId).toBe(first.id);
    expect(second.recurrence!.lastResolvedAt).toBe(firstResolved.resolvedAt);
    expect(second.recurrence!.lastDurationMs).toBe(firstResolved.durationMs);
  }, OPEN_TIMEOUT_MS + 10_000);

  it('resolves the second incident, leaving the cluster clean', async () => {
    if (!second) throw new Error('no second incident opened');
    const resolved = await repairOrders(second);
    expect(resolved.status).toBe('resolved');
  }, RESOLVE_TIMEOUT_MS + 10_000);
});
