/**
 * Validates that all required environment variables are present at startup.
 * Called before NestFactory.create() in each app's main.ts.
 *
 * If any variable is missing, logs a descriptive error for each one and
 * exits the process with code 1.
 */
export function validateRequiredEnv(vars: string[]): void {
  const missing = vars.filter(
    (v) => !process.env[v] || process.env[v]!.trim() === '',
  );

  if (missing.length > 0) {
    for (const v of missing) {
      console.error(`[Bootstrap] ${v} is required but not set. Exiting.`);
    }
    process.exit(1);
  }
}

const DEFAULT_MEMORY_GAUGE_INTERVAL_MS = 1000;

/**
 * Parses MEMORY_GAUGE_INTERVAL_MS. Returns 1000 when unset or empty;
 * otherwise the trimmed value must be a positive safe integer in plain
 * decimal form, else an Error naming the variable is thrown.
 */
export function parseMemoryGaugeIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_MEMORY_GAUGE_INTERVAL_MS;
  }

  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(
      `MEMORY_GAUGE_INTERVAL_MS must be a positive integer, got "${raw}"`,
    );
  }

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `MEMORY_GAUGE_INTERVAL_MS must be a safe integer, got "${raw}"`,
    );
  }
  return value;
}

/**
 * Validates MEMORY_GAUGE_INTERVAL_MS at startup. Logs and exits with
 * code 1 when the value is invalid.
 */
export function validateMemoryGaugeInterval(): void {
  try {
    parseMemoryGaugeIntervalMs(process.env.MEMORY_GAUGE_INTERVAL_MS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Bootstrap] ${message}. Exiting.`);
    process.exit(1);
  }
}
