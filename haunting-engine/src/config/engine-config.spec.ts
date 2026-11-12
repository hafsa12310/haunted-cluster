import { ConfigError, EngineConfig, loadEngineConfig, serviceUrlVariable } from './engine-config';

/** The smallest env that loads: only the required variables for the default chain. */
const REQUIRED_ENV: NodeJS.ProcessEnv = {
  PROMETHEUS_URL: 'http://prometheus:9090',
  GATEWAY_URL: 'http://gateway:3000',
  ORDERS_URL: 'http://orders:3001',
  PAYMENTS_URL: 'http://payments:3002',
};

function load(overrides: NodeJS.ProcessEnv = {}): EngineConfig {
  return loadEngineConfig({ ...REQUIRED_ENV, ...overrides });
}

/** Runs `fn`, asserts it throws a ConfigError, and returns it. */
function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error('expected a ConfigError, but nothing was thrown');
}

describe('loadEngineConfig', () => {
  describe('defaults (Requirement 13.2)', () => {
    it('applies every documented default when only required variables are set', () => {
      expect(load()).toEqual<EngineConfig>({
        port: 4000,
        prometheusUrl: 'http://prometheus:9090',
        serviceChain: ['gateway', 'orders', 'payments'],
        serviceUrls: {
          gateway: 'http://gateway:3000',
          orders: 'http://orders:3001',
          payments: 'http://payments:3002',
        },
        pollIntervalMs: 2000,
        rateWindow: '15s',
        prometheusTimeoutMs: 1500,
        latencyMs: { ok: 100, critical: 1000 },
        errorRatio: { ok: 0.01, critical: 0.2 },
        memoryMb: { ok: 120, critical: 230 },
        openAfterPolls: 2,
        closeAfterPolls: 3,
        incidentHistoryLimit: 50,
        chaosEvidenceWindowSeconds: 150,
        chaosProxyTimeoutMs: 3000,
        corsOrigin: 'http://localhost:3100',
        memoryLimitMb: 256,
        anomaly: {
          alpha: 0.1,
          zThreshold: 3,
          warmupPolls: 30,
          confirmPolls: 2,
          relearnPolls: 30,
          minStdDev: { latencyP95Ms: 5, errorRatio: 0.005, rssMb: 2 },
        },
        forecast: {
          windowPolls: 15,
          minSamples: 5,
          minR2: 0.8,
          minSlopeMbPerS: 0.05,
          warnSeconds: 60,
          restartDropMb: 20,
        },
        similarity: { threshold: 0.85, durationCapSeconds: 300 },
      });
    });

    it('treats blank values as unset', () => {
      const config = load({ PORT: '   ', RATE_WINDOW: '', CORS_ORIGIN: ' ' });
      expect(config.port).toBe(4000);
      expect(config.rateWindow).toBe('15s');
      expect(config.corsOrigin).toBe('http://localhost:3100');
    });

    it('reads overrides in place of defaults', () => {
      const config = load({
        PORT: '4100',
        POLL_INTERVAL_MS: '500',
        RATE_WINDOW: '2m',
        LATENCY_OK_MS: '50',
        LATENCY_CRITICAL_MS: '400',
        ERROR_RATIO_OK: '0.05',
        ERROR_RATIO_CRITICAL: '0.5',
        CORS_ORIGIN: 'http://localhost:5173',
      });
      expect(config.port).toBe(4100);
      expect(config.pollIntervalMs).toBe(500);
      expect(config.rateWindow).toBe('2m');
      expect(config.latencyMs).toEqual({ ok: 50, critical: 400 });
      expect(config.errorRatio).toEqual({ ok: 0.05, critical: 0.5 });
      expect(config.corsOrigin).toBe('http://localhost:5173');
    });

    it('strips trailing slashes from URLs', () => {
      const config = load({ PROMETHEUS_URL: 'http://prometheus:9090/', ORDERS_URL: 'http://orders:3001//' });
      expect(config.prometheusUrl).toBe('http://prometheus:9090');
      expect(config.serviceUrls.orders).toBe('http://orders:3001');
    });
  });

  describe('required variables (Requirement 13.1)', () => {
    it.each(Object.keys(REQUIRED_ENV))('throws a ConfigError naming %s when it is missing', (name) => {
      const env = { ...REQUIRED_ENV };
      delete env[name];
      const error = configError(() => loadEngineConfig(env));
      expect(error.variable).toBe(name);
      expect(error.message).toContain(name);
    });

    it.each(Object.keys(REQUIRED_ENV))('throws a ConfigError naming %s when it is blank', (name) => {
      const error = configError(() => load({ [name]: '  ' }));
      expect(error.variable).toBe(name);
    });
  });

  describe('threshold pairs (Requirement 13.3)', () => {
    it.each([
      ['LATENCY_OK_MS', 'LATENCY_CRITICAL_MS', '1000', '1000'],
      ['LATENCY_OK_MS', 'LATENCY_CRITICAL_MS', '500', '200'],
      ['ERROR_RATIO_OK', 'ERROR_RATIO_CRITICAL', '0.2', '0.2'],
      ['ERROR_RATIO_OK', 'ERROR_RATIO_CRITICAL', '0.5', '0.1'],
      ['MEMORY_OK_MB', 'MEMORY_CRITICAL_MB', '230', '230'],
      ['MEMORY_OK_MB', 'MEMORY_CRITICAL_MB', '300', '120'],
    ])('rejects %s >= %s (%s, %s)', (okName, criticalName, ok, critical) => {
      const error = configError(() => load({ [okName]: ok, [criticalName]: critical }));
      expect(error.variable).toBe(okName);
      expect(error.message).toContain(criticalName);
    });

    it('rejects an OK override that reaches the default CRITICAL', () => {
      const error = configError(() => load({ MEMORY_OK_MB: '230' }));
      expect(error.variable).toBe('MEMORY_OK_MB');
    });
  });

  describe('numeric variables (Requirement 13.3)', () => {
    it.each([
      'PORT',
      'POLL_INTERVAL_MS',
      'PROMETHEUS_TIMEOUT_MS',
      'LATENCY_OK_MS',
      'LATENCY_CRITICAL_MS',
      'ERROR_RATIO_OK',
      'ERROR_RATIO_CRITICAL',
      'MEMORY_OK_MB',
      'MEMORY_CRITICAL_MB',
      'OPEN_AFTER_POLLS',
      'CLOSE_AFTER_POLLS',
      'INCIDENT_HISTORY_LIMIT',
      'CHAOS_EVIDENCE_WINDOW_SECONDS',
      'CHAOS_PROXY_TIMEOUT_MS',
    ])('rejects a non-numeric %s', (name) => {
      const error = configError(() => load({ [name]: 'abc' }));
      expect(error.variable).toBe(name);
      expect(error.message).toContain('abc');
    });

    it.each(['Infinity', 'NaN', '12abc'])('rejects the non-finite or malformed value %s', (value) => {
      const error = configError(() => load({ POLL_INTERVAL_MS: value }));
      expect(error.variable).toBe('POLL_INTERVAL_MS');
    });

    it.each([
      ['OPEN_AFTER_POLLS', '0'],
      ['CLOSE_AFTER_POLLS', '-1'],
      ['INCIDENT_HISTORY_LIMIT', '2.5'],
      ['PORT', '0'],
    ])('rejects %s=%s because it must be a positive integer', (name, value) => {
      const error = configError(() => load({ [name]: value }));
      expect(error.variable).toBe(name);
    });
  });

  describe('RATE_WINDOW', () => {
    it.each(['30s', '2m', '1h'])('accepts %s', (value) => {
      expect(load({ RATE_WINDOW: value }).rateWindow).toBe(value);
    });

    it.each(['15', 's', '15ms', '1d', '1.5m', '-15s', '15 s'])('rejects %s', (value) => {
      const error = configError(() => load({ RATE_WINDOW: value }));
      expect(error.variable).toBe('RATE_WINDOW');
    });
  });

  describe('SERVICE_CHAIN', () => {
    it('rejects duplicate entries', () => {
      const error = configError(() => load({ SERVICE_CHAIN: 'gateway,orders,gateway' }));
      expect(error.variable).toBe('SERVICE_CHAIN');
      expect(error.message).toContain('gateway');
    });

    it('rejects duplicates that differ only by surrounding whitespace', () => {
      const error = configError(() => load({ SERVICE_CHAIN: 'gateway, orders ,orders' }));
      expect(error.variable).toBe('SERVICE_CHAIN');
    });

    it.each(['gateway,,payments', ',gateway', 'gateway,'])('rejects the empty entry in "%s"', (value) => {
      const error = configError(() => load({ SERVICE_CHAIN: value }));
      expect(error.variable).toBe('SERVICE_CHAIN');
    });

    it('derives <SERVICE>_URL for a custom chain', () => {
      const config = loadEngineConfig({
        PROMETHEUS_URL: 'http://prometheus:9090',
        SERVICE_CHAIN: 'edge, checkout-api',
        EDGE_URL: 'http://edge:8080',
        CHECKOUT_API_URL: 'http://checkout-api:8081',
      });
      expect(config.serviceChain).toEqual(['edge', 'checkout-api']);
      expect(config.serviceUrls).toEqual({
        edge: 'http://edge:8080',
        'checkout-api': 'http://checkout-api:8081',
      });
    });

    it('requires the derived URL variable for each custom chain entry', () => {
      const error = configError(() =>
        loadEngineConfig({
          PROMETHEUS_URL: 'http://prometheus:9090',
          SERVICE_CHAIN: 'edge,checkout-api',
          EDGE_URL: 'http://edge:8080',
        }),
      );
      expect(error.variable).toBe('CHECKOUT_API_URL');
    });

    it('does not require URLs for services outside the chain', () => {
      const config = loadEngineConfig({
        PROMETHEUS_URL: 'http://prometheus:9090',
        SERVICE_CHAIN: 'orders',
        ORDERS_URL: 'http://orders:3001',
      });
      expect(config.serviceUrls).toEqual({ orders: 'http://orders:3001' });
    });
  });
});

