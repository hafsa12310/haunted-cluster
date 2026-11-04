/**
 * Load generator — sends steady POST /order traffic to the Gateway so there is
 * always baseline telemetry flowing through Gateway → Orders → Payments.
 *
 * Standalone script with no NestJS dependency; uses Node's built-in fetch.
 *
 * Env:
 * - GATEWAY_URL      (default http://localhost:3000)
 * - LOAD_INTERVAL_MS (default 500) — pause between requests
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6
 */

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3000';
const LOAD_INTERVAL_MS = Number(process.env.LOAD_INTERVAL_MS) || 500;
const REQUEST_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch reports network failures as a generic "fetch failed" with the real
 * reason (e.g. ECONNREFUSED) on `error.cause`, so include the cause's code.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const { cause } = error as Error & { cause?: { code?: string } };
  return cause?.code ? `${error.message} (${cause.code})` : error.message;
}

/**
 * Sends one POST /order and logs its status and response time.
 * Never throws: failures (including the 10 s abort) are logged instead, so the
 * loop keeps running. Requirements: 9.4, 9.5, 9.6
 */
async function sendOrder(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start = Date.now();

  try {
    const res = await fetch(`${GATEWAY_URL}/order`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    });
    // Drain the body so the connection is released and the timing covers the
    // full response.
    await res.arrayBuffer();
    console.log(`POST /order ${res.status} ${Date.now() - start}ms`);
  } catch (error) {
    const elapsed = Date.now() - start;
    const reason = controller.signal.aborted
      ? `timed out after ${REQUEST_TIMEOUT_MS}ms`
      : describeError(error);
    console.log(`POST /order ERROR ${reason} ${elapsed}ms`);
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  console.log(
    `Load generator started: POST ${GATEWAY_URL}/order every ${LOAD_INTERVAL_MS}ms`,
  );

  // Requirements: 9.1 — run until the process is stopped.
  for (;;) {
    await sendOrder();
    await sleep(LOAD_INTERVAL_MS);
  }
}

main();
