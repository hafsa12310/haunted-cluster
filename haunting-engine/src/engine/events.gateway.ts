import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type {
  ChaosEvent,
  ClientToServerEvents,
  ClusterSnapshot,
  ServerToClientEvents,
} from '@haunted-cluster/shared';
import type { Server, Socket } from 'socket.io';
import type { ChaosNotifier } from '../chaos-proxy/chaos-proxy.service';
import type { IncidentEvent } from '../incidents/incident-tracker';
import { EngineStateService } from './engine-state.service';

export type EngineServer = Server<ClientToServerEvents, ServerToClientEvents>;
export type EngineSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

/** Socket.IO event name for each incident event type. */
const INCIDENT_EVENT_NAMES = {
  opened: 'incident:opened',
  updated: 'incident:updated',
  resolved: 'incident:resolved',
} as const satisfies Record<IncidentEvent['type'], keyof ServerToClientEvents>;

/**
 * Streams cluster state, incidents and chaos to the frontend. Listen-only for
 * clients: chaos goes through REST so it gets HTTP status codes. Served on the
 * HTTP port; CORS comes from CorsIoAdapter.
 *
 * Requirements: 1.4, 9.1, 9.2, 9.3, 9.4, 9.5
 */
@WebSocketGateway()
export class EventsGateway implements OnGatewayConnection, ChaosNotifier {
  @WebSocketServer() server: EngineServer;

  constructor(private readonly state: EngineStateService) {}

  /** Requirement 9.4: catch a new client up, without waiting for the next Poll. */
  handleConnection(client: EngineSocket): void {
    const snapshot = this.state.latestSnapshot;
    if (snapshot) client.emit('cluster:snapshot', snapshot);
    client.emit('incident:list', this.state.openIncidents());
  }

  /** Requirement 9.2 */
  emitSnapshot(snapshot: ClusterSnapshot): void {
    this.server.emit('cluster:snapshot', snapshot);
  }

  /** Requirement 9.3 */
  emitIncidentEvent(event: IncidentEvent): void {
    this.server.emit(INCIDENT_EVENT_NAMES[event.type], event.incident);
  }

  /** Requirement 7.6 */
  emitChaos(event: ChaosEvent): void {
    this.server.emit('chaos:triggered', event);
  }
}
