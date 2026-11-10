/**
 * Shared helpers for the end-to-end tests, which run against the full stack
 * started with `docker compose up` from the repo root.
 *
 * Env:
 * - ENGINE_URL (default http://localhost:4000)
 *
 * Requirements: 9.1
 */

import type { ClientToServerEvents, Incident, ServerToClientEvents } from '@haunted-cluster/shared';
import { io, Socket } from 'socket.io-client';

export const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:4000';

export type EngineClient = Socket<ServerToClientEvents, ClientToServerEvents>;
export type EventName = keyof ServerToClientEvents;
export type EventPayload<K extends EventName> = Parameters<ServerToClientEvents[K]>[0];

const CONNECT_TIMEOUT_MS = 10_000;

/** Opens a Socket.IO connection to the engine, failing after CONNECT_TIMEOUT_MS. */
export function connect(): Promise<EngineClient> {
  const socket: EngineClient = io(ENGINE_URL, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`could not connect to ${ENGINE_URL} within ${CONNECT_TIMEOUT_MS} ms`));
    }, CONNECT_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(`could not connect to ${ENGINE_URL}: ${error.message}`));
    });
  });
}

/**
 * Resolves with the next `name` event whose payload matches `predicate`.
 * Only events arriving after the call count, so start waiting before
 * triggering whatever should cause the event.
 */
export function nextEvent<K extends EventName>(
  socket: EngineClient,
  name: K,
  predicate: (payload: EventPayload<K>) => boolean = () => true,
  timeoutMs = 10_000,
): Promise<EventPayload<K>> {
  return new Promise((resolve, reject) => {
    let seen = 0;
    // Socket.IO's typed listeners don't narrow well for a generic event name.
    const listener = ((payload: EventPayload<K>) => {
      seen += 1;
      if (!predicate(payload)) return;
      cleanup();
      resolve(payload);
    }) as unknown as ServerToClientEvents[K];
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`no matching ${name} within ${timeoutMs} ms (${seen} ${name} event(s) did not match)`),
      );
    }, timeoutMs);
    function cleanup(): void {
      clearTimeout(timer);
      socket.off(name, listener as never);
    }
    socket.on(name, listener as never);
  });
}

/** Sends a JSON POST to the engine. */
export function postJson(path: string, body?: unknown): Promise<Response> {
  return fetch(`${ENGINE_URL}${path}`, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Waits until the engine has no open incidents, so a leftover one can't hide `incident:opened`. */
export async function waitForNoOpenIncidents(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${ENGINE_URL}/api/incidents`);
    const { open } = (await res.json()) as { open: Incident[] };
    if (open.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`incidents were still open after ${timeoutMs} ms`);
}

/**
 * Clears chaos on every victim service through the engine. Every e2e file
 * calls it from `afterAll`, so a failed test can't leave a service broken.
 */
export async function resetAllChaos(): Promise<void> {
  const res = await postJson('/api/chaos/reset-all');
  if (!res.ok) throw new Error(`reset-all returned ${res.status}`);
}
