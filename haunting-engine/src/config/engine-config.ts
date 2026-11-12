/**
 * Engine configuration, read once from environment variables at startup.
 *
 * `loadEngineConfig` is pure: it never touches `process.env` or exits the
 * process itself. It throws a `ConfigError` naming the offending variable, and
 * `main.ts` turns that into a log line and `process.exit(1)`.
 *
 * Requirements: 7.7, 13.1, 13.2, 13.3
 */

import type { MonitoredSignal } from '@haunted-cluster/shared';

export interface Thresholds {
  ok: number;
  critical: number;
}

export interface AnomalyConfig {
  alpha: number; // ANOMALY_ALPHA, (0, 1]
  zThreshold: number; // ANOMALY_Z_THRESHOLD, > 0
  warmupPolls: number; // ANOMALY_WARMUP_POLLS, integer >= 1
  confirmPolls: number; // ANOMALY_CONFIRM_POLLS, integer >= 1
  relearnPolls: number; // ANOMALY_RELEARN_POLLS, integer >= confirmPolls
  minStdDev: Record<MonitoredSignal, number>; // ANOMALY_MIN_STDDEV_*, > 0
}

export interface ForecastConfig {
  windowPolls: number; // FORECAST_WINDOW_POLLS
  minSamples: number; // FORECAST_MIN_SAMPLES, <= windowPolls
  minR2: number; // FORECAST_MIN_R2, [0, 1]
  minSlopeMbPerS: number; // FORECAST_MIN_SLOPE_MB_PER_S, > 0
  warnSeconds: number; // FORECAST_WARN_SECONDS, > 0
  restartDropMb: number; // FORECAST_RESTART_DROP_MB, > 0
}

export interface SimilarityConfig {
  threshold: number; // SIMILARITY_THRESHOLD, [0, 1]
  durationCapSeconds: number; // SIMILARITY_DURATION_CAP_SECONDS, integer >= 1
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
  memoryLimitMb: number;
  anomaly: AnomalyConfig;
  forecast: ForecastConfig;
  similarity: SimilarityConfig;
}

/**
 * Thrown when a variable is missing or invalid; `variable` names the first
 * offender and `variables` lists every one.
 */
export class ConfigError extends Error {
  readonly variables: string[];

  constructor(
    readonly variable: string,
    message: string,
    variables: string[] = [variable],
  ) {
    super(message);
    this.name = 'ConfigError';
    this.variables = variables;
  }
}

interface ConfigIssue {
  variable: string;
  message: string;
}

/** Reads variables and records problems instead of throwing. */
interface IssueReader {
  issues: ConfigIssue[];
  /** Finite number in an interval; returns undefined (and records an issue) if invalid. */
  number(name: string, fallback: number, rule: 'positive' | 'alpha' | 'unit'): number | undefined;
  /** Positive integer; returns undefined (and records an issue) if invalid. */
  count(name: string, fallback: number): number | undefined;
}

