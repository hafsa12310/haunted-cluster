import type {
  ChaosEvent,
  Incident,
  ServiceHealth,
  ServiceName,
  ServiceSignals,
  SignalKind,
} from '@haunted-cluster/shared';
import { loadEngineConfig } from '../config/engine-config';
import type { Attribution } from './attribution';
import {
  IncidentEvent,
  initialTrackerState,
  trackIncidents,
  TrackerState,
} from './incident-tracker';

/** Default config: open after 2 Polls, close after 3, 150 s chaos evidence window. */
const CONFIG = loadEngineConfig({
  PROMETHEUS_URL: 'http://prometheus:9090',
  GATEWAY_URL: 'http://gateway:3000',
  ORDERS_URL: 'http://orders:3001',
  PAYMENTS_URL: 'http://payments:3002',
});

const CHAIN = CONFIG.serviceChain;
const T0 = Date.parse('2026-11-07T12:00:00.000Z');

/** One service in a Poll: its breached kinds, plus any signal values and score to report. */
interface ServicePoll {
  kinds?: SignalKind[];
  signals?: Partial<ServiceSignals>;
  score?: number;
}

function healthFor(service: ServiceName, poll: ServicePoll = {}): ServiceHealth {
  const kinds = poll.kinds ?? [];
  return {
    service,
    status: kinds.length > 0 ? 'degraded' : 'healthy',
    score: poll.score ?? (kinds.length > 0 ? 50 : 100),
    signals: {
      requestRate: 10,
      errorRatio: 0,
      latencyP95Ms: 50,
      rssMb: 100,
      up: true,
      ...poll.signals,
    },
    badness: { latency: 0, errors: 0, memory: 0 },
    breachedKinds: kinds,
  };
}

/** Drives the tracker one Poll at a time, `pollIntervalMs` apart, with counter IDs. */
class Harness {
  state: TrackerState = initialTrackerState(CHAIN);
  now = T0;
  private nextId = 0;

  poll(
    services: Partial<Record<ServiceName, ServicePoll>>,
    options: { affected?: Attribution['affected']; chaosEvents?: ChaosEvent[] } = {},
  ): IncidentEvent[] {
    const health = Object.fromEntries(CHAIN.map((s) => [s, healthFor(s, services[s])]));
    const attributions: Attribution[] = CHAIN.flatMap((s) => {
      const kinds = services[s]?.kinds ?? [];
      return kinds.length > 0
        ? [{ rootService: s, kinds, affected: options.affected ?? [] }]
        : [];
    });
    const result = trackIncidents(
      this.state,
      {
        now: this.now,
        metricsAvailable: true,
        health,
        attributions,
        chaosEvents: options.chaosEvents ?? [],
      },
      CONFIG,
      () => `incident-${++this.nextId}`,
    );
    this.state = result.state;
    this.now += CONFIG.pollIntervalMs;
    return result.events;
  }

  /** Polls with `services` until an incident opens, and returns it. */
  open(
    services: Partial<Record<ServiceName, ServicePoll>>,
    options?: Parameters<Harness['poll']>[1],
  ): Incident {
    for (let i = 0; i < CONFIG.openAfterPolls; i++) {
      const opened = this.poll(services, options).find((e) => e.type === 'opened');
      if (opened) return opened.incident;
    }
    throw new Error('no incident opened');
  }
}

function chaos(id: string, service: ServiceName, at: number): ChaosEvent {
  return { id, service, action: 'error-rate', params: { rate: 1 }, at: new Date(at).toISOString() };
}

