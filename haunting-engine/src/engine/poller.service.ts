import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { ClusterSnapshot, ServiceHealth, ServiceName } from '@haunted-cluster/shared';
import { ChaosLogService } from '../chaos-proxy/chaos-log.service';
import { CLOCK, Clock, ENGINE_CONFIG } from '../config/config.module';
import type { EngineConfig } from '../config/engine-config';
import { clusterDread, scoreService, unknownHealth } from '../health/health-scoring';
import { attributeFaults } from '../incidents/attribution';
import { trackIncidents } from '../incidents/incident-tracker';
import { MetricsCollectorService } from '../metrics/metrics-collector.service';
import { MetricsUnavailableError } from '../metrics/prometheus.client';
import { EngineStateService } from './engine-state.service';
import { EventsGateway } from './events.gateway';

/**
 * Runs one Poll every `pollIntervalMs`: collect → score → attribute → track →
 * store → emit. The only writer of EngineStateService.
 *
 * A setTimeout chain rather than setInterval: the next Poll is scheduled only
 * when the current one has finished, so a slow Prometheus can never cause
 * overlapping Polls (Requirement 2.7).
 *
 * Requirements: 2.1, 2.7, 9.2, 9.3, 11.1, 11.2
 */
@Injectable()
export class PollerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PollerService.name);
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    @Inject(ENGINE_CONFIG) private readonly config: EngineConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly collector: MetricsCollectorService,
    private readonly chaosLog: ChaosLogService,
    private readonly state: EngineStateService,
    private readonly gateway: EventsGateway,
  ) {}

  onApplicationBootstrap(): void {
    this.stopped = false;
    this.schedule(0);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  /** One Poll, then the next one `pollIntervalMs` after this one started. */
  private async tick(): Promise<void> {
    this.timer = undefined;
    const started = this.clock.now();
    try {
      await this.poll(started);
    } catch (error) {
      // Requirement 11.2: never swallowed, and never the end of the loop.
      this.logger.error(
        `Poll failed unexpectedly: ${describe(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
    const elapsed = this.clock.now() - started;
    this.schedule(Math.max(0, this.config.pollIntervalMs - elapsed));
  }

  private async poll(now: number): Promise<void> {
    const chain = this.config.serviceChain;

    let health: ServiceHealth[];
    let metricsAvailable: boolean;
    try {
      const signals = await this.collector.collect();
      health = chain.map((s) => scoreService(s, signals[s], this.config));
      metricsAvailable = true;
    } catch (error) {
      if (!(error instanceof MetricsUnavailableError)) throw error;
      // Requirement 11.1: blind, so every service is unknown, never healthy.
      this.logger.warn(`Poll failed: metrics unavailable (${error.message})`);
      health = chain.map((s) => unknownHealth(s));
      metricsAvailable = false;
    }

    const snapshot: ClusterSnapshot = {
      timestamp: new Date(now).toISOString(),
      metricsAvailable,
      services: health,
      dread: clusterDread(health),
      anomalies: [],
      forecasts: [],
    };
    const byService = Object.fromEntries(health.map((h) => [h.service, h])) as Record<
      ServiceName,
      ServiceHealth
    >;
    const attributions = metricsAvailable ? attributeFaults(chain, byService) : [];
    const { state, events } = trackIncidents(
      this.state.tracker,
      { now, metricsAvailable, health: byService, attributions, chaosEvents: this.chaosLog.recent() },
      this.config,
      randomUUID,
    );

    this.state.update(snapshot, state);
    this.gateway.emitSnapshot(snapshot);
    for (const event of events) this.gateway.emitIncidentEvent(event);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
