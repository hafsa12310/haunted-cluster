import { Logger } from '@nestjs/common';
import type { ClusterSnapshot, ServiceName, ServiceSignals } from '@haunted-cluster/shared';
import { ChaosLogService } from '../chaos-proxy/chaos-log.service';
import { loadEngineConfig } from '../config/engine-config';
import type { IncidentEvent } from '../incidents/incident-tracker';
import type { MetricsCollectorService } from '../metrics/metrics-collector.service';
import { MetricsUnavailableError } from '../metrics/prometheus.client';
import { EngineStateService } from './engine-state.service';
import type { EventsGateway } from './events.gateway';
import { PollerService } from './poller.service';

/** Default config: one Poll every 2000 ms, incidents open after 2 Polls. */
const CONFIG = loadEngineConfig({
  PROMETHEUS_URL: 'http://prometheus:9090',
  GATEWAY_URL: 'http://gateway:3000',
  ORDERS_URL: 'http://orders:3001',
  PAYMENTS_URL: 'http://payments:3002',
});
const INTERVAL = CONFIG.pollIntervalMs;

const HEALTHY: ServiceSignals = {
  requestRate: 10,
  errorRatio: 0,
  latencyP95Ms: 50,
  rssMb: 80,
  up: true,
};

/** Every service healthy, except any overridden. */
function signals(
  overrides: Partial<Record<ServiceName, Partial<ServiceSignals>>> = {},
): Record<ServiceName, ServiceSignals> {
  return Object.fromEntries(CONFIG.serviceChain.map((s) => [s, { ...HEALTHY, ...overrides[s] }]));
}

type Collect = () => Promise<Record<ServiceName, ServiceSignals>>;

/** A PollerService with a scriptable collector and a recording gateway, on fake timers. */
function setup(collect: Collect = async () => signals()) {
  const collector = { collect: jest.fn(collect) };
  const emitted: (['snapshot', ClusterSnapshot] | ['incident', IncidentEvent])[] = [];
  const gateway = {
    emitSnapshot: jest.fn((s: ClusterSnapshot) => emitted.push(['snapshot', s])),
    emitIncidentEvent: jest.fn((e: IncidentEvent) => emitted.push(['incident', e])),
  };
  const chaosLog = new ChaosLogService();
  const state = new EngineStateService(CONFIG);
  const poller = new PollerService(
    CONFIG,
    { now: () => Date.now() },
    collector as unknown as MetricsCollectorService,
    chaosLog,
    state,
    gateway as unknown as EventsGateway,
  );
  const snapshots = () => gateway.emitSnapshot.mock.calls.map(([s]) => s);
  return { poller, collector, gateway, emitted, chaosLog, state, snapshots };
}

