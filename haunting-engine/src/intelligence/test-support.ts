// TEST-ONLY helper for the intelligence specs. No production file may import it
// (tsconfig.build.json excludes it from the build output).
import * as fc from 'fast-check';
import type {
  MonitoredSignal,
  ServiceHealth,
  ServiceName,
  ServiceSignals,
} from '@haunted-cluster/shared';
import { loadEngineConfig } from '../config/engine-config';
import type { EngineConfig } from '../config/engine-config';
import { scoreService } from '../health/health-scoring';
import type { IntelligenceInput } from './intelligence-step';

export const SIGNALS: readonly MonitoredSignal[] = ['latencyP95Ms', 'errorRatio', 'rssMb'];

/** Names used when generating chains; the first N form a chain of N services. */
const SERVICE_POOL: readonly ServiceName[] = ['gateway', 'orders', 'payments', 'inventory'];

export const MIN_POLLS = 1;
export const MAX_POLLS = 60;
export const MIN_CHAIN = 1;
export const MAX_CHAIN = 4;

/** Recursively freezes a value so any mutation throws in strict mode. Returns the same reference. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    // Justified: walking arbitrary object graphs; every child is passed back through deepFreeze.
    deepFreeze((value as Record<string | symbol, unknown>)[key]);
  }
  return Object.freeze(value);
}

/** Production config with defaults for a chain of services, optionally overridden. */
export function testEngineConfig(
  chain: readonly ServiceName[] = SERVICE_POOL.slice(0, 3),
  overrides: Readonly<Record<string, string>> = {},
): EngineConfig {
  const env: Record<string, string> = {
    PROMETHEUS_URL: 'http://prometheus:9090',
    SERVICE_CHAIN: chain.join(','),
  };
  chain.forEach((service, i) => {
    env[`${service.toUpperCase().replace(/-/g, '_')}_URL`] = `http://${service}:${3000 + i}`;
  });
  return loadEngineConfig({ ...env, ...overrides });
}

/** Signals of a service the engine has no data for. */
export const NO_SIGNALS: ServiceSignals = {
  requestRate: null,
  errorRatio: null,
  latencyP95Ms: null,
  rssMb: null,
  up: null,
};

/** Builds a ServiceHealth through the real `scoreService`. */
export function buildHealth(
  service: ServiceName,
  signals: Partial<ServiceSignals>,
  config: EngineConfig,
): ServiceHealth {
  return scoreService(service, { ...NO_SIGNALS, requestRate: 10, ...signals }, config);
}

/** A healthy, up service with calm signals. */
export function healthyHealth(service: ServiceName, config: EngineConfig): ServiceHealth {
  return buildHealth(
    service,
    { up: true, latencyP95Ms: 50, errorRatio: 0, rssMb: 80 },
    config,
  );
}

/** A service with up === null, so status is `unknown`. */
export function unknownServiceHealth(service: ServiceName, config: EngineConfig): ServiceHealth {
  return scoreService(service, NO_SIGNALS, config);
}

/** A service with up === false, so status is `down`. */
export function downServiceHealth(service: ServiceName, config: EngineConfig): ServiceHealth {
  return buildHealth(service, { up: false, latencyP95Ms: null, errorRatio: null, rssMb: null }, config);
}

/** Health for every service in the chain, keyed by name. */
export function healthMap(
  chain: readonly ServiceName[],
  build: (service: ServiceName) => ServiceHealth,
): Record<ServiceName, ServiceHealth> {
  const out: Record<ServiceName, ServiceHealth> = {};
  for (const service of chain) out[service] = build(service);
  return out;
}

