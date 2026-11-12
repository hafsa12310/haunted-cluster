import type {
  AnomalyReading,
  ChaosEvent,
  ClusterSnapshot,
  Incident,
  MemoryForecast,
} from '@haunted-cluster/shared';
import { loadEngineConfig } from '../config/engine-config';
import type { IncidentEvent } from '../incidents/incident-tracker';
import { initialTrackerState } from '../incidents/incident-tracker';
import { EngineStateService } from './engine-state.service';
import { EngineServer, EngineSocket, EventsGateway } from './events.gateway';

const CONFIG = loadEngineConfig({
  PROMETHEUS_URL: 'http://prometheus:9090',
  GATEWAY_URL: 'http://gateway:3000',
  ORDERS_URL: 'http://orders:3001',
  PAYMENTS_URL: 'http://payments:3002',
});

const SNAPSHOT: ClusterSnapshot = {
  timestamp: '2026-11-08T12:00:00.000Z',
  metricsAvailable: true,
  services: [],
  dread: 0.4,
  anomalies: [],
  forecasts: [],
};

function incident(id: string, rootService: string): Incident {
  return {
    id,
    status: 'open',
    rootService,
    kinds: ['errors'],
    affected: [],
    fingerprint: `${rootService}:errors`,
    openedAt: '2026-11-08T12:00:00.000Z',
    resolvedAt: null,
    durationMs: null,
    peak: { latencyP95Ms: null, errorRatio: 0.5, rssMb: null, minScore: 40 },
    recurrence: null,
    relatedChaos: [],
    similar: null,
  };
}

/** A gateway over real EngineStateService, with the Socket.IO server replaced by a spy. */
function setup() {
  const state = new EngineStateService(CONFIG);
  const gateway = new EventsGateway(state);
  const server = { emit: jest.fn() };
  gateway.server = server as unknown as EngineServer;
  return { state, gateway, server };
}

/** A connecting client whose `emit` is a spy. */
function fakeClient() {
  const emit = jest.fn();
  return { client: { emit } as unknown as EngineSocket, emit };
}

