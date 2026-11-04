/**
 * End-to-end smoke test against a running stack. Not part of `npm test`; run
 * with `npm run test:e2e`.
 *
 * Requirements: 9.1, 2.2
 */
import { SERVICES, postJson, waitForStack } from './helpers';

/** Sums every `http_requests_total` sample in Prometheus text output. */
function sumRequestsTotal(metricsText: string): number {
  return metricsText
    .split('\n')
    .filter((line) => line.startsWith('http_requests_total'))
    .reduce((sum, line) => sum + Number(line.trim().split(/\s+/).pop()), 0);
}

describe('End-to-end smoke', () => {
  beforeAll(waitForStack);

  it('POST /order on the Gateway succeeds through the full chain', async () => {
    const res = await postJson(`${SERVICES.gateway}/order`);

    // Nest returns 201 for POST handlers by default (design.md says 200).
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe('paid');
    expect(typeof body.orderId).toBe('string');
  });

  it.each(Object.entries(SERVICES))(
    '%s GET /metrics reports non-zero http_requests_total',
    async (_name, baseUrl) => {
      const res = await fetch(`${baseUrl}/metrics`);
      expect(res.status).toBe(200);
      expect(sumRequestsTotal(await res.text())).toBeGreaterThan(0);
    },
  );
});
