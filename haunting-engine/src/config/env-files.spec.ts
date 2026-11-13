import { readFileSync } from 'fs';
import { join } from 'path';

// File-check specs: the env examples and docker-compose.yml must agree with
// the documented defaults of the engine-intelligence variables.
// Validates: Requirements R11.11, R11.12, R15.1, R15.2, R15.7

const ENGINE_DIR = join(__dirname, '..', '..');
const REPO_ROOT = join(ENGINE_DIR, '..');

const ENGINE_DEFAULTS: Readonly<Record<string, string>> = {
  ANOMALY_ALPHA: '0.1',
  ANOMALY_Z_THRESHOLD: '3',
  ANOMALY_WARMUP_POLLS: '30',
  ANOMALY_CONFIRM_POLLS: '2',
  ANOMALY_RELEARN_POLLS: '30',
  ANOMALY_MIN_STDDEV_LATENCY_MS: '5',
  ANOMALY_MIN_STDDEV_ERROR_RATIO: '0.005',
  ANOMALY_MIN_STDDEV_RSS_MB: '2',
  MEMORY_LIMIT_MB: '290',
  FORECAST_WINDOW_POLLS: '15',
  FORECAST_MIN_SAMPLES: '5',
  FORECAST_MIN_R2: '0.8',
  FORECAST_MIN_SLOPE_MB_PER_S: '0.05',
  FORECAST_WARN_SECONDS: '60',
  FORECAST_RESTART_DROP_MB: '20',
  SIMILARITY_THRESHOLD: '0.85',
  SIMILARITY_DURATION_CAP_SECONDS: '300',
};

const INTEGRATION_DEFAULTS: Readonly<Record<string, string>> = {
  INTEGRATION_LEAK_TIMEOUT_SECONDS: '300',
  INTEGRATION_MIN_LEAD_SECONDS: '10',
};

const VICTIM_DEFAULTS: Readonly<Record<string, string>> = {
  LEAK_MB_PER_SECOND: '2',
  MEMORY_GAUGE_INTERVAL_MS: '1000',
};

/** Parses active (uncommented) KEY=value lines of a .env file. */
function parseEnvFile(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0) result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return result;
}

/** Extracts the `environment:` block of one compose service as KEY -> raw value. */
function composeEnvironment(compose: string, service: string): Record<string, string> {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${service}:`);
  if (start < 0) throw new Error(`service ${service} not found in docker-compose.yml`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start + 1, end);
  const envStart = block.findIndex((l) => l === '    environment:');
  if (envStart < 0) throw new Error(`service ${service} has no environment block`);
  const env: Record<string, string> = {};
  for (let i = envStart + 1; i < block.length; i++) {
    const m = /^ {6}([A-Z0-9_]+):\s*(.*)$/.exec(block[i]);
    if (!m) break;
    env[m[1]] = m[2].trim();
  }
  return env;
}

/** Returns the raw value of a top-level key (such as `mem_limit`) of one compose service. */
function composeServiceKey(compose: string, service: string, key: string): string | undefined {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${service}:`);
  if (start < 0) throw new Error(`service ${service} not found in docker-compose.yml`);
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) break;
    const m = new RegExp(`^ {4}${key}:\\s*(.*)$`).exec(lines[i]);
    if (m) return m[1].trim();
  }
  return undefined;
}

describe('env files and docker-compose.yml', () => {
  const engineEnv = parseEnvFile(join(ENGINE_DIR, '.env.example'));
  const victimEnv = parseEnvFile(join(REPO_ROOT, 'victim-app', '.env.example'));
  const compose = readFileSync(join(REPO_ROOT, 'docker-compose.yml'), 'utf8');

  describe('haunting-engine/.env.example', () => {
    it('lists all 17 engine-intelligence variables with their documented defaults', () => {
      expect(Object.keys(ENGINE_DEFAULTS)).toHaveLength(17);
      for (const [name, value] of Object.entries(ENGINE_DEFAULTS)) {
        expect({ name, value: engineEnv[name] }).toEqual({ name, value });
      }
    });

    it('lists the two INTEGRATION_* variables with their defaults', () => {
      for (const [name, value] of Object.entries(INTEGRATION_DEFAULTS)) {
        expect({ name, value: engineEnv[name] }).toEqual({ name, value });
      }
    });
  });

  describe('victim-app/.env.example', () => {
    it('lists the leak and gauge variables with their defaults', () => {
      for (const [name, value] of Object.entries(VICTIM_DEFAULTS)) {
        expect({ name, value: victimEnv[name] }).toEqual({ name, value });
      }
    });
  });

  describe('docker-compose.yml', () => {
    const engineCompose = composeEnvironment(compose, 'haunting-engine');

    it('passes every engine variable as ${NAME:-default} with the documented default', () => {
      for (const [name, value] of Object.entries(ENGINE_DEFAULTS)) {
        expect({ name, value: engineCompose[name] }).toEqual({
          name,
          value: `\${${name}:-${value}}`,
        });
      }
    });

    it('does not pass the INTEGRATION_* variables to any service', () => {
      for (const name of Object.keys(INTEGRATION_DEFAULTS)) {
        expect(compose).not.toContain(name);
      }
    });

    it.each(['gateway', 'orders', 'payments'])(
      'sets the leak and gauge variables with defaults on %s',
      (service) => {
        const env = composeEnvironment(compose, service);
        for (const [name, value] of Object.entries(VICTIM_DEFAULTS)) {
          expect({ name, value: env[name] }).toEqual({
            name,
            value: `\${${name}:-${value}}`,
          });
        }
      },
    );

    it.each([
      ['gateway', 'GATEWAY'],
      ['orders', 'ORDERS'],
      ['payments', 'PAYMENTS'],
    ])(
      'gives %s a no-swap memory limit and a 240 s chaos TTL so a leak ends in an OOM kill',
      (service, prefix) => {
        const memLimit = `\${${prefix}_MEM_LIMIT:-256m}`;
        expect(composeServiceKey(compose, service, 'mem_limit')).toBe(memLimit);
        expect(composeServiceKey(compose, service, 'memswap_limit')).toBe(memLimit);
        expect(composeEnvironment(compose, service)['CHAOS_TTL_SECONDS']).toBe(
          `\${${prefix}_CHAOS_TTL_SECONDS:-240}`,
        );
        expect(victimEnv[`${prefix}_MEM_LIMIT`]).toBe('256m');
        expect(victimEnv[`${prefix}_CHAOS_TTL_SECONDS`]).toBe('240');
      },
    );

    it('keeps compose defaults identical to the .env.example values', () => {
      for (const name of Object.keys(ENGINE_DEFAULTS)) {
        expect(engineCompose[name]).toBe(`\${${name}:-${engineEnv[name]}}`);
      }
      for (const name of Object.keys(VICTIM_DEFAULTS)) {
        expect(composeEnvironment(compose, 'payments')[name]).toBe(
          `\${${name}:-${victimEnv[name]}}`,
        );
      }
    });
  });
});
