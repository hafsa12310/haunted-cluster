import * as fc from 'fast-check';
import { isExcludedRoute } from './is-excluded-route';

// Feature: victim-app, Property 7: excluded routes are never affected by chaos

describe('isExcludedRoute — property-based tests', () => {
  /**
   * Property 7a: Known excluded routes always return true.
   * Validates: Requirements 7.6
   */
  it('Property 7a — known excluded routes always return true', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          '/metrics',
          '/health',
          '/chaos/',
          '/chaos/state',
          '/chaos/reset',
          '/chaos/latency',
          '/chaos/error-rate',
          '/chaos/memory-leak',
          '/chaos/crash',
        ),
        (path) => {
          expect(isExcludedRoute(path)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 7b: Arbitrary /chaos/* sub-paths always return true.
   * Validates: Requirements 7.6
   */
  it('Property 7b — arbitrary /chaos/* sub-paths always return true', () => {
    fc.assert(
      fc.property(
        fc.string().map((s) => `/chaos/${s}`),
        (path) => {
          expect(isExcludedRoute(path)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 7c: Non-excluded routes always return false.
   * Validates: Requirements 7.6
   */
  it('Property 7c — non-excluded routes always return false', () => {
    fc.assert(
      fc.property(
        fc
          .string()
          .filter(
            (s) =>
              s !== '/metrics' &&
              s !== '/health' &&
              !s.startsWith('/chaos/'),
          ),
        (path) => {
          expect(isExcludedRoute(path)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