/** A Poll with no Prometheus data: every service unknown. */
export function blindPoll(
  chain: readonly ServiceName[],
  now: number,
  config: EngineConfig,
): IntelligenceInput {
  return {
    now,
    metricsAvailable: false,
    health: healthMap(chain, (s) => unknownServiceHealth(s, config)),
    openBefore: Object.fromEntries(chain.map((s) => [s, false])),
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** How a signal value is produced in one Poll. */
type ValueKind = 'normal' | 'anomalous' | 'null' | 'nan';

const NORMAL_RANGE: Record<MonitoredSignal, [number, number]> = {
  latencyP95Ms: [20, 120],
  errorRatio: [0, 0.02],
  rssMb: [60, 100],
};
const ANOMALOUS_RANGE: Record<MonitoredSignal, [number, number]> = {
  latencyP95Ms: [800, 5000],
  errorRatio: [0.3, 1],
  rssMb: [200, 600],
};

const valueKindArb: fc.Arbitrary<ValueKind> = fc.oneof(
  { weight: 12, arbitrary: fc.constant<ValueKind>('normal') },
  { weight: 4, arbitrary: fc.constant<ValueKind>('anomalous') },
  { weight: 1, arbitrary: fc.constant<ValueKind>('null') },
  { weight: 1, arbitrary: fc.constant<ValueKind>('nan') },
);

type Status = 'up' | 'down' | 'unknown';
const statusArb: fc.Arbitrary<Status> = fc.oneof(
  { weight: 14, arbitrary: fc.constant<Status>('up') },
  { weight: 2, arbitrary: fc.constant<Status>('down') },
  { weight: 1, arbitrary: fc.constant<Status>('unknown') },
);

/** RSS behaviour of one service over the whole sequence: flat, a ramp, and optional restart drops. */
interface RssPlan {
  start: number;
  /** MB per Poll; 0 for a flat series. */
  slopePerPoll: number;
  /** Poll indexes where RSS falls back to `start` (a restart). */
  drops: number[];
}

/** One service in one Poll. */
interface ServicePollDraw {
  status: Status;
  kinds: Record<MonitoredSignal, ValueKind>;
  /** Unit-interval draws that place the value inside its range. */
  fractions: Record<MonitoredSignal, number>;
  open: boolean;
}

const unit = fc.double({ min: 0, max: 1, noNaN: true });

const servicePollArb: fc.Arbitrary<ServicePollDraw> = fc.record({
  status: statusArb,
  kinds: fc.record({
    latencyP95Ms: valueKindArb,
    errorRatio: valueKindArb,
    rssMb: valueKindArb,
  }),
  fractions: fc.record({ latencyP95Ms: unit, errorRatio: unit, rssMb: unit }),
  open: fc.boolean(),
});

const rssPlanArb: fc.Arbitrary<RssPlan> = fc.record({
  start: fc.double({ min: 40, max: 120, noNaN: true }),
  slopePerPoll: fc.oneof(
    { weight: 2, arbitrary: fc.constant(0) },
    { weight: 3, arbitrary: fc.double({ min: 0.5, max: 8, noNaN: true }) },
  ),
  drops: fc.array(fc.integer({ min: 1, max: MAX_POLLS - 1 }), { maxLength: 2 }),
});

/** Chains of 1 to 4 distinct service names, upstream first. */
export const chainArb: fc.Arbitrary<ServiceName[]> = fc
  .integer({ min: MIN_CHAIN, max: MAX_CHAIN })
  .map((n) => SERVICE_POOL.slice(0, n));

export interface PollSequence {
  chain: ServiceName[];
  config: EngineConfig;
  polls: IntelligenceInput[];
}

/** RSS the plan gives at poll index `i`: a ramp since the last drop. */
function rssAt(plan: RssPlan, i: number): number {
  const lastDrop = plan.drops.filter((d) => d <= i).reduce((a, b) => Math.max(a, b), 0);
  return plan.start + plan.slopePerPoll * (i - lastDrop);
}

function valueFor(
  kind: ValueKind,
  signal: MonitoredSignal,
  fraction: number,
  rssPlanValue: number,
): number | null {
  switch (kind) {
    case 'null':
      return null;
    case 'nan':
      return Number.NaN;
    case 'normal':
    case 'anomalous': {
      if (signal === 'rssMb' && kind === 'normal') return rssPlanValue;
      const [lo, hi] = (kind === 'normal' ? NORMAL_RANGE : ANOMALOUS_RANGE)[signal];
      return lo + (hi - lo) * fraction;
    }
  }
}

function toHealth(
  service: ServiceName,
  draw: ServicePollDraw,
  rssPlanValue: number,
  config: EngineConfig,
): ServiceHealth {
  if (draw.status === 'unknown') return unknownServiceHealth(service, config);
  if (draw.status === 'down') return downServiceHealth(service, config);
  const v = (signal: MonitoredSignal): number | null =>
    valueFor(draw.kinds[signal], signal, draw.fractions[signal], rssPlanValue);
  return buildHealth(
    service,
    { up: true, latencyP95Ms: v('latencyP95Ms'), errorRatio: v('errorRatio'), rssMb: v('rssMb') },
    config,
  );
}

/**
 * Poll sequences of 1 to 60 Polls over chains of 1 to 4 services. Per Poll: a blind flag,
 * a per-service status, signal values mixing normal, anomalous, null and NaN, an
 * open-incident map, and RSS ramps and drops. Health goes through the real `scoreService`.
 * Poll timestamps are `startMs + i * pollIntervalMs`.
 */
export function pollSequenceArb(
  options: { minPolls?: number; maxPolls?: number; blindWeight?: number } = {},
): fc.Arbitrary<PollSequence> {
  const minPolls = Math.max(MIN_POLLS, options.minPolls ?? MIN_POLLS);
  const maxPolls = Math.min(MAX_POLLS, options.maxPolls ?? MAX_POLLS);
  const blindWeight = options.blindWeight ?? 1;
  return chainArb.chain((chain) =>
    fc
      .tuple(
        fc.integer({ min: minPolls, max: maxPolls }),
        fc.integer({ min: 1_600_000_000_000, max: 1_900_000_000_000 }),
        fc.tuple(...chain.map(() => rssPlanArb)),
      )
      .chain(([length, startMs, plans]) =>
        fc
          .array(
            fc.record({
              blind: fc.oneof(
                { weight: 12, arbitrary: fc.constant(false) },
                { weight: blindWeight, arbitrary: fc.constant(true) },
              ),
              services: fc.tuple(...chain.map(() => servicePollArb)),
            }),
            { minLength: length, maxLength: length },
          )
          .map((draws): PollSequence => {
            const config = testEngineConfig(chain);
            const polls = draws.map((draw, i): IntelligenceInput => {
              const now = startMs + i * config.pollIntervalMs;
              if (draw.blind) return blindPoll(chain, now, config);
              const health: Record<ServiceName, ServiceHealth> = {};
              const openBefore: Record<ServiceName, boolean> = {};
              chain.forEach((service, k) => {
                health[service] = toHealth(service, draw.services[k], rssAt(plans[k], i), config);
                openBefore[service] = draw.services[k].open;
              });
              return { now, metricsAvailable: true, health, openBefore };
            });
            return { chain, config, polls };
          }),
      ),
  );
}
