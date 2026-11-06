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
