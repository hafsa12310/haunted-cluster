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
import {
  intelligenceView,
  stepIntelligence,
  type IntelligenceEvent,
} from '../intelligence/intelligence-step';
import { applySimilarity } from '../intelligence/similarity/incident-similarity';
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

    const byService = Object.fromEntries(health.map((h) => [h.service, h])) as Record<
      ServiceName,
      ServiceHealth
    >;
    const attributions = metricsAvailable ? attributeFaults(chain, byService) : [];

    // Pre-Poll state, captured before anything changes (R2.7, R9.3).
    const prevTracker = this.state.tracker;
    const prevIntel = this.state.intelligence;

    const { state: tracker1, events: incidentEvents1 } = trackIncidents(
      prevTracker,
      { now, metricsAvailable, health: byService, attributions, chaosEvents: this.chaosLog.recent() },
      this.config,
      randomUUID,
    );

    // Intelligence step: a failure keeps the previous state and emits nothing.
    let intelligence = prevIntel;
    let intelligenceEvents: IntelligenceEvent[] = [];
    try {
      const openBefore = Object.fromEntries(
        chain.map((s) => [s, prevTracker.open[s] !== undefined]),
      ) as Record<ServiceName, boolean>;
      const result = stepIntelligence(
        prevIntel,
        { now, metricsAvailable, health: byService, openBefore },
        this.config,
      );
      intelligence = result.state;
      intelligenceEvents = result.events;
    } catch (error) {
      this.logger.error(
        `Intelligence step failed: ${describe(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }

    // Similarity matching: failures leave `similar` null and never stop the Poll.
    let tracker2 = tracker1;
    let incidentEvents = incidentEvents1;
    try {
      const applied = applySimilarity(tracker1, incidentEvents1, now, chain, this.config);
      for (const failure of applied.failures) {
        this.logger.error(
          `Similarity failed for incident ${failure.incidentId} (${failure.phase}): ${describe(failure.error)}`,
          failure.error instanceof Error ? failure.error.stack : undefined,
        );
      }
      tracker2 = applied.tracker;
      incidentEvents = applied.events;
    } catch (error) {
      this.logger.error(
        `Similarity step failed: ${describe(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }

    const { anomalies, forecasts } = intelligenceView(intelligence, chain);
    const snapshot: ClusterSnapshot = {
      timestamp: new Date(now).toISOString(),
      metricsAvailable,
      services: health,
      dread: clusterDread(health),
      anomalies,
      forecasts,
    };

    this.state.update(snapshot, tracker2, intelligence);
    this.gateway.emitSnapshot(snapshot);
    for (const event of incidentEvents) this.gateway.emitIncidentEvent(event);
    for (const event of intelligenceEvents) {
      if (event.type.startsWith('forecast:')) this.gateway.emitIntelligenceEvent(event);
    }
    for (const event of intelligenceEvents) {
      if (event.type.startsWith('anomaly:')) this.gateway.emitIntelligenceEvent(event);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
