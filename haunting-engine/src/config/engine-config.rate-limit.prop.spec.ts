import * as fc from 'fast-check';
import { ConfigError, loadEngineConfig } from './engine-config';

/** The smallest env that loads: only the required variables for the default chain. */
const REQUIRED_ENV: Readonly<Record<string, string>> = {
  PROMETHEUS_URL: 'http://prometheus:9090',
  GATEWAY_URL: 'http://gateway:3000',
  ORDERS_URL: 'http://orders:3001',
  PAYMENTS_URL: 'http://payments:3002',
};

const STRICT = /^[1-9]\d*$/;
const NUM_RUNS = 100;

type Variable = 'CHAOS_RATE_LIMIT_MAX' | 'CHAOS_RATE_LIMIT_WINDOW_SECONDS';

const variables = fc.constantFrom<Variable>(
  'CHAOS_RATE_LIMIT_MAX',
  'CHAOS_RATE_LIMIT_WINDOW_SECONDS',
);

/** A fresh env object per call, so `process.env` is never touched. */
function envWith(name: Variable, value: string): NodeJS.ProcessEnv {
  return { ...REQUIRED_ENV, [name]: value };
}

function fieldFor(name: Variable, env: NodeJS.ProcessEnv): number {
  const { chaosRateLimit } = loadEngineConfig(env);
  return name === 'CHAOS_RATE_LIMIT_MAX' ? chaosRateLimit.max : chaosRateLimit.windowSeconds;
}

/** Non-blank strings that fail the strict pattern: arbitrary text plus targeted shapes. */
const invalidValue: fc.Arbitrary<string> = fc
  .oneof(
    fc.string({ maxLength: 20 }),
    fc.integer({ min: -1_000_000, max: 0 }).map(String), // zero and negatives
    fc.double({ noNaN: true, noDefaultInfinity: true }).map(String), // decimals, exponents
    fc.integer({ min: 1, max: 1_000_000 }).map((n) => `0${n}`), // leading zero
    fc.integer({ min: 1, max: 1_000_000 }).map((n) => `+${n}`),
    fc.integer({ min: 1, max: 1_000_000 }).map((n) => ` ${n} `), // padding
    fc.integer({ min: 1, max: 1_000_000 }).map((n) => `${n}.5`),
    fc.integer({ min: 1, max: 1_000 }).map((n) => `${n}e2`),
    fc.integer({ min: 1, max: 255 }).map((n) => `0x${n.toString(16)}`),
  )
  .filter((s) => !STRICT.test(s) && s.trim() !== '');

describe('rate-limit configuration (property)', () => {
  // Feature: haunted-house, Property 37: Rate-limit configuration rejects non-positive-integers
  // **Validates: Requirements 9.7, 9.8**
  it('rejects any non-blank value that is not a positive integer, naming the variable', () => {
    fc.assert(
      fc.property(variables, invalidValue, (name, value) => {
        let thrown: unknown;
        try {
          loadEngineConfig(envWith(name, value));
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(ConfigError);
        const configError = thrown as ConfigError;
        expect(configError.variables).toContain(name);
        expect(configError.message).toContain(name);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunted-house, Property 37: Rate-limit configuration rejects non-positive-integers
  // **Validates: Requirements 9.7, 9.8**
  it('accepts any strict positive integer string and parses it to that number', () => {
    fc.assert(
      fc.property(variables, fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), (name, n) => {
        const raw = String(n);
        expect(STRICT.test(raw)).toBe(true);
        expect(fieldFor(name, envWith(name, raw))).toBe(n);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunted-house, Property 37: Rate-limit configuration rejects non-positive-integers
  // **Validates: Requirements 9.7, 9.8**
  it('uses the default when the variable is unset or blank', () => {
    const blank = fc.stringOf(fc.constantFrom(' ', '\t', '\n'), { maxLength: 6 });
    fc.assert(
      fc.property(variables, blank, (name, value) => {
        const expected = name === 'CHAOS_RATE_LIMIT_MAX' ? 5 : 60;
        expect(fieldFor(name, envWith(name, value))).toBe(expected);
        expect(fieldFor(name, { ...REQUIRED_ENV })).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
