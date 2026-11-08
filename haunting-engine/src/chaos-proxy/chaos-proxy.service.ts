/**
 * Forwards chaos commands from the UI to a victim service's `/chaos/*`
 * endpoints, mapping failures the same way the victim-app's
 * `mapDownstreamError` does. Every accepted command is recorded as a
 * Chaos_Event and announced to connected clients.
 *
 * Requirements: 7.1, 7.4, 7.5, 7.6
 */

import { randomUUID } from 'node:crypto';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { ChaosAction, ChaosEvent, ServiceName } from '@haunted-cluster/shared';
import { CLOCK, Clock, ENGINE_CONFIG } from '../config/config.module';
import type { EngineConfig } from '../config/engine-config';
import { ChaosLogService } from './chaos-log.service';

/** Whatever tells connected clients about chaos; `EventsGateway` in the running app. */
export interface ChaosNotifier {
  emitChaos(event: ChaosEvent): void;
}

/** Injection token for the `ChaosNotifier`. */
export const CHAOS_NOTIFIER = Symbol('CHAOS_NOTIFIER');

export type ChaosParams = Record<string, number | boolean>;

export interface ProxyResponse {
  status: number;
  body: unknown;
}

export interface ResetResult {
  service: ServiceName;
  ok: boolean;
  status?: number;
  message?: string;
}

@Injectable()
export class ChaosProxyService {
  constructor(
    @Inject(ENGINE_CONFIG) private readonly config: EngineConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CHAOS_NOTIFIER) private readonly notifier: ChaosNotifier,
    private readonly chaosLog: ChaosLogService,
  ) {}

  /**
   * POSTs `/chaos/<action>` on `service`. A 2xx is passed through and recorded;
   * a 4xx is passed through; anything else becomes a 502 or 504.
   * Requirements: 7.1, 7.4, 7.6
   */
  async forward(service: ServiceName, action: ChaosAction, body?: ChaosParams): Promise<ProxyResponse> {
    const response = await this.send(service, 'POST', action, body);
    if (isSuccess(response.status)) this.recordChaos(service, action, body ?? {});
    return response;
  }

  /**
   * GETs `/chaos/state` on `service`. Throws an `HttpException` with the same
   * mapping as `forward` when the victim doesn't answer with a 2xx.
   * Requirements: 7.1, 7.4
   */
  async state(service: ServiceName): Promise<unknown> {
    const response = await this.send(service, 'GET', 'state');
    if (!isSuccess(response.status)) {
      const body = isRecord(response.body)
        ? response.body
        : { message: messageOf(response.body) ?? `${service} chaos state failed` };
      throw new HttpException(body, response.status);
    }
    return response.body;
  }

  /**
   * Resets every service in the chain; one failing never fails the others.
   * Requirements: 7.5, 7.6
   */
  async resetAll(): Promise<{ results: ResetResult[] }> {
    const chain = this.config.serviceChain;
    const settled = await Promise.allSettled(chain.map((s) => this.forward(s, 'reset')));
    return {
      results: settled.map((outcome, i): ResetResult => {
        const service = chain[i];
        // forward() maps every failure to a response, so a rejection is unexpected.
        if (outcome.status === 'rejected') {
          return { service, ok: false, message: errorMessage(outcome.reason) };
        }
        const { status, body } = outcome.value;
        return isSuccess(status)
          ? { service, ok: true, status }
          : { service, ok: false, status, message: messageOf(body) };
      }),
    };
  }

  /** Calls the victim and maps the outcome per design.md's error table. */
  private async send(
    service: ServiceName,
    method: 'GET' | 'POST',
    path: ChaosAction | 'state',
    body?: ChaosParams,
  ): Promise<ProxyResponse> {
    const url = `${this.config.serviceUrls[service].replace(/\/+$/, '')}/chaos/${path}`;

    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.config.chaosProxyTimeoutMs),
      });
      text = await response.text();
    } catch (error) {
      // Checked by name: fetch's errors can come from another realm, failing instanceof.
      const name = isRecord(error) ? error.name : undefined;
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { status: 504, body: { message: `${service} timed out` } };
      }
      return { status: 502, body: { message: `${service} service unavailable` } };
    }

    if (response.status >= 500) {
      return { status: 502, body: { message: `${service} chaos endpoint failed` } };
    }
    return { status: response.status, body: parseBody(text) };
  }

  private recordChaos(service: ServiceName, action: ChaosAction, params: ChaosParams): void {
    const event: ChaosEvent = {
      id: randomUUID(),
      service,
      action,
      params,
      at: new Date(this.clock.now()).toISOString(),
    };
    this.chaosLog.record(event);
    this.notifier.emitChaos(event);
  }
}

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

/** JSON if possible; otherwise the raw text, or null for an empty body. */
function parseBody(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function messageOf(body: unknown): string | undefined {
  if (isRecord(body) && typeof body.message === 'string') return body.message;
  // Nest's ValidationPipe sends an array of messages.
  if (isRecord(body) && Array.isArray(body.message)) return body.message.join(', ');
  return typeof body === 'string' && body !== '' ? body : undefined;
}

function errorMessage(error: unknown): string {
  return isRecord(error) && typeof error.message === 'string' ? error.message : String(error);
}
