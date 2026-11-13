/**
 * Pure helpers for the memory-leak lead-time integration test.
 *
 * No I/O, no timers, no shared state. The test itself (which talks to the
 * running stack) imports these.
 *
 * Requirements: R14.4, R14.5, R14.6, R14.11
 */

import type { ClusterSnapshot } from '@haunted-cluster/shared';

export const LEAK_TIMEOUT_VAR = 'INTEGRATION_LEAK_TIMEOUT_SECONDS';
export const MIN_LEAD_VAR = 'INTEGRATION_MIN_LEAD_SECONDS';

export const DEFAULT_LEAK_TIMEOUT_SECONDS = 300;
export const DEFAULT_MIN_LEAD_SECONDS = 10;

const POSITIVE_INTEGER = /^[1-9]\d*$/;

export interface IntegrationSettings {
  leakTimeoutSeconds: number;
  minLeadSeconds: number;
}

/** Parses one positive-integer variable; an unset variable gives the default. */
function parsePositiveInteger(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  if (!POSITIVE_INTEGER.test(raw)) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/**
 * Reads the two test-only settings (R14.1, R14.6, R14.11). Throws an Error
 * naming the offending variable when a value is not a positive integer.
 */
export function parseIntegrationSettings(
  env: Readonly<Record<string, string | undefined>>,
): IntegrationSettings {
  return {
    leakTimeoutSeconds: parsePositiveInteger(env, LEAK_TIMEOUT_VAR, DEFAULT_LEAK_TIMEOUT_SECONDS),
    minLeadSeconds: parsePositiveInteger(env, MIN_LEAD_VAR, DEFAULT_MIN_LEAD_SECONDS),
  };
}

/**
 * True when the snapshot shows the payments crash (R14.4), by any of:
 * - payments status is `down`;
 * - payments RSS is at or above `limitMb`;
 * - payments RSS is more than `restartDropMb` below `maxRssSeen`, the maximum
 *   payments RSS seen earlier in this run (null when none has been seen).
 */
export function isCrashSnapshot(
  snapshot: ClusterSnapshot,
  maxRssSeen: number | null,
  limitMb: number,
  restartDropMb: number,
): boolean {
  if (isRestartSnapshot(snapshot, maxRssSeen, restartDropMb)) {
    return true;
  }
  const rss = paymentsRssMb(snapshot);
  return rss !== null && rss >= limitMb;
}

/**
 * True only on evidence that payments actually died or restarted: status
 * `down`, or RSS more than `restartDropMb` below `maxRssSeen`.
 *
 * Unlike `isCrashSnapshot` it ignores "RSS at or above the limit". Process RSS
 * also counts shared mapped pages that the cgroup does not charge, so on the
 * compose stack RSS passes MEMORY_LIMIT_MB about 40 MB before the kernel OOM
 * kill (measured: kill at RSS ~296 MB with a 256 MiB cgroup limit).
 */
export function isRestartSnapshot(
  snapshot: ClusterSnapshot,
  maxRssSeen: number | null,
  restartDropMb: number,
): boolean {
  const payments = snapshot.services.find((s) => s.service === 'payments');
  if (payments === undefined) {
    return false;
  }
  if (payments.status === 'down') {
    return true;
  }
  const rss = paymentsRssMb(snapshot);
  return rss !== null && maxRssSeen !== null && maxRssSeen - rss > restartDropMb;
}

/** Payments RSS in MB, or null when missing or not finite. */
function paymentsRssMb(snapshot: ClusterSnapshot): number | null {
  const rss = snapshot.services.find((s) => s.service === 'payments')?.signals.rssMb ?? null;
  return rss !== null && Number.isFinite(rss) ? rss : null;
}

/**
 * Lead time in seconds: crash time minus warning time (R14.5, R14.6).
 * Both arguments are ISO 8601 snapshot timestamps. Throws on an unparsable
 * timestamp.
 */
export function computeLeadSeconds(warningTs: string, crashTs: string): number {
  const warning = Date.parse(warningTs);
  const crash = Date.parse(crashTs);
  if (Number.isNaN(warning)) {
    throw new Error(`Invalid warning timestamp: "${warningTs}"`);
  }
  if (Number.isNaN(crash)) {
    throw new Error(`Invalid crash timestamp: "${crashTs}"`);
  }
  return (crash - warning) / 1000;
}
