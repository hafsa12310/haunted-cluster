import { Injectable } from '@nestjs/common';
import type { ChaosEvent } from '@haunted-cluster/shared';

/** Requirement 8.2: at most this many Chaos_Events are kept. */
export const CHAOS_LOG_LIMIT = 100;

/**
 * The most recent chaos commands accepted by victim services, newest first.
 * Purely in-memory; the incident tracker reads it as evidence for new incidents.
 *
 * Requirements: 8.2
 */
@Injectable()
export class ChaosLogService {
  private events: ChaosEvent[] = [];

  /** Adds `event` as the newest, discarding the oldest beyond the limit. */
  record(event: ChaosEvent): void {
    this.events = [event, ...this.events].slice(0, CHAOS_LOG_LIMIT);
  }

  /** Newest first. A copy, so callers can't change the log. */
  recent(): ChaosEvent[] {
    return [...this.events];
  }
}