describe('EventsGateway', () => {
  describe('handleConnection (Requirement 9.4)', () => {
    it('sends only incident:list, with no open incidents, before the first Poll', () => {
      const { gateway, server } = setup();
      const { client, emit } = fakeClient();

      gateway.handleConnection(client);

      expect(emit.mock.calls).toEqual([['incident:list', []]]);
      expect(server.emit).not.toHaveBeenCalled();
    });

    it('sends the latest snapshot, then incident:list with the open incidents in chain order', () => {
      const { state, gateway, server } = setup();
      const orders = incident('o1', 'orders');
      const payments = incident('p1', 'payments');
      state.update(SNAPSHOT, {
        ...initialTrackerState(CONFIG.serviceChain),
        // Stored downstream first, to show the list follows the chain instead.
        open: { payments, orders },
      }, state.intelligence);
      const { client, emit } = fakeClient();

      gateway.handleConnection(client);

      expect(emit.mock.calls).toEqual([
        ['cluster:snapshot', SNAPSHOT],
        ['incident:list', [orders, payments]],
      ]);
      expect(server.emit).not.toHaveBeenCalled();
    });

    it('sends the latest snapshot with its anomalies and forecasts intact (Requirements 10.9, 10.10)', () => {
      const { state, gateway } = setup();
      const withIntel: ClusterSnapshot = {
        ...SNAPSHOT,
        anomalies: [
          {
            service: 'orders',
            signal: 'latencyP95Ms',
            value: 900,
            baselineMean: 100,
            baselineStdDev: 20,
            zScore: 40,
            method: 'learned',
          },
        ],
        forecasts: [
          {
            service: 'payments',
            slopeMbPerSecond: 1.5,
            r2: 0.99,
            latestRssMb: 300,
            timeToLimitSeconds: 120,
            warning: true,
          },
        ],
      };
      state.update(withIntel, initialTrackerState(CONFIG.serviceChain), state.intelligence);
      const { client, emit } = fakeClient();

      gateway.handleConnection(client);

      expect(emit).toHaveBeenCalledWith('cluster:snapshot', withIntel);
    });

    it('sends no cluster:snapshot when none is stored (Requirement 10.9)', () => {
      const { gateway } = setup();
      const { client, emit } = fakeClient();

      gateway.handleConnection(client);

      expect(emit.mock.calls.some(([name]) => name === 'cluster:snapshot')).toBe(false);
    });

    it('sends the snapshot even when metrics were unavailable', () => {
      const { state, gateway } = setup();
      const blind: ClusterSnapshot = { ...SNAPSHOT, metricsAvailable: false, dread: 0 };
      state.update(blind, initialTrackerState(CONFIG.serviceChain), state.intelligence);
      const { client, emit } = fakeClient();

      gateway.handleConnection(client);

      expect(emit).toHaveBeenCalledWith('cluster:snapshot', blind);
    });

    it('sends to the connecting client only, never to the others', () => {
      const { state, gateway, server } = setup();
      state.update(SNAPSHOT, initialTrackerState(CONFIG.serviceChain), state.intelligence);
      const first = fakeClient();
      const second = fakeClient();

      gateway.handleConnection(first.client);
      gateway.handleConnection(second.client);

      expect(first.emit).toHaveBeenCalledTimes(2);
      expect(second.emit).toHaveBeenCalledTimes(2);
      expect(server.emit).not.toHaveBeenCalled();
    });

    it('sends the state as of the moment the client connects', () => {
      const { state, gateway } = setup();
      state.update(SNAPSHOT, initialTrackerState(CONFIG.serviceChain), state.intelligence);
      const early = fakeClient();
      gateway.handleConnection(early.client);

      const later: ClusterSnapshot = { ...SNAPSHOT, dread: 0.9 };
      state.update(later, {
        ...initialTrackerState(CONFIG.serviceChain),
        open: { orders: incident('o1', 'orders') },
      }, state.intelligence);
      const late = fakeClient();
      gateway.handleConnection(late.client);

      expect(early.emit.mock.calls).toEqual([
        ['cluster:snapshot', SNAPSHOT],
        ['incident:list', []],
      ]);
      expect(late.emit.mock.calls).toEqual([
        ['cluster:snapshot', later],
        ['incident:list', [incident('o1', 'orders')]],
      ]);
    });
  });

  describe('broadcasts', () => {
    it.each<[IncidentEvent['type'], string]>([
      ['opened', 'incident:opened'],
      ['updated', 'incident:updated'],
      ['resolved', 'incident:resolved'],
    ])('emitIncidentEvent maps "%s" to %s with the full incident (Requirement 9.3)', (type, name) => {
      const { gateway, server } = setup();
      const inc = incident('i1', 'orders');

      gateway.emitIncidentEvent({ type, incident: inc } as IncidentEvent);

      expect(server.emit.mock.calls).toEqual([[name, inc]]);
    });

    it('emitIncidentEvent sends each event in a Poll under its own name, in order', () => {
      const { gateway, server } = setup();
      const resolved = { ...incident('g1', 'gateway'), status: 'resolved' as const };
      const opened = incident('p1', 'payments');

      gateway.emitIncidentEvent({ type: 'resolved', incident: resolved });
      gateway.emitIncidentEvent({ type: 'opened', incident: opened });

      expect(server.emit.mock.calls).toEqual([
        ['incident:resolved', resolved],
        ['incident:opened', opened],
      ]);
    });

    describe('emitIntelligenceEvent (Requirements 10.5, 10.9, 10.10)', () => {
      const reading: AnomalyReading = {
        service: 'orders',
        signal: 'latencyP95Ms',
        value: 900,
        baselineMean: 100,
        baselineStdDev: 20,
        zScore: 40,
        method: 'learned',
      };
      const forecast: MemoryForecast = {
        service: 'payments',
        slopeMbPerSecond: 1.5,
        r2: 0.99,
        latestRssMb: 300,
        timeToLimitSeconds: 120,
        warning: true,
      };

      it('maps anomaly:detected to the reading', () => {
        const { gateway, server } = setup();
        gateway.emitIntelligenceEvent({ type: 'anomaly:detected', reading });
        expect(server.emit.mock.calls).toEqual([['anomaly:detected', reading]]);
      });

      it('maps anomaly:cleared to { service, signal }', () => {
        const { gateway, server } = setup();
        gateway.emitIntelligenceEvent({ type: 'anomaly:cleared', service: 'orders', signal: 'rssMb' });
        expect(server.emit.mock.calls).toEqual([
          ['anomaly:cleared', { service: 'orders', signal: 'rssMb' }],
        ]);
      });

      it('maps forecast:warning to the forecast', () => {
        const { gateway, server } = setup();
        gateway.emitIntelligenceEvent({ type: 'forecast:warning', forecast });
        expect(server.emit.mock.calls).toEqual([['forecast:warning', forecast]]);
      });

      it('maps forecast:cleared to { service, reason }', () => {
        const { gateway, server } = setup();
        gateway.emitIntelligenceEvent({
          type: 'forecast:cleared',
          service: 'payments',
          reason: 'memory-dropped',
        });
        expect(server.emit.mock.calls).toEqual([
          ['forecast:cleared', { service: 'payments', reason: 'memory-dropped' }],
        ]);
      });
    });

    it('emitSnapshot broadcasts cluster:snapshot (Requirement 9.2)', () => {
      const { gateway, server } = setup();

      gateway.emitSnapshot(SNAPSHOT);

      expect(server.emit.mock.calls).toEqual([['cluster:snapshot', SNAPSHOT]]);
    });

    it('emitChaos broadcasts chaos:triggered (Requirement 7.6)', () => {
      const { gateway, server } = setup();
      const event: ChaosEvent = {
        id: 'c1',
        service: 'payments',
        action: 'crash',
        params: {},
        at: '2026-11-08T12:00:00.000Z',
      };

      gateway.emitChaos(event);

      expect(server.emit.mock.calls).toEqual([['chaos:triggered', event]]);
    });
  });
});