/** A promise the test resolves or rejects by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('PollerService', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-11-08T12:00:00.000Z') });
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    jest.useRealTimers();
    warn.mockRestore();
    error.mockRestore();
  });

  /** Starts the poller and makes sure it is stopped after the test. */
  function start(poller: PollerService): void {
    poller.onApplicationBootstrap();
    stop = () => poller.onModuleDestroy();
  }

  describe('schedule (Requirements 2.1, 2.7)', () => {
    it('runs the first Poll straight after bootstrap', async () => {
      const { poller, collector } = setup();

      start(poller);
      expect(collector.collect).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(0);

      expect(collector.collect).toHaveBeenCalledTimes(1);
    });

    it('runs a Poll every pollIntervalMs when Polls are instant', async () => {
      const { poller, collector } = setup();
      const starts: number[] = [];
      collector.collect.mockImplementation(async () => {
        starts.push(Date.now());
        return signals();
      });

      start(poller);
      await jest.advanceTimersByTimeAsync(3 * INTERVAL);

      expect(starts.map((t) => t - starts[0])).toEqual([0, INTERVAL, 2 * INTERVAL, 3 * INTERVAL]);
    });

    it('never starts a Poll while the previous one is still pending', async () => {
      const pending = deferred<Record<ServiceName, ServiceSignals>>();
      const { poller, collector } = setup(() => pending.promise);

      start(poller);
      await jest.advanceTimersByTimeAsync(10 * INTERVAL);
      expect(collector.collect).toHaveBeenCalledTimes(1);

      // Finishing a Poll that ran past the interval starts the next one at once.
      collector.collect.mockImplementation(async () => signals());
      pending.resolve(signals());
      await jest.advanceTimersByTimeAsync(0);
      expect(collector.collect).toHaveBeenCalledTimes(2);
    });

    it('subtracts the time a Poll took from the delay before the next one', async () => {
      const { poller, collector } = setup();
      const starts: number[] = [];
      collector.collect.mockImplementation(async () => {
        starts.push(Date.now());
        // Each collection takes 500 ms.
        await new Promise((resolve) => setTimeout(resolve, 500));
        return signals();
      });

      start(poller);
      await jest.advanceTimersByTimeAsync(2 * INTERVAL + 500);

      // Poll starts stay INTERVAL apart, not INTERVAL + 500.
      expect(starts.map((t) => t - starts[0])).toEqual([0, INTERVAL, 2 * INTERVAL]);
    });

    it('waits 0 ms, not a negative delay, when a Poll took longer than the interval', async () => {
      const { poller, collector } = setup();
      const starts: number[] = [];
      collector.collect.mockImplementation(async () => {
        starts.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, INTERVAL + 700));
        return signals();
      });

      start(poller);
      await jest.advanceTimersByTimeAsync(2 * (INTERVAL + 701));

      // Each Poll starts as soon as the previous one ends. Node runs setTimeout(0)
      // after 1 ms, so "as soon as" means within 1 ms, never a full interval later.
      expect(starts).toHaveLength(3);
      for (let i = 1; i < starts.length; i++) {
        const extraWait = starts[i] - starts[i - 1] - (INTERVAL + 700);
        expect(extraWait).toBeGreaterThanOrEqual(0);
        expect(extraWait).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('one Poll (Requirements 9.2, 9.3)', () => {
    it('stores and emits a snapshot of every service in chain order', async () => {
      const { poller, state, snapshots } = setup();

      start(poller);
      await jest.advanceTimersByTimeAsync(0);

      const [snapshot] = snapshots();
      expect(snapshot.timestamp).toBe('2026-11-08T12:00:00.000Z');
      expect(snapshot.metricsAvailable).toBe(true);
      expect(snapshot.services.map((h) => [h.service, h.status])).toEqual([
        ['gateway', 'healthy'],
        ['orders', 'healthy'],
        ['payments', 'healthy'],
      ]);
      expect(snapshot.dread).toBe(0);
      expect(state.latestSnapshot).toBe(snapshot);
    });

    it('opens an incident on the second faulty Poll, with chaos evidence, emitted after the snapshot', async () => {
      const { poller, emitted, chaosLog, state } = setup(async () =>
        signals({ orders: { errorRatio: 0.5 } }),
      );
      chaosLog.record({
        id: 'chaos-1',
        service: 'orders',
        action: 'error-rate',
        params: { percentage: 50 },
        at: new Date().toISOString(),
      });

      start(poller);
      await jest.advanceTimersByTimeAsync(0);
      expect(emitted.map(([kind]) => kind)).toEqual(['snapshot']);

      await jest.advanceTimersByTimeAsync(INTERVAL);
      expect(emitted.map(([kind]) => kind)).toEqual(['snapshot', 'snapshot', 'incident']);
      const [, event] = emitted[2] as ['incident', IncidentEvent];
      expect(event.type).toBe('opened');
      expect(event.incident.fingerprint).toBe('orders:errors');
      expect(event.incident.relatedChaos.map((c) => c.id)).toEqual(['chaos-1']);
      expect(event.incident.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(state.openIncidents()).toEqual([event.incident]);

      // Later faulty Polls keep the same incident open without re-opening it.
      await jest.advanceTimersByTimeAsync(INTERVAL);
      expect(emitted.filter(([kind]) => kind === 'incident')).toHaveLength(1);
    });
  });

  describe('failures (Requirements 11.1, 11.2)', () => {
    it('emits an all-unknown snapshot on MetricsUnavailableError, logs it, and keeps polling', async () => {
      const { poller, collector, gateway, snapshots } = setup();
      collector.collect.mockRejectedValueOnce(
        new MetricsUnavailableError('Prometheus unreachable at http://prometheus:9090: fetch failed (ECONNREFUSED)'),
      );

      start(poller);
      await jest.advanceTimersByTimeAsync(0);

      const [blind] = snapshots();
      expect(blind.metricsAvailable).toBe(false);
      expect(blind.services.map((h) => h.status)).toEqual(['unknown', 'unknown', 'unknown']);
      expect(blind.dread).toBe(0);
      expect(gateway.emitIncidentEvent).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        'Poll failed: metrics unavailable (Prometheus unreachable at http://prometheus:9090: fetch failed (ECONNREFUSED))',
      );
      expect(error).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(INTERVAL);
      expect(collector.collect).toHaveBeenCalledTimes(2);
      expect(snapshots()[1].metricsAvailable).toBe(true);
    });

    it('freezes the incident tracker during a blind Poll', async () => {
      const { poller, collector, state } = setup(async () => signals({ orders: { errorRatio: 0.5 } }));
      collector.collect.mockImplementationOnce(async () => signals({ orders: { errorRatio: 0.5 } }));
      collector.collect.mockRejectedValueOnce(new MetricsUnavailableError('timed out'));

      start(poller);
      await jest.advanceTimersByTimeAsync(0);
      const afterFirst = state.tracker;

      // Blind Poll: nothing about incidents changes.
      await jest.advanceTimersByTimeAsync(INTERVAL);
      expect(state.tracker).toEqual(afterFirst);
      expect(state.openIncidents()).toEqual([]);

      // The next real Poll is only the second faulty one, so the incident opens now.
      await jest.advanceTimersByTimeAsync(INTERVAL);
      expect(state.openIncidents().map((i) => i.rootService)).toEqual(['orders']);
    });

    it('logs an unexpected error with its stack, emits nothing for that Poll, and keeps polling', async () => {
      const { poller, collector, gateway, state } = setup();
      const boom = new TypeError('cannot read properties of undefined');
      collector.collect.mockRejectedValueOnce(boom);

      start(poller);
      await jest.advanceTimersByTimeAsync(0);

      expect(error).toHaveBeenCalledWith(
        'Poll failed unexpectedly: cannot read properties of undefined',
        boom.stack,
      );
      expect(warn).not.toHaveBeenCalled();
      expect(gateway.emitSnapshot).not.toHaveBeenCalled();
      expect(state.latestSnapshot).toBeNull();

      await jest.advanceTimersByTimeAsync(INTERVAL);
      expect(collector.collect).toHaveBeenCalledTimes(2);
      expect(gateway.emitSnapshot).toHaveBeenCalledTimes(1);
    });

    it('keeps polling when emitting fails', async () => {
      const { poller, collector, gateway } = setup();
      gateway.emitSnapshot.mockImplementationOnce(() => {
        throw new Error('socket server closed');
      });

      start(poller);
      await jest.advanceTimersByTimeAsync(0);
      expect(error).toHaveBeenCalledWith('Poll failed unexpectedly: socket server closed', expect.any(String));

      await jest.advanceTimersByTimeAsync(INTERVAL);
      expect(collector.collect).toHaveBeenCalledTimes(2);
    });

    it('logs a non-Error rejection without crashing', async () => {
      const { poller, collector } = setup();
      collector.collect.mockRejectedValueOnce('just a string');

      start(poller);
      await jest.advanceTimersByTimeAsync(0);

      expect(error).toHaveBeenCalledWith('Poll failed unexpectedly: just a string', undefined);
      await jest.advanceTimersByTimeAsync(INTERVAL);
      expect(collector.collect).toHaveBeenCalledTimes(2);
    });
  });

  describe('onModuleDestroy', () => {
    it('cancels the pending Poll and schedules no more', async () => {
      const { poller, collector } = setup();

      start(poller);
      await jest.advanceTimersByTimeAsync(0);
      poller.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(10 * INTERVAL);

      expect(collector.collect).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('lets a Poll already in progress finish, but schedules no next one', async () => {
      const pending = deferred<Record<ServiceName, ServiceSignals>>();
      const { poller, collector, gateway } = setup(() => pending.promise);

      start(poller);
      await jest.advanceTimersByTimeAsync(0);
      poller.onModuleDestroy();
      pending.resolve(signals());
      await jest.advanceTimersByTimeAsync(10 * INTERVAL);

      expect(gateway.emitSnapshot).toHaveBeenCalledTimes(1);
      expect(collector.collect).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('does nothing if the poller never started', () => {
      const { poller } = setup();

      expect(() => poller.onModuleDestroy()).not.toThrow();
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
