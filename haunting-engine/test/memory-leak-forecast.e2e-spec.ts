/**
 * End-to-end test: the memory-leak forecast warns before payments crashes.
 *
 * Needs the full stack (`docker compose up`). Without it the test logs a note
 * and returns without injecting chaos.
 *
 * Env (test-only): INTEGRATION_LEAK_TIMEOUT_SECONDS (default 300),
 * INTEGRATION_MIN_LEAD_SECONDS (default 10). FORECAST_RESTART_DROP_MB (20)
 * must match the engine's value. The crash is a real OOM kill and restart of
 * payments (memswap_limit = mem_limit, PAYMENTS_CHAOS_TTL_SECONDS outlives the leak).
 *
 * Requirements: R14.1-R14.6, R14.8-R14.13, R6.3, R6.7
 */

import type {
  ClusterSnapshot,
  ForecastClearedPayload,
  MemoryForecast,
} from '@haunted-cluster/shared';

import {
  connect,
  ENGINE_URL,
  EngineClient,
  postJson,
  resetAllChaos,
  waitForNoOpenIncidents,
} from './helpers';
import {
  computeLeadSeconds,
  IntegrationSettings,
  isRestartSnapshot,
  parseIntegrationSettings,
} from './leak-lead-time';

const POLL_INTERVAL_MS = 1000;
const READY_TIMEOUT_MS = 120_000;
const CLEARED_EVENT_WAIT_MS = 15_000;

const DEFAULT_TIMEOUT_SECONDS = 300;

/** Reads a positive number from the environment, or the default when unset. */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

// Parsed at load time so a bad value fails before any chaos is injected (R14.11).
// A bad value is kept as an error and rethrown from the test itself.
let settings: IntegrationSettings | undefined;
let settingsError: Error | undefined;
try {
  settings = parseIntegrationSettings(process.env);
} catch (error) {
  settingsError = error instanceof Error ? error : new Error(String(error));
}
const testTimeoutMs = ((settings?.leakTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) + 60) * 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function getSnapshot(): Promise<ClusterSnapshot> {
  const res = await fetch(`${ENGINE_URL}/api/snapshot`);
  if (!res.ok) throw new Error(`GET /api/snapshot returned ${res.status}`);
  return (await res.json()) as ClusterSnapshot;
}

async function stackIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${ENGINE_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

function paymentsWarning(snapshot: ClusterSnapshot): boolean {
  return snapshot.forecasts.some((f) => f.service === 'payments' && f.warning);
}

function paymentsRss(snapshot: ClusterSnapshot): number | null {
  const payments = snapshot.services.find((s) => s.service === 'payments');
  const rss = payments?.signals.rssMb ?? null;
  return rss !== null && Number.isFinite(rss) ? rss : null;
}

/** Waits until payments is healthy with no payments warning. */
async function waitForPaymentsCalm(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const snapshot = await getSnapshot();
    const payments = snapshot.services.find((s) => s.service === 'payments');
    if (payments?.status === 'healthy' && !paymentsWarning(snapshot)) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`payments was not healthy without a warning within ${READY_TIMEOUT_MS} ms`);
}

describe('memory-leak forecast (full stack)', () => {
  let chaosInjected = false;
  let socket: EngineClient | undefined;

  afterAll(async () => {
    if (!chaosInjected) return;
    try {
      await resetAllChaos();
    } finally {
      socket?.close();
      await waitForNoOpenIncidents();
    }
  });

  it(
    'warns before payments crashes, with enough lead time',
    async () => {
      // Settings first: fail before any chaos on a bad value.
      if (settingsError !== undefined || settings === undefined) {
        throw settingsError ?? new Error('integration settings were not parsed');
      }
      const { leakTimeoutSeconds, minLeadSeconds } = settings;
      const restartDropMb = envNumber('FORECAST_RESTART_DROP_MB', 20);

      if (!(await stackIsUp())) {
        console.log(
          `The full stack is required (GET ${ENGINE_URL}/health failed). ` +
            'Start it with `docker compose up`. Skipping with no chaos injected.',
        );
        return;
      }

      await resetAllChaos();
      await waitForNoOpenIncidents();
      await waitForPaymentsCalm();

      const warnings: MemoryForecast[] = [];
      const cleared: ForecastClearedPayload[] = [];
      socket = await connect();
      socket.on('forecast:warning', (forecast) => {
        if (forecast.service === 'payments') warnings.push(forecast);
      });
      socket.on('forecast:cleared', (payload) => {
        if (payload.service === 'payments') cleared.push(payload);
      });

      chaosInjected = true;
      const leakRes = await postJson('/api/chaos/payments/memory-leak', { enabled: true });
      expect(leakRes.ok).toBe(true);

      let warningTs: string | null = null;
      let crashTs: string | null = null;
      let maxRss: number | null = null;
      let lastTimestamp: string | null = null;
      const deadline = Date.now() + leakTimeoutSeconds * 1000;

      while (Date.now() < deadline && crashTs === null) {
        const snapshot = await getSnapshot();
        if (snapshot.timestamp !== lastTimestamp) {
          lastTimestamp = snapshot.timestamp;
          if (warningTs === null && paymentsWarning(snapshot)) {
            warningTs = snapshot.timestamp;
          }
          // Real restart only (down or RSS drop): RSS passes MEMORY_LIMIT_MB
          // ~40 MB before the kernel OOM kill, see isRestartSnapshot.
          if (isRestartSnapshot(snapshot, maxRss, restartDropMb)) {
            crashTs = snapshot.timestamp;
          } else {
            const rss = paymentsRss(snapshot);
            if (rss !== null && (maxRss === null || rss > maxRss)) maxRss = rss;
          }
        }
        if (crashTs === null) await sleep(POLL_INTERVAL_MS);
      }

      if (crashTs !== null) {
        if (warningTs === null) {
          throw new Error('no forecast warning was observed');
        }
        const leadSeconds = computeLeadSeconds(warningTs, crashTs);
        console.log(
          `lead time: ${leadSeconds} s (minimum ${minLeadSeconds} s), ` +
            `warning at ${warningTs}, crash at ${crashTs}, max RSS ${maxRss ?? 'n/a'} MB`,
        );
        if (leadSeconds <= 0) {
          throw new Error(
            `warning (${warningTs}) was not earlier than the crash (${crashTs}); lead ${leadSeconds} s`,
          );
        }
        if (leadSeconds < minLeadSeconds) {
          throw new Error(
            `lead time ${leadSeconds} s is below the minimum ${minLeadSeconds} s ` +
              `(warning ${warningTs}, crash ${crashTs}, minimum ${minLeadSeconds} s)`,
          );
        }

        // After a crash the engine must clear the warning with memory-dropped.
        const clearDeadline = Date.now() + CLEARED_EVENT_WAIT_MS;
        while (
          Date.now() < clearDeadline &&
          !cleared.some((c) => c.reason === 'memory-dropped')
        ) {
          await sleep(250);
        }
        expect(cleared.some((c) => c.reason === 'memory-dropped')).toBe(true);
      } else {
        expect(warningTs).not.toBeNull();
        console.log(
          `no crash occurred within ${leakTimeoutSeconds} s; warning at ${warningTs}. ` +
            'Skipping the lead-time assertions.',
        );
      }

      expect(warnings).toHaveLength(1);
    },
    testTimeoutMs,
  );
});