describe('serviceUrlVariable', () => {
  it.each([
    ['gateway', 'GATEWAY_URL'],
    ['checkout-api', 'CHECKOUT_API_URL'],
    ['a-b-c', 'A_B_C_URL'],
  ])('maps %s to %s', (service, variable) => {
    expect(serviceUrlVariable(service)).toBe(variable);
  });
});

describe('loadEngineConfig: engine-intelligence variables (Requirements 11.1-11.10)', () => {
  describe('defaults', () => {
    const config = load();

    it.each<[string, () => number, number]>([
      ['ANOMALY_ALPHA', () => config.anomaly.alpha, 0.1],
      ['ANOMALY_Z_THRESHOLD', () => config.anomaly.zThreshold, 3],
      ['ANOMALY_WARMUP_POLLS', () => config.anomaly.warmupPolls, 30],
      ['ANOMALY_CONFIRM_POLLS', () => config.anomaly.confirmPolls, 2],
      ['ANOMALY_RELEARN_POLLS', () => config.anomaly.relearnPolls, 30],
      ['ANOMALY_MIN_STDDEV_LATENCY_MS', () => config.anomaly.minStdDev.latencyP95Ms, 5],
      ['ANOMALY_MIN_STDDEV_ERROR_RATIO', () => config.anomaly.minStdDev.errorRatio, 0.005],
      ['ANOMALY_MIN_STDDEV_RSS_MB', () => config.anomaly.minStdDev.rssMb, 2],
      ['MEMORY_LIMIT_MB', () => config.memoryLimitMb, 256],
      ['FORECAST_WINDOW_POLLS', () => config.forecast.windowPolls, 15],
      ['FORECAST_MIN_SAMPLES', () => config.forecast.minSamples, 5],
      ['FORECAST_MIN_R2', () => config.forecast.minR2, 0.8],
      ['FORECAST_MIN_SLOPE_MB_PER_S', () => config.forecast.minSlopeMbPerS, 0.05],
      ['FORECAST_WARN_SECONDS', () => config.forecast.warnSeconds, 60],
      ['FORECAST_RESTART_DROP_MB', () => config.forecast.restartDropMb, 20],
      ['SIMILARITY_THRESHOLD', () => config.similarity.threshold, 0.85],
      ['SIMILARITY_DURATION_CAP_SECONDS', () => config.similarity.durationCapSeconds, 300],
    ])('defaults %s', (_name, actual, expected) => {
      expect(actual()).toBe(expected);
    });

    it('treats a blank value as unset', () => {
      expect(load({ ANOMALY_ALPHA: '  ', FORECAST_MIN_R2: '' }).anomaly.alpha).toBe(0.1);
      expect(load({ FORECAST_MIN_R2: '' }).forecast.minR2).toBe(0.8);
    });
  });

  describe('overrides', () => {
    it.each<[string, string, (c: EngineConfig) => number, number]>([
      ['ANOMALY_ALPHA', '0.5', (c) => c.anomaly.alpha, 0.5],
      ['ANOMALY_Z_THRESHOLD', '4.5', (c) => c.anomaly.zThreshold, 4.5],
      ['ANOMALY_WARMUP_POLLS', '10', (c) => c.anomaly.warmupPolls, 10],
      ['ANOMALY_CONFIRM_POLLS', '3', (c) => c.anomaly.confirmPolls, 3],
      ['ANOMALY_RELEARN_POLLS', '40', (c) => c.anomaly.relearnPolls, 40],
      ['ANOMALY_MIN_STDDEV_LATENCY_MS', '7', (c) => c.anomaly.minStdDev.latencyP95Ms, 7],
      ['ANOMALY_MIN_STDDEV_ERROR_RATIO', '0.01', (c) => c.anomaly.minStdDev.errorRatio, 0.01],
      ['ANOMALY_MIN_STDDEV_RSS_MB', '3', (c) => c.anomaly.minStdDev.rssMb, 3],
      ['MEMORY_LIMIT_MB', '512', (c) => c.memoryLimitMb, 512],
      ['FORECAST_WINDOW_POLLS', '20', (c) => c.forecast.windowPolls, 20],
      ['FORECAST_MIN_SAMPLES', '4', (c) => c.forecast.minSamples, 4],
      ['FORECAST_MIN_R2', '0.9', (c) => c.forecast.minR2, 0.9],
      ['FORECAST_MIN_SLOPE_MB_PER_S', '0.1', (c) => c.forecast.minSlopeMbPerS, 0.1],
      ['FORECAST_WARN_SECONDS', '90', (c) => c.forecast.warnSeconds, 90],
      ['FORECAST_RESTART_DROP_MB', '30', (c) => c.forecast.restartDropMb, 30],
      ['SIMILARITY_THRESHOLD', '0.7', (c) => c.similarity.threshold, 0.7],
      ['SIMILARITY_DURATION_CAP_SECONDS', '600', (c) => c.similarity.durationCapSeconds, 600],
    ])('uses a valid %s=%s instead of the default', (name, value, pick, expected) => {
      expect(pick(load({ [name]: value }))).toBe(expected);
    });

    it('accepts the interval endpoints', () => {
      expect(load({ ANOMALY_ALPHA: '1' }).anomaly.alpha).toBe(1);
      expect(load({ FORECAST_MIN_R2: '0' }).forecast.minR2).toBe(0);
      expect(load({ FORECAST_MIN_R2: '1' }).forecast.minR2).toBe(1);
      expect(load({ SIMILARITY_THRESHOLD: '0' }).similarity.threshold).toBe(0);
      expect(load({ SIMILARITY_THRESHOLD: '1' }).similarity.threshold).toBe(1);
    });
  });

  describe('rejections', () => {
    it.each(['0', '1.5', 'abc'])('rejects ANOMALY_ALPHA=%s', (value) => {
      const error = configError(() => load({ ANOMALY_ALPHA: value }));
      expect(error.variable).toBe('ANOMALY_ALPHA');
      expect(error.variables).toEqual(['ANOMALY_ALPHA']);
      expect(error.message).toContain('ANOMALY_ALPHA');
    });

    it.each(['FORECAST_MIN_R2', 'SIMILARITY_THRESHOLD'])('rejects %s outside [0, 1]', (name) => {
      for (const value of ['-0.1', '1.1']) {
        const error = configError(() => load({ [name]: value }));
        expect(error.variable).toBe(name);
        expect(error.message).toContain(name);
      }
    });

    const countVariables = [
      'ANOMALY_WARMUP_POLLS',
      'ANOMALY_CONFIRM_POLLS',
      'ANOMALY_RELEARN_POLLS',
      'FORECAST_WINDOW_POLLS',
      'FORECAST_MIN_SAMPLES',
      'SIMILARITY_DURATION_CAP_SECONDS',
    ];
    it.each(countVariables)('rejects %s of 0, 2.5 and -1', (name) => {
      for (const value of ['0', '2.5', '-1']) {
        const error = configError(() => load({ [name]: value }));
        expect(error.variable).toBe(name);
        expect(error.message).toContain(name);
      }
    });

    const positiveVariables = [
      'ANOMALY_Z_THRESHOLD',
      'ANOMALY_MIN_STDDEV_LATENCY_MS',
      'ANOMALY_MIN_STDDEV_ERROR_RATIO',
      'ANOMALY_MIN_STDDEV_RSS_MB',
      'MEMORY_LIMIT_MB',
      'FORECAST_MIN_SLOPE_MB_PER_S',
      'FORECAST_WARN_SECONDS',
      'FORECAST_RESTART_DROP_MB',
    ];
    it.each(positiveVariables)('rejects %s of 0, -1, NaN and Infinity', (name) => {
      for (const value of ['0', '-1', 'NaN', 'Infinity']) {
        const error = configError(() => load({ [name]: value }));
        expect(error.variable).toBe(name);
        expect(error.message).toContain(name);
      }
    });
  });

  describe('cross rules', () => {
    it('rejects FORECAST_MIN_SAMPLES above FORECAST_WINDOW_POLLS', () => {
      const error = configError(() => load({ FORECAST_MIN_SAMPLES: '10', FORECAST_WINDOW_POLLS: '5' }));
      expect(error.variable).toBe('FORECAST_MIN_SAMPLES');
      expect(error.message).toContain('FORECAST_WINDOW_POLLS');
    });

    it('accepts FORECAST_MIN_SAMPLES equal to FORECAST_WINDOW_POLLS', () => {
      const config = load({ FORECAST_MIN_SAMPLES: '5', FORECAST_WINDOW_POLLS: '5' });
      expect(config.forecast.minSamples).toBe(5);
      expect(config.forecast.windowPolls).toBe(5);
    });

    it.each(['230', '200'])('rejects MEMORY_LIMIT_MB=%s at or below MEMORY_CRITICAL_MB (230)', (value) => {
      const error = configError(() => load({ MEMORY_LIMIT_MB: value, MEMORY_CRITICAL_MB: '230' }));
      expect(error.variable).toBe('MEMORY_LIMIT_MB');
      expect(error.message).toContain('MEMORY_CRITICAL_MB');
    });

    it('rejects ANOMALY_RELEARN_POLLS below ANOMALY_CONFIRM_POLLS', () => {
      const error = configError(() => load({ ANOMALY_RELEARN_POLLS: '1', ANOMALY_CONFIRM_POLLS: '2' }));
      expect(error.variable).toBe('ANOMALY_RELEARN_POLLS');
      expect(error.message).toContain('ANOMALY_CONFIRM_POLLS');
    });

    it('accepts ANOMALY_RELEARN_POLLS equal to ANOMALY_CONFIRM_POLLS', () => {
      const config = load({ ANOMALY_RELEARN_POLLS: '2', ANOMALY_CONFIRM_POLLS: '2' });
      expect(config.anomaly.relearnPolls).toBe(2);
      expect(config.anomaly.confirmPolls).toBe(2);
    });
  });

  describe('multiple offenders', () => {
    it('reports every invalid variable, with the first offender as `variable`', () => {
      const error = configError(() =>
        load({
          ANOMALY_ALPHA: '0',
          FORECAST_WARN_SECONDS: '-1',
          SIMILARITY_DURATION_CAP_SECONDS: '2.5',
        }),
      );
      const names = ['ANOMALY_ALPHA', 'FORECAST_WARN_SECONDS', 'SIMILARITY_DURATION_CAP_SECONDS'];
      expect(error.variable).toBe('ANOMALY_ALPHA');
      expect(error.variables).toEqual(expect.arrayContaining(names));
      expect(error.variables).toHaveLength(3);
      for (const name of names) expect(error.message).toContain(name);
    });
  });
});
