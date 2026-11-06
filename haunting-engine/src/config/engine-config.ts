/**
 * Engine configuration, read once from environment variables at startup.
 *
 * `loadEngineConfig` is pure: it never touches `process.env` or exits the
 * process itself. It throws a `ConfigError` naming the offending variable, and
 * `main.ts` turns that into a log line and `process.exit(1)`.
 *
 * Requirements: 7.7, 13.1, 13.2, 13.3
 */

export interface Thresholds {
  ok: number;
  critical: number;
}

export interface EngineConfig {
  port: number;
  prometheusUrl: string;
  /** Upstream → downstream. */
  serviceChain: string[];
  /** Service name → base URL, from `<SERVICE>_URL`. */
  serviceUrls: Record<string, string>;
  pollIntervalMs: number;
  /** PromQL duration, e.g. "15s". */
  rateWindow: string;
  prometheusTimeoutMs: number;
  latencyMs: Thresholds;
  errorRatio: Thresholds;
  memoryMb: Thresholds;
  openAfterPolls: number;
  closeAfterPolls: number;
  incidentHistoryLimit: number;
  chaosEvidenceWindowSeconds: number;
  chaosProxyTimeoutMs: number;
  corsOrigin: string;
}

/** Thrown when a variable is missing or invalid; `variable` names it. */
export class ConfigError extends Error {
  constructor(
    readonly variable: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

const RATE_WINDOW_PATTERN = /^\d+[smh]$/;

/** Returns the trimmed value, or undefined when unset or blank. */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = read(env, name);
  if (value === undefined) {
    throw new ConfigError(name, `${name} is required but not set`);
  }
  return value;
}

function finiteNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = read(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ConfigError(name, `${name} must be a number, got "${raw}"`);
  }
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = finiteNumber(env, name, fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(name, `${name} must be a positive integer, got "${read(env, name)}"`);
  }
  return value;
}

function thresholds(
  env: NodeJS.ProcessEnv,
  okName: string,
  okDefault: number,
  criticalName: string,
  criticalDefault: number,
): Thresholds {
  const ok = finiteNumber(env, okName, okDefault);
  const critical = finiteNumber(env, criticalName, criticalDefault);
  if (ok >= critical) {
    throw new ConfigError(
      okName,
      `${okName} (${ok}) must be less than ${criticalName} (${critical})`,
    );
  }
  return { ok, critical };
}

/** `checkout-api` → `CHECKOUT_API_URL`. Requirements: 7.7 */
export function serviceUrlVariable(service: string): string {
  return `${service.toUpperCase().replace(/-/g, '_')}_URL`;
}

function serviceChain(env: NodeJS.ProcessEnv): string[] {
  const raw = read(env, 'SERVICE_CHAIN') ?? 'gateway,orders,payments';
  const chain = raw.split(',').map((s) => s.trim());
  if (chain.some((s) => s === '')) {
    throw new ConfigError('SERVICE_CHAIN', `SERVICE_CHAIN has an empty entry: "${raw}"`);
  }
  const duplicate = chain.find((s, i) => chain.indexOf(s) !== i);
  if (duplicate !== undefined) {
    throw new ConfigError('SERVICE_CHAIN', `SERVICE_CHAIN lists "${duplicate}" more than once`);
  }
  return chain;
}

/** Drops trailing slashes so `${url}/chaos/...` never produces `//`. */
function baseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function loadEngineConfig(env: NodeJS.ProcessEnv): EngineConfig {
  const prometheusUrl = baseUrl(required(env, 'PROMETHEUS_URL'));

  const chain = serviceChain(env);
  const serviceUrls: Record<string, string> = {};
  for (const service of chain) {
    serviceUrls[service] = baseUrl(required(env, serviceUrlVariable(service)));
  }

  const rateWindow = read(env, 'RATE_WINDOW') ?? '15s';
  if (!RATE_WINDOW_PATTERN.test(rateWindow)) {
    throw new ConfigError(
      'RATE_WINDOW',
      `RATE_WINDOW must be a duration like "15s", "2m" or "1h", got "${rateWindow}"`,
    );
  }

  return {
    port: positiveInteger(env, 'PORT', 4000),
    prometheusUrl,
    serviceChain: chain,
    serviceUrls,
    pollIntervalMs: positiveInteger(env, 'POLL_INTERVAL_MS', 2000),
    rateWindow,
    prometheusTimeoutMs: positiveInteger(env, 'PROMETHEUS_TIMEOUT_MS', 1500),
    latencyMs: thresholds(env, 'LATENCY_OK_MS', 100, 'LATENCY_CRITICAL_MS', 1000),
    errorRatio: thresholds(env, 'ERROR_RATIO_OK', 0.01, 'ERROR_RATIO_CRITICAL', 0.2),
    memoryMb: thresholds(env, 'MEMORY_OK_MB', 120, 'MEMORY_CRITICAL_MB', 230),
    openAfterPolls: positiveInteger(env, 'OPEN_AFTER_POLLS', 2),
    closeAfterPolls: positiveInteger(env, 'CLOSE_AFTER_POLLS', 3),
    incidentHistoryLimit: positiveInteger(env, 'INCIDENT_HISTORY_LIMIT', 50),
    chaosEvidenceWindowSeconds: positiveInteger(env, 'CHAOS_EVIDENCE_WINDOW_SECONDS', 150),
    chaosProxyTimeoutMs: positiveInteger(env, 'CHAOS_PROXY_TIMEOUT_MS', 3000),
    corsOrigin: read(env, 'CORS_ORIGIN') ?? 'http://localhost:3100',
  };
}