export function readIssues(env: NodeJS.ProcessEnv): IssueReader {
  const issues: ConfigIssue[] = [];
  const fail = (variable: string, message: string): undefined => {
    issues.push({ variable, message });
    return undefined;
  };
  const parse = (name: string, fallback: number): number | undefined => {
    const raw = read(env, name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) return fail(name, `${name} must be a number, got "${raw}"`);
    return value;
  };
  return {
    issues,
    number(name, fallback, rule) {
      const value = parse(name, fallback);
      if (value === undefined) return undefined;
      if (rule === 'positive' && !(value > 0)) {
        return fail(name, `${name} must be greater than 0, got "${value}"`);
      }
      if (rule === 'alpha' && !(value > 0 && value <= 1)) {
        return fail(name, `${name} must be in (0, 1], got "${value}"`);
      }
      if (rule === 'unit' && !(value >= 0 && value <= 1)) {
        return fail(name, `${name} must be in [0, 1], got "${value}"`);
      }
      return value;
    },
    count(name, fallback) {
      const value = parse(name, fallback);
      if (value === undefined) return undefined;
      if (!Number.isInteger(value) || value <= 0) {
        return fail(name, `${name} must be a positive integer, got "${value}"`);
      }
      return value;
    },
  };
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

  const base = {
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

  // Intelligence variables: collect every problem, then throw once.
  const r = readIssues(env);
  const alpha = r.number('ANOMALY_ALPHA', 0.1, 'alpha');
  const zThreshold = r.number('ANOMALY_Z_THRESHOLD', 3, 'positive');
  const warmupPolls = r.count('ANOMALY_WARMUP_POLLS', 30);
  const confirmPolls = r.count('ANOMALY_CONFIRM_POLLS', 2);
  const relearnPolls = r.count('ANOMALY_RELEARN_POLLS', 30);
  const stdLatency = r.number('ANOMALY_MIN_STDDEV_LATENCY_MS', 5, 'positive');
  const stdError = r.number('ANOMALY_MIN_STDDEV_ERROR_RATIO', 0.005, 'positive');
  const stdRss = r.number('ANOMALY_MIN_STDDEV_RSS_MB', 2, 'positive');
  const memoryLimitMb = r.number('MEMORY_LIMIT_MB', 256, 'positive');
  const windowPolls = r.count('FORECAST_WINDOW_POLLS', 15);
  const minSamples = r.count('FORECAST_MIN_SAMPLES', 5);
  const minR2 = r.number('FORECAST_MIN_R2', 0.8, 'unit');
  const minSlopeMbPerS = r.number('FORECAST_MIN_SLOPE_MB_PER_S', 0.05, 'positive');
  const warnSeconds = r.number('FORECAST_WARN_SECONDS', 60, 'positive');
  const restartDropMb = r.number('FORECAST_RESTART_DROP_MB', 20, 'positive');
  const threshold = r.number('SIMILARITY_THRESHOLD', 0.85, 'unit');
  const durationCapSeconds = r.count('SIMILARITY_DURATION_CAP_SECONDS', 300);

  // Cross rules apply only when both sides parsed.
  if (minSamples !== undefined && windowPolls !== undefined && minSamples > windowPolls) {
    r.issues.push({
      variable: 'FORECAST_MIN_SAMPLES',
      message: `FORECAST_MIN_SAMPLES (${minSamples}) must not exceed FORECAST_WINDOW_POLLS (${windowPolls})`,
    });
  }
  if (memoryLimitMb !== undefined && memoryLimitMb <= base.memoryMb.critical) {
    r.issues.push({
      variable: 'MEMORY_LIMIT_MB',
      message: `MEMORY_LIMIT_MB (${memoryLimitMb}) must be greater than MEMORY_CRITICAL_MB (${base.memoryMb.critical})`,
    });
  }
  if (relearnPolls !== undefined && confirmPolls !== undefined && relearnPolls < confirmPolls) {
    r.issues.push({
      variable: 'ANOMALY_RELEARN_POLLS',
      message: `ANOMALY_RELEARN_POLLS (${relearnPolls}) must be at least ANOMALY_CONFIRM_POLLS (${confirmPolls})`,
    });
  }

  if (r.issues.length > 0) {
    throw new ConfigError(
      r.issues[0].variable,
      r.issues.map((i) => i.message).join('; '),
      r.issues.map((i) => i.variable),
    );
  }

  // No issues, so every value above is defined; the checks narrow the types.
  if (
    alpha === undefined || zThreshold === undefined || warmupPolls === undefined ||
    confirmPolls === undefined || relearnPolls === undefined || stdLatency === undefined ||
    stdError === undefined || stdRss === undefined || memoryLimitMb === undefined ||
    windowPolls === undefined || minSamples === undefined || minR2 === undefined ||
    minSlopeMbPerS === undefined || warnSeconds === undefined || restartDropMb === undefined ||
    threshold === undefined || durationCapSeconds === undefined
  ) {
    throw new ConfigError('ENGINE_CONFIG', 'internal error: intelligence config incomplete');
  }

  return {
    ...base,
    memoryLimitMb,
    anomaly: {
      alpha,
      zThreshold,
      warmupPolls,
      confirmPolls,
      relearnPolls,
      minStdDev: { latencyP95Ms: stdLatency, errorRatio: stdError, rssMb: stdRss },
    },
    forecast: { windowPolls, minSamples, minR2, minSlopeMbPerS, warnSeconds, restartDropMb },
    similarity: { threshold, durationCapSeconds },
  };
}
