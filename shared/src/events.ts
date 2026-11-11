/**
 * Socket.IO event contract between the haunting-engine and the frontend.
 * Used as the type parameters of the Socket.IO server and client.
 *
 * Requirements: 1.1, 1.4
 */
import type { ChaosEvent } from './chaos';
import type { Incident } from './incident';
import type {
  AnomalyClearedPayload,
  AnomalyReading,
  ForecastClearedPayload,
  MemoryForecast,
} from './intelligence';
import type { ClusterSnapshot } from './service-health';

export interface ServerToClientEvents {
  'cluster:snapshot': (snapshot: ClusterSnapshot) => void;
  'incident:list': (open: Incident[]) => void;
  'incident:opened': (incident: Incident) => void;
  'incident:updated': (incident: Incident) => void;
  'incident:resolved': (incident: Incident) => void;
  'chaos:triggered': (event: ChaosEvent) => void;
  'anomaly:detected': (reading: AnomalyReading) => void;
  'anomaly:cleared': (payload: AnomalyClearedPayload) => void;
  'forecast:warning': (forecast: MemoryForecast) => void;
  'forecast:cleared': (payload: ForecastClearedPayload) => void;
}

/** The frontend only listens; chaos goes through REST so it gets HTTP status codes. */
export type ClientToServerEvents = Record<string, never>;
