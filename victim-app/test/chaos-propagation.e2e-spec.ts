/**
 * Chaos propagation test against a running stack: a 100% error rate on Orders
 * must surface at the Gateway as a 502. Not part of `npm test`; run with
 * `npm run test:e2e`.
 *
 * Requirements: 4.1, 1.4
 */
import { SERVICES, postJson, waitForStack } from './helpers';

describe('Chaos propagation', () => {
  beforeAll(waitForStack);

  // Always clear chaos so a failed assertion can't leave Orders broken.
  afterAll(async () => {
    await postJson(`${SERVICES.orders}/chaos/reset`);
  });

  it('Gateway returns 502 when Orders has a 100% error rate', async () => {
    const chaosRes = await postJson(`${SERVICES.orders}/chaos/error-rate`, {
      percentage: 100,
    });
    expect(chaosRes.status).toBe(201);

    const res = await postJson(`${SERVICES.gateway}/order`);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.message).toContain('orders');
  });
});
