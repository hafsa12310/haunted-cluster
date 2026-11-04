/**
 * Shared helpers for the end-to-end tests, which run against a stack started
 * with `docker compose up` from the repo root.
 *
 * Env:
 * - GATEWAY_URL  (default http://localhost:3000)
 * - ORDERS_URL   (default http://localhost:3001)
 * - PAYMENTS_URL (default http://localhost:3002)
 */

export const SERVICES = {
  gateway: process.env.GATEWAY_URL || 'http://localhost:3000',
  orders: process.env.ORDERS_URL || 'http://localhost:3001',
  payments: process.env.PAYMENTS_URL || 'http://localhost:3002',
};

const READY_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls GET /health until it returns 200, failing after READY_TIMEOUT_MS. */
async function waitForHealthy(name: string, baseUrl: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // Service not accepting connections yet; retry.
    }
    await sleep(500);
  }
  throw new Error(`${name} at ${baseUrl} was not healthy within ${READY_TIMEOUT_MS} ms`);
}

/** Waits for all three services to report healthy. */
export async function waitForStack(): Promise<void> {
  await Promise.all(
    Object.entries(SERVICES).map(([name, url]) => waitForHealthy(name, url)),
  );
}

/** Sends a JSON POST request. */
export function postJson(url: string, body: unknown = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
