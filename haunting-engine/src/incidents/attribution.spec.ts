import type { ServiceHealth, ServiceName, ServiceStatus, SignalKind } from '@haunted-cluster/shared';
import { attributeFaults, Attribution } from './attribution';

const CHAIN: ServiceName[] = ['gateway', 'orders', 'payments'];

/** Health with the given breached kinds; status follows from them as `scoreService` would set it. */
function health(service: ServiceName, kinds: SignalKind[] = []): ServiceHealth {
  const status: ServiceStatus = kinds.includes('down')
    ? 'down'
    : kinds.length > 0
      ? 'degraded'
      : 'healthy';
  return {
    service,
    status,
    score: status === 'down' ? 0 : kinds.length > 0 ? 50 : 100,
    signals: {
      requestRate: null,
      errorRatio: null,
      latencyP95Ms: null,
      rssMb: null,
      up: status !== 'down',
    },
    badness: { latency: 0, errors: 0, memory: 0 },
    breachedKinds: kinds,
  };
}

/** Health for every service in CHAIN; services not listed are healthy. */
function cluster(
  breaches: Partial<Record<ServiceName, SignalKind[]>>,
): Record<ServiceName, ServiceHealth> {
  return Object.fromEntries(CHAIN.map((s) => [s, health(s, breaches[s])]));
}

describe('attributeFaults', () => {
  describe('worked examples from design.md (Requirements 4.1, 4.2, 4.3)', () => {
    it('100 % errors on orders: root orders [errors], affected gateway [errors]', () => {
      const result = attributeFaults(CHAIN, cluster({ gateway: ['errors'], orders: ['errors'] }));
      expect(result).toEqual<Attribution[]>([
        {
          rootService: 'orders',
          kinds: ['errors'],
          affected: [{ service: 'gateway', kinds: ['errors'] }],
        },
      ]);
    });

    it('1500 ms latency on payments: root payments [latency], affected orders, gateway', () => {
      const result = attributeFaults(
        CHAIN,
        cluster({ gateway: ['latency'], orders: ['latency'], payments: ['latency'] }),
      );
      expect(result).toEqual<Attribution[]>([
        {
          rootService: 'payments',
          kinds: ['latency'],
          affected: [
            { service: 'gateway', kinds: ['latency'] },
            { service: 'orders', kinds: ['latency'] },
          ],
        },
      ]);
    });

    it('6000 ms latency on payments: root payments [latency], affected orders, gateway [errors, latency]', () => {
      // Past the 5 s downstream timeout, upstream callers turn the latency into errors.
      const result = attributeFaults(
        CHAIN,
        cluster({
          gateway: ['errors', 'latency'],
          orders: ['errors', 'latency'],
          payments: ['latency'],
        }),
      );
      expect(result).toEqual<Attribution[]>([
        {
          rootService: 'payments',
          kinds: ['latency'],
          affected: [
            { service: 'gateway', kinds: ['errors', 'latency'] },
            { service: 'orders', kinds: ['errors', 'latency'] },
          ],
        },
      ]);
    });

    it('payments crashed: root payments [down], affected orders, gateway', () => {
      const result = attributeFaults(
        CHAIN,
        cluster({ gateway: ['errors'], orders: ['errors'], payments: ['down'] }),
      );
      expect(result).toEqual<Attribution[]>([
        {
          rootService: 'payments',
          kinds: ['down'],
          affected: [
            { service: 'gateway', kinds: ['errors'] },
            { service: 'orders', kinds: ['errors'] },
          ],
        },
      ]);
    });

    it('memory leak on orders: root orders [memory]', () => {
      const result = attributeFaults(CHAIN, cluster({ orders: ['memory'] }));
      expect(result).toEqual<Attribution[]>([
        { rootService: 'orders', kinds: ['memory'], affected: [] },
      ]);
    });
  });

  describe('known limitation: concurrent propagating faults (Requirement 4.1)', () => {
    it('gateway latency + payments errors is one incident rooted at payments, gateway affected with latency', () => {
      const result = attributeFaults(CHAIN, cluster({ gateway: ['latency'], payments: ['errors'] }));
      expect(result).toEqual<Attribution[]>([
        {
          rootService: 'payments',
          kinds: ['errors'],
          affected: [{ service: 'gateway', kinds: ['latency'] }],
        },
      ]);
    });
  });
});
