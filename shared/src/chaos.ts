/**
 * Chaos commands sent through the haunting-engine's chaos proxy.
 *
 * Requirements: 1.1
 */
import type { ServiceName } from './service-health';

export type ChaosAction = 'latency' | 'error-rate' | 'memory-leak' | 'crash' | 'reset';

export interface ChaosEvent {
  id: string;
  service: ServiceName;
  action: ChaosAction;
  /** e.g. { ms: 1500 }; {} for crash and reset. */
  params: Record<string, number | boolean>;
  /** ISO 8601. */
  at: string;
}