describe('trackIncidents', () => {
  describe('relatedChaos (Requirement 8.1)', () => {
    /** The time of the opening Poll: the second one, so T0 + one interval. */
    const OPEN_AT = T0 + CONFIG.pollIntervalMs;
    const WINDOW_MS = CONFIG.chaosEvidenceWindowSeconds * 1000;

    it('attaches only chaos on the root service inside the evidence window, newest first', () => {
      const events = [
        chaos('orders-newest', 'orders', OPEN_AT - 1_000),
        chaos('payments-recent', 'payments', OPEN_AT - 2_000),
        chaos('orders-middle', 'orders', OPEN_AT - 60_000),
        chaos('orders-at-edge', 'orders', OPEN_AT - WINDOW_MS),
        chaos('orders-just-outside', 'orders', OPEN_AT - WINDOW_MS - 1),
        chaos('gateway-old', 'gateway', OPEN_AT - WINDOW_MS - 60_000),
      ];
      const incident = new Harness().open({ orders: { kinds: ['errors'] } }, { chaosEvents: events });

      expect(incident.rootService).toBe('orders');
      expect(incident.relatedChaos.map((e) => e.id)).toEqual([
        'orders-newest',
        'orders-middle',
        'orders-at-edge',
      ]);
    });

    it('orders relatedChaos newest first even if the chaos log is not', () => {
      const events = [
        chaos('older', 'orders', OPEN_AT - 30_000),
        chaos('newest', 'orders', OPEN_AT - 1_000),
        chaos('oldest', 'orders', OPEN_AT - 90_000),
      ];
      const incident = new Harness().open({ orders: { kinds: ['errors'] } }, { chaosEvents: events });

      expect(incident.relatedChaos.map((e) => e.id)).toEqual(['newest', 'older', 'oldest']);
    });

    it('is empty when no chaos targeted the root service', () => {
      const incident = new Harness().open(
        { orders: { kinds: ['errors'] } },
        { chaosEvents: [chaos('payments-only', 'payments', OPEN_AT - 1_000)] },
      );

      expect(incident.relatedChaos).toEqual([]);
    });

    it('is fixed when the incident opens and not changed by later chaos', () => {
      const h = new Harness();
      h.open({ orders: { kinds: ['errors'] } });
      h.poll(
        { orders: { kinds: ['errors', 'latency'] } },
        { chaosEvents: [chaos('later', 'orders', h.now - 1_000)] },
      );

      expect(h.state.open.orders.relatedChaos).toEqual([]);
    });
  });

  describe('updates (Requirement 5.4)', () => {
    it('does not emit updated when only peak values change', () => {
      const h = new Harness();
      h.open({ orders: { kinds: ['latency'], signals: { latencyP95Ms: 400 } } });

      const events = h.poll({
        orders: { kinds: ['latency'], signals: { latencyP95Ms: 900 }, score: 10 },
      });

      expect(events).toEqual([]);
      // The peak is still raised, silently.
      expect(h.state.open.orders.peak.latencyP95Ms).toBe(900);
      expect(h.state.open.orders.peak.minScore).toBe(10);
    });

    it('emits updated when a new kind appears, keeping the earlier kinds first', () => {
      const h = new Harness();
      h.open({ orders: { kinds: ['latency'] } });

      const events = h.poll({ orders: { kinds: ['errors', 'latency'] } });

      expect(events.map((e) => e.type)).toEqual(['updated']);
      expect(events[0].incident.kinds).toEqual(['latency', 'errors']);
      expect(h.state.open.orders).toEqual(events[0].incident);
    });

    it('keeps kinds that stop breaching and emits nothing for it', () => {
      const h = new Harness();
      h.open({ orders: { kinds: ['errors', 'latency'] } });

      const events = h.poll({ orders: { kinds: ['latency'] } });

      expect(events).toEqual([]);
      expect(h.state.open.orders.kinds).toEqual(['errors', 'latency']);
    });

    it('emits updated when the affected services change, and replaces them', () => {
      const h = new Harness();
      h.open({ payments: { kinds: ['latency'] } });

      const affected = [{ service: 'gateway', kinds: ['latency'] as SignalKind[] }];
      const events = h.poll({ payments: { kinds: ['latency'] } }, { affected });

      expect(events.map((e) => e.type)).toEqual(['updated']);
      expect(events[0].incident.affected).toEqual(affected);
      expect(events[0].incident.kinds).toEqual(['latency']);

      // The same affected list again is not a change.
      expect(h.poll({ payments: { kinds: ['latency'] } }, { affected })).toEqual([]);

      // Affected services are replaced, not merged.
      const cleared = h.poll({ payments: { kinds: ['latency'] } });
      expect(cleared.map((e) => e.type)).toEqual(['updated']);
      expect(cleared[0].incident.affected).toEqual([]);
    });
  });

  describe('peaks (Requirement 5.4)', () => {
    it('starts from the root signals and score at opening', () => {
      const incident = new Harness().open({
        orders: {
          kinds: ['errors'],
          signals: { latencyP95Ms: 300, errorRatio: 0.15, rssMb: 140 },
          score: 40,
        },
      });

      expect(incident.peak).toEqual({ latencyP95Ms: 300, errorRatio: 0.15, rssMb: 140, minScore: 40 });
    });

    it('keeps the maximum of each signal and the minimum score across Polls', () => {
      const h = new Harness();
      h.open({
        orders: { kinds: ['errors'], signals: { latencyP95Ms: 200, errorRatio: 0.1, rssMb: 120 }, score: 60 },
      });
      h.poll({
        orders: { kinds: ['errors'], signals: { latencyP95Ms: 800, errorRatio: 0.05, rssMb: 150 }, score: 30 },
      });
      h.poll({
        orders: { kinds: ['errors'], signals: { latencyP95Ms: 400, errorRatio: 0.3, rssMb: 130 }, score: 50 },
      });

      expect(h.state.open.orders.peak).toEqual({
        latencyP95Ms: 800,
        errorRatio: 0.3,
        rssMb: 150,
        minScore: 30,
      });
    });

    it('does not lose a peak when a signal goes missing', () => {
      const h = new Harness();
      h.open({ orders: { kinds: ['errors'], signals: { latencyP95Ms: 700, errorRatio: 0.2 } } });
      h.poll({ orders: { kinds: ['errors'], signals: { latencyP95Ms: null, errorRatio: null } } });

      expect(h.state.open.orders.peak.latencyP95Ms).toBe(700);
      expect(h.state.open.orders.peak.errorRatio).toBe(0.2);
    });

    it('fills a peak that was missing at opening', () => {
      const h = new Harness();
      h.open({ orders: { kinds: ['errors'], signals: { rssMb: null } } });
      h.poll({ orders: { kinds: ['errors'], signals: { rssMb: 160 } } });

      expect(h.state.open.orders.peak.rssMb).toBe(160);
    });
  });

  describe('resolution (Requirement 5.5)', () => {
    it('resolves after closeAfterPolls clear Polls with resolvedAt and durationMs', () => {
      const h = new Harness();
      const opened = h.open({ orders: { kinds: ['errors'] } });

      const events: IncidentEvent[] = [];
      let resolveTime = 0;
      for (let i = 0; i < CONFIG.closeAfterPolls; i++) {
        resolveTime = h.now;
        events.push(...h.poll({}));
      }

      expect(events.map((e) => e.type)).toEqual(['resolved']);
      const resolved = events[0].incident;
      expect(resolved).toEqual<Incident>({
        ...opened,
        status: 'resolved',
        resolvedAt: new Date(resolveTime).toISOString(),
        durationMs: resolveTime - Date.parse(opened.openedAt),
      });
      expect(resolved.durationMs).toBe(CONFIG.closeAfterPolls * CONFIG.pollIntervalMs);

      // It leaves the open set and goes to the front of the history.
      expect(h.state.open.orders).toBeUndefined();
      expect(h.state.history[0]).toEqual(resolved);
    });

    it('does not resolve while the clear streak is shorter than closeAfterPolls', () => {
      const h = new Harness();
      h.open({ orders: { kinds: ['errors'] } });

      for (let i = 0; i < CONFIG.closeAfterPolls - 1; i++) expect(h.poll({})).toEqual([]);
      // Breaching again resets the clear streak.
      h.poll({ orders: { kinds: ['errors'] } });
      for (let i = 0; i < CONFIG.closeAfterPolls - 1; i++) expect(h.poll({})).toEqual([]);

      expect(h.state.open.orders.status).toBe('open');
    });
  });
});
