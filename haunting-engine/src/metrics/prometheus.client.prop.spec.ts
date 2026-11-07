import * as fc from 'fast-check';
import { parseVector } from './prometheus.client';

const NUM_RUNS = 200;

/** Sample values: any double as text, Prometheus's special values, or arbitrary text. */
const sampleValueArb = fc.oneof(
  fc.double().map(String),
  fc.constantFrom('NaN', '+Inf', '-Inf'),
  fc.string(),
);

/** A well-formed instant-vector response with one series per label and these sample values. */
function vectorBody(samples: [label: string, value: unknown][], labelKey = 'service'): unknown {
  return {
    status: 'success',
    data: {
      resultType: 'vector',
      result: samples.map(([label, value], i) => ({
        metric: { __name__: 'm', [labelKey]: label, instance: `host-${i}` },
        value: [1_700_000_000.123, value],
      })),
    },
  };
}

/** Unique label values with one sample each. */
function samplesArb<T>(valueArb: fc.Arbitrary<T>): fc.Arbitrary<[string, T][]> {
  return fc.uniqueArray(fc.tuple(fc.string({ minLength: 1 }), valueArb), {
    selector: ([label]) => label,
    maxLength: 10,
  });
}

/** Jest's toBe tells 0 from -0; a sample of "-0" is just zero. */
const normalise = (n: number | null | undefined) => (n === 0 ? 0 : n);

describe('parseVector — property-based tests (Property 9)', () => {
  // Feature: haunting-engine, Property 9: Prometheus parsing never throws on sample values
  it('Property 9: never throws, and every series with the label gets a number or null', () => {
    fc.assert(
      fc.property(samplesArb(sampleValueArb), (samples) => {
        const vector = parseVector(vectorBody(samples), 'service');
        expect([...vector.keys()].sort()).toEqual(samples.map(([label]) => label).sort());
        for (const v of vector.values()) {
          if (v !== null) expect(Number.isFinite(v)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 9: Prometheus parsing never throws on sample values
  it('Property 9: a double written as text parses to that double when finite, and null otherwise', () => {
    fc.assert(
      fc.property(samplesArb(fc.double()), (samples) => {
        const vector = parseVector(
          vectorBody(samples.map(([label, d]) => [label, String(d)])),
          'service',
        );
        for (const [label, d] of samples) {
          expect(normalise(vector.get(label))).toBe(Number.isFinite(d) ? normalise(d) : null);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 9: Prometheus parsing never throws on sample values
  it('Property 9: NaN, +Inf and -Inf become null', () => {
    fc.assert(
      fc.property(samplesArb(fc.constantFrom('NaN', '+Inf', '-Inf')), (samples) => {
        const vector = parseVector(vectorBody(samples), 'service');
        for (const [label] of samples) expect(vector.get(label)).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 9: Prometheus parsing never throws on sample values
  it('Property 9: decimal and exponent forms parse to their number', () => {
    // Shapes Prometheus or Go's float formatting can produce, e.g. "-12", "3.", ".5", "1.5e-07".
    const decimalArb = fc
      .tuple(
        fc.constantFrom('', '+', '-'),
        fc.oneof(
          fc.stringMatching(/^\d{1,8}$/),
          fc.stringMatching(/^\d{1,8}\.\d{0,8}$/),
          fc.stringMatching(/^\.\d{1,8}$/),
        ),
        fc.option(fc.stringMatching(/^[eE][+-]?\d{1,2}$/), { nil: '' }),
      )
      .map((parts) => parts.join(''));
    fc.assert(
      fc.property(samplesArb(decimalArb), (samples) => {
        const vector = parseVector(vectorBody(samples), 'service');
        for (const [label, text] of samples) {
          expect(normalise(vector.get(label))).toBe(normalise(Number(text)));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 9: Prometheus parsing never throws on sample values
  it('Property 9: text that is not a decimal number becomes null, even if Number() would accept it', () => {
    const nonNumericArb = fc.oneof(
      // Any text with a character that can't appear in a decimal number.
      fc.string({ minLength: 1 }).filter((s) => /[^0-9+\-.eE]/.test(s)),
      fc.constantFrom('', ' ', ' 12', '12 ', '0x10', '0b11', '0o7', 'Infinity', '-Infinity', '1_000', '.', '+', 'e5', '1e', '1e999'),
    );
    fc.assert(
      fc.property(samplesArb(nonNumericArb), (samples) => {
        const vector = parseVector(vectorBody(samples), 'service');
        for (const [label] of samples) expect(vector.get(label)).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 9: Prometheus parsing never throws on sample values
  it('Property 9: a malformed sample field becomes null instead of throwing', () => {
    // The [timestamp, value] pair itself can be missing, the wrong length, or hold a non-string.
    const malformedArb = fc.oneof(
      fc.anything().filter((v) => !Array.isArray(v)),
      fc.array(fc.anything(), { maxLength: 1 }),
      fc.tuple(fc.anything(), fc.anything().filter((v) => typeof v !== 'string')),
    );
    fc.assert(
      fc.property(samplesArb(malformedArb), (samples) => {
        const body = {
          status: 'success',
          data: {
            resultType: 'vector',
            result: samples.map(([label, value]) => ({ metric: { service: label }, value })),
          },
        };
        const vector = parseVector(body, 'service');
        for (const [label] of samples) expect(vector.get(label)).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: haunting-engine, Property 9: Prometheus parsing never throws on sample values
  it('Property 9: series are keyed by the requested label, and series without it are skipped', () => {
    fc.assert(
      fc.property(
        samplesArb(sampleValueArb),
        samplesArb(sampleValueArb),
        (withJob, withService) => {
          const body = vectorBody(withJob, 'job') as { data: { result: unknown[] } };
          body.data.result.push(...(vectorBody(withService, 'service') as typeof body).data.result);
          const vector = parseVector(body, 'job');
          expect([...vector.keys()].sort()).toEqual(withJob.map(([label]) => label).sort());
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
