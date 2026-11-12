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
import { trackIncidents } from '../incidents/incident-tracker';
import { stepForecast } from '../intelligence/forecast/forecaster';
import { trackAnomalies } from '../intelligence/anomaly/anomaly-tracker';
import { stepIntelligence, intelligenceView } from '../intelligence/intelligence-step';
import type { IntelligenceEvent } from '../intelligence/intelligence-types';
import { extractFeatures } from '../intelligence/similarity/feature-extractor';
import { applySimilarity } from '../intelligence/similarity/incident-similarity';

// Real implementations stay in place; the wrappers only let a test record calls
// or inject a one-off failure with mockImplementationOnce.
jest.mock('../incidents/incident-tracker', () => {
  const actual = jest.requireActual('../incidents/incident-tracker');
  return { ...actual, trackIncidents: jest.fn(actual.trackIncidents) };
});
jest.mock('../intelligence/intelligence-step', () => {
  const actual = jest.requireActual('../intelligence/intelligence-step');
  return { ...actual, stepIntelligence: jest.fn(actual.stepIntelligence) };
});
jest.mock('../intelligence/forecast/forecaster', () => {
  const actual = jest.requireActual('../intelligence/forecast/forecaster');
  return { ...actual, stepForecast: jest.fn(actual.stepForecast) };
});
jest.mock('../intelligence/anomaly/anomaly-tracker', () => {
  const actual = jest.requireActual('../intelligence/anomaly/anomaly-tracker');
  return { ...actual, trackAnomalies: jest.fn(actual.trackAnomalies) };
});
jest.mock('../intelligence/similarity/incident-similarity', () => {
  const actual = jest.requireActual('../intelligence/similarity/incident-similarity');
  return { ...actual, applySimilarity: jest.fn(actual.applySimilarity) };
});
jest.mock('../intelligence/similarity/feature-extractor', () => {
  const actual = jest.requireActual('../intelligence/similarity/feature-extractor');
  return { ...actual, extractFeatures: jest.fn(actual.extractFeatures) };
});

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
  const emitted: (
    | ['snapshot', ClusterSnapshot]
    | ['incident', IncidentEvent]
    | ['intelligence', IntelligenceEvent]
  )[] = [];
  const gateway = {
    emitSnapshot: jest.fn((s: ClusterSnapshot) => emitted.push(['snapshot', s])),
    emitIncidentEvent: jest.fn((e: IncidentEvent) => emitted.push(['incident', e])),
    emitIntelligenceEvent: jest.fn((e: IntelligenceEvent) => emitted.push(['intelligence', e])),
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
      // The error ratio breach is also a confirmed anomaly in this Poll, emitted last.
      expect(emitted.map(([kind]) => kind)).toEqual(['snapshot', 'snapshot', 'incident', 'intelligence']);
      expect(emitted[3]).toEqual(['intelligence', expect.objectContaining({ type: 'anomaly:detected' })]);
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

  describe('intelligence wiring (Requirements 8.14, 9.6, 9.9, 4.18)', () => {
    /**
     * Scripted cluster: payments RSS climbs 10 MB per Poll from Poll 0 (a forecast
     * warning at Poll 4); orders latency is 5000 ms from Poll 4 (an anomaly confirmed
     * at Poll 5 and an incident opened at Poll 5).
     */
    function scripted(): Collect {
      let poll = 0;
      return async () => {
        const i = poll++;
        return signals({
          payments: { rssMb: 80 + 10 * i },
          orders: { latencyP95Ms: i >= 4 ? 5000 : 50 },
        });
      };
    }

    /** Emissions after the n-th (0-based) snapshot and before the next one. */
    function pollEmissions(emitted: ReturnType<typeof setup>['emitted'], n: number) {
      const starts = emitted.flatMap(([kind], i) => (kind === 'snapshot' ? [i] : []));
      return emitted.slice(starts[n], starts[n + 1] ?? emitted.length);
    }

    const stepMock = stepIntelligence as jest.MockedFunction<typeof stepIntelligence>;
    const trackMock = trackIncidents as jest.MockedFunction<typeof trackIncidents>;
    const applyMock = applySimilarity as jest.MockedFunction<typeof applySimilarity>;
    const forecastMock = stepForecast as jest.MockedFunction<typeof stepForecast>;
    const anomalyTrackMock = trackAnomalies as jest.MockedFunction<typeof trackAnomalies>;
    const featuresMock = extractFeatures as jest.MockedFunction<typeof extractFeatures>;

    beforeEach(() => {
      for (const m of [stepMock, trackMock, applyMock, forecastMock, anomalyTrackMock, featuresMock]) {
        m.mockClear();
      }
    });

    it('runs incident tracking, then the intelligence step (forecast before anomaly tracking), then similarity', async () => {
      const { poller } = setup(scripted());

      start(poller);
      await jest.advanceTimersByTimeAsync(0);

      const order = (m: { mock: { invocationCallOrder: number[] } }) => m.mock.invocationCallOrder[0];
      expect(order(trackMock)).toBeLessThan(order(stepMock));
      expect(order(stepMock)).toBeLessThan(order(applyMock));
      // Inside the step: every forecast runs before anomaly tracking.
      expect(forecastMock).toHaveBeenCalledTimes(CONFIG.serviceChain.length);
      expect(Math.max(...forecastMock.mock.invocationCallOrder)).toBeLessThan(order(anomalyTrackMock));
    });

    it('gives the step the stored intelligence state and the pre-Poll incident state', async () => {
      // Orders is faulty from Poll 0, so its incident opens during Poll 1.
      const { poller, state } = setup(async () => signals({ orders: { errorRatio: 0.5 } }));

      start(poller);
      await jest.advanceTimersByTimeAsync(0);
      const afterPoll0 = state.intelligence;
      await jest.advanceTimersByTimeAsync(INTERVAL);
      await jest.advanceTimersByTimeAsync(INTERVAL);

      expect(stepMock).toHaveBeenCalledTimes(3);
      const openBefore = stepMock.mock.calls.map(([, input]) => input.openBefore.orders);
      // Poll 1 opens the incident, but the step still sees "no incident yet".
      expect(openBefore).toEqual([false, false, true]);
      expect(stepMock.mock.calls[1][0]).toBe(afterPoll0);
      expect(stepMock.mock.calls[1][1].now).toBe(Date.parse('2026-11-08T12:00:02.000Z'));
      expect(stepMock.mock.calls[1][1].metricsAvailable).toBe(true);
      expect(state.openIncidents()).toHaveLength(1);
    });

    it('keeps the previous intelligence state when the step throws, still emitting the snapshot', async () => {
      const { poller, state, emitted, snapshots } = setup(scripted());

      start(poller);
      await jest.advanceTimersByTimeAsync(5 * INTERVAL); // Polls 0 to 5
      const retained = state.intelligence;
      const view = intelligenceView(retained, CONFIG.serviceChain);
      expect(view.forecasts.length).toBeGreaterThan(0);
      expect(view.anomalies.length).toBeGreaterThan(0);

      const boom = new RangeError('step exploded');
      stepMock.mockImplementationOnce(() => {
        throw boom;
      });
      await jest.advanceTimersByTimeAsync(INTERVAL); // Poll 6

      expect(error).toHaveBeenCalledWith('Intelligence step failed: step exploded', boom.stack);
      expect(state.intelligence).toBe(retained);
      const snapshot = snapshots()[6];
      expect(snapshot.anomalies).toEqual(view.anomalies);
      expect(snapshot.forecasts).toEqual(view.forecasts);
      expect(state.latestSnapshot).toBe(snapshot);
      expect(pollEmissions(emitted, 6).map(([kind]) => kind)).toEqual(['snapshot']);

      // The next Poll carries on from the retained state.
      await jest.advanceTimersByTimeAsync(INTERVAL);
      expect(snapshots()).toHaveLength(8);
    });

    it('emits no anomaly or forecast event for the Poll whose step threw', async () => {
      const { poller, emitted } = setup(scripted());
      stepMock.mockImplementationOnce(() => {
        throw new Error('first Poll fails');
      });

      start(poller);
      await jest.advanceTimersByTimeAsync(0);

      expect(emitted.map(([kind]) => kind)).toEqual(['snapshot']);
    });

    it('leaves similar null and still emits the incident when similarity throws', async () => {
      const { poller, emitted, state } = setup(async () => signals({ orders: { errorRatio: 0.5 } }));
      const boom = new Error('similarity exploded');
      applyMock.mockImplementationOnce((tracker, events) => ({ tracker, events: [...events], failures: [] })); // Poll 0
      applyMock.mockImplementationOnce(() => {
        throw boom;
      });

      start(poller);
      await jest.advanceTimersByTimeAsync(INTERVAL);

      expect(error).toHaveBeenCalledWith('Similarity step failed: similarity exploded', boom.stack);
      const incidentEvents = emitted.filter(([kind]) => kind === 'incident') as ['incident', IncidentEvent][];
      expect(incidentEvents).toHaveLength(1);
      expect(incidentEvents[0][1].type).toBe('opened');
      expect(incidentEvents[0][1].incident.similar).toBeNull();
      expect(state.openIncidents().map((i) => i.similar)).toEqual([null]);
    });

    it('leaves similar null, emits the incident and logs the stack when matching one incident fails', async () => {
      const { poller, emitted } = setup(async () => signals({ orders: { errorRatio: 0.5 } }));
      const boom = new Error('feature extraction exploded');
      featuresMock.mockImplementation(() => {
        throw boom;
      });

      start(poller);
      await jest.advanceTimersByTimeAsync(INTERVAL);
      featuresMock.mockRestore();

      const incidentEvents = emitted.filter(([kind]) => kind === 'incident') as ['incident', IncidentEvent][];
      expect(incidentEvents).toHaveLength(1);
      expect(incidentEvents[0][1].incident.similar).toBeNull();
      const id = incidentEvents[0][1].incident.id;
      expect(error).toHaveBeenCalledWith(
        `Similarity failed for incident ${id} (open): feature extraction exploded`,
        boom.stack,
      );
      expect(applyMock.mock.results.every((r) => r.type === 'return')).toBe(true);
    });

    it('emits the snapshot, then incident events, then forecast events, then anomaly events', async () => {
      const { poller, emitted, snapshots } = setup(scripted());

      start(poller);
      await jest.advanceTimersByTimeAsync(5 * INTERVAL); // Polls 0 to 5

      const rank = (e: ReturnType<typeof setup>['emitted'][number]): number =>
        e[0] === 'snapshot'
          ? 0
          : e[0] === 'incident'
            ? 1
            : e[1].type.startsWith('forecast:')
              ? 2
              : 3;
      const kinds = (n: number) => pollEmissions(emitted, n).map((e) => rank(e));

      // Poll 4: forecast warning (payments) only. Poll 5: incident, anomaly.
      expect(pollEmissions(emitted, 4).map(([k]) => k)).toEqual(['snapshot', 'intelligence']);
      expect(kinds(4)).toEqual([0, 2]);
      const poll5 = kinds(5);
      expect(poll5).toEqual([...poll5].sort((a, b) => a - b));
      expect(new Set(poll5)).toEqual(new Set([0, 1, 3]));
      expect(poll5[0]).toBe(0);
      expect(snapshots()).toHaveLength(6);
    });

    it('emits all forecast events before all anomaly events within one Poll', async () => {
      const { poller, emitted } = setup(async () => signals());
      const detected: IntelligenceEvent = {
        type: 'anomaly:detected',
        reading: {
          service: 'orders',
          signal: 'latencyP95Ms',
          value: 1,
          baselineMean: 1,
          baselineStdDev: 1,
          zScore: null,
          method: 'fixed',
        },
      };
      const cleared: IntelligenceEvent = { type: 'forecast:cleared', service: 'payments', reason: 'stopped-rising' };
      const warning: IntelligenceEvent = { type: 'anomaly:cleared', service: 'gateway', signal: 'rssMb' };
      stepMock.mockImplementationOnce((prev) => ({
        state: prev,
        events: [cleared, detected, warning], // step returns forecast first, but the poller must not rely on it
      }));

      start(poller);
      await jest.advanceTimersByTimeAsync(0);

      expect(emitted.map(([kind, e]) => (kind === 'intelligence' ? e.type : kind))).toEqual([
        'snapshot',
        'forecast:cleared',
        'anomaly:detected',
        'anomaly:cleared',
      ]);
    });

    it('repeats the previous anomalies and forecasts in a Blind_Poll snapshot, with no intelligence events', async () => {
      const { poller, collector, emitted, snapshots } = setup(scripted());

      start(poller);
      await jest.advanceTimersByTimeAsync(5 * INTERVAL); // Polls 0 to 5
      const before = snapshots()[5];
      expect(before.anomalies.length).toBeGreaterThan(0);
      expect(before.forecasts.length).toBeGreaterThan(0);

      collector.collect.mockRejectedValueOnce(new MetricsUnavailableError('timed out'));
      await jest.advanceTimersByTimeAsync(INTERVAL); // Poll 6 is blind

      const blind = snapshots()[6];
      expect(blind.metricsAvailable).toBe(false);
      expect(blind.anomalies).toEqual(before.anomalies);
      expect(blind.forecasts).toEqual(before.forecasts);
      expect(pollEmissions(emitted, 6).map(([kind]) => kind)).toEqual(['snapshot']);
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
