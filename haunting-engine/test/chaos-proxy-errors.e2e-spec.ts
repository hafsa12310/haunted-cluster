/**
 * Chaos proxy errors: bad requests are rejected by the engine and never reach
 * a victim service.
 *
 * Runs against `docker compose up`; see helpers.ts for ENGINE_URL.
 *
 * Requirements: 7.2, 7.3
 */

import type { ChaosEvent } from '@haunted-cluster/shared';
import { connect, ENGINE_URL, EngineClient, postJson, resetAllChaos } from './helpers';

/** Long enough for a stray chaos:triggered to arrive if one were sent. */
const QUIET_MS = 1500;

describe('Chaos proxy errors (e2e)', () => {
  let socket: EngineClient;
  const triggered: ChaosEvent[] = [];

  beforeAll(async () => {
    socket = await connect();
    await resetAllChaos();
    socket.on('chaos:triggered', (event) => triggered.push(event));
  });

  beforeEach(() => {
    triggered.length = 0;
  });

  afterAll(async () => {
    socket?.close();
    await resetAllChaos();
  });

  it('returns 404 { message: "unknown service: <name>" } for a service outside SERVICE_CHAIN (Requirement 7.3)', async () => {
    const res = await postJson('/api/chaos/nope/crash');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: 'unknown service: nope' });

    // Nothing was forwarded, so no command was accepted or announced.
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    expect(triggered).toEqual([]);
  });

  it('returns 400 for { ms: -1 } and leaves the victim untouched (Requirement 7.2)', async () => {
    const res = await postJson('/api/chaos/orders/latency', { ms: -1 });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string[] };
    expect(body.message).toContain('ms must not be less than 0');

    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    expect(triggered).toEqual([]);
    // The victim never received the command: its latency is still 0.
    const state = (await (await fetch(`${ENGINE_URL}/api/chaos/orders/state`)).json()) as {
      latencyMs: number;
    };
    expect(state.latencyMs).toBe(0);
  });
});
