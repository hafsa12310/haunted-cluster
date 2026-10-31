/**
 * Returns true if the given request path is an excluded operational route.
 *
 * Excluded routes are never instrumented for metrics and are never affected
 * by chaos injection:
 *  - /metrics
 *  - /health
 *  - any path under /chaos/ (e.g. /chaos/state, /chaos/reset)
 *
 * Used by both MetricsInterceptor and ChaosInterceptor.
 *
 * Requirements: 7.6
 */
export function isExcludedRoute(path: string): boolean {
  return path === '/metrics' || path === '/health' || path.startsWith('/chaos/');
}
