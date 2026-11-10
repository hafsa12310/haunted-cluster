# Design Document

## Overview

The haunting-engine is a standalone **NestJS application** (port 4000) that sits between Prometheus and the haunted-house frontend. Every `POLL_INTERVAL_MS` it runs one **Poll**:

```
Prometheus ──(5 PromQL instant queries)──► MetricsCollector ──► ServiceSignals per service
                                                                       │
                                                        scoreService() │  (pure)
                                                                       ▼
                                                               ServiceHealth[] + dread
                                                                       │
                                                  attributeFaults()    │  (pure)
                                                                       ▼
                                                               Attribution[]
                                                                       │
                                                  trackIncidents()     │  (pure reducer)
                                                                       ▼
                                                     new TrackerState + IncidentEvent[]
                                                                       │
                                                       EventsGateway   ▼
                                     cluster:snapshot / incident:* ──► Socket.IO clients
```

All decision-making (scoring, attribution, incident lifecycle, recurrence) is done by **pure functions** that take plain data and return plain data. The NestJS services around them only do I/O: querying Prometheus, holding state, emitting events, and forwarding chaos commands. That split is what makes the core logic property-testable without timers, sockets or HTTP.

Design goals:
- **Grounded**: every number the frontend or narrator sees comes from a Prometheus sample or a recorded chaos command. Missing data is `null`, never a guessed zero (one exception: a missing error series alongside real traffic means "no errors yet", Requirement 2.5).
- **Honest when blind**: if Prometheus can't be reached, every service is `unknown` and incidents are frozen. The engine never shows "healthy" while it can't see.
- **Stable**: hysteresis on open/close stops a jittery rate window from flapping incidents, while crashes (`down`) bypass it because a restarted container may only miss one scrape.
- **One contract**: every payload type lives in `shared/` and is imported by both sides.

---

## Architecture

### Repository Layout

```
shared/                         # types-only package (Requirement 1)
  package.json                  # { "name": "@haunted-cluster/shared", "private": true, "types": "dist/index.d.ts" }
  tsconfig.json                 # emitDeclarationOnly → dist/
  src/
    index.ts                    # re-exports everything below
    service-health.ts           # ServiceName, SignalKind, ServiceSignals, ServiceStatus, ServiceHealth, ClusterSnapshot
    incident.ts                 # Incident, AffectedService, PeakSignals, IncidentRecurrence
    chaos.ts                    # ChaosAction, ChaosEvent
    events.ts                   # ServerToClientEvents, ClientToServerEvents

haunting-engine/
  Dockerfile                    # build context = repo root
  .env.example
  nest-cli.json
  package.json
  tsconfig.json                 # paths: @haunted-cluster/shared → ../shared/dist/index
  tsconfig.build.json           # rootDir: ./src, excludes specs and test/
  src/
    main.ts
    app.module.ts
    config/
      engine-config.ts          # loadEngineConfig(env): EngineConfig  (pure)
      config.module.ts          # provides ENGINE_CONFIG token (global)
    metrics/
      promql.ts                 # buildQueries(config)  (pure)
      prometheus.client.ts      # PrometheusClient: instant queries + parseVector()
      metrics-collector.service.ts
      metrics.module.ts
    health/
      health-scoring.ts         # badness(), scoreService(), clusterDread()  (pure)
    incidents/
      attribution.ts            # attributeFaults()  (pure)
      incident-tracker.ts       # trackIncidents(), fingerprint(), initialTrackerState()  (pure)
      incidents.controller.ts   # GET /api/incidents
      incidents.module.ts
    chaos-proxy/
      dto/                      # SetLatencyDto, SetErrorRateDto, SetMemoryLeakDto
      chaos-log.service.ts      # bounded ring of ChaosEvents
      chaos-proxy.service.ts    # forwards to victim /chaos/*
      chaos-proxy.controller.ts # /api/chaos/*
      known-service.pipe.ts     # 404 for services outside SERVICE_CHAIN
      chaos-proxy.module.ts
    engine/
      engine-state.service.ts   # latest snapshot + TrackerState holder
      poller.service.ts         # setTimeout loop: collect → score → attribute → track → emit
      events.gateway.ts         # Socket.IO
      snapshot.controller.ts    # GET /api/snapshot
      health.controller.ts      # GET /health
      engine.module.ts
  test/
    jest-e2e.json
    helpers.ts
    *.e2e-spec.ts
```

### Why `shared/` is types-only and imported from `dist/`

The obvious setup, a `paths` alias pointing at `../shared/src/index.ts`, would pull a `.ts` file from outside `src/` into the compilation. TypeScript would then widen `rootDir` to the repo root and emit `dist/haunting-engine/src/main.js` instead of `dist/main.js`. That is exactly the nested-output problem that broke the victim-app Dockerfile `CMD` in task 12.

Instead:
- `shared/` compiles with `emitDeclarationOnly: true` to `shared/dist/*.d.ts`. Declaration files don't affect `rootDir`.
- The engine's `paths` maps `@haunted-cluster/shared` to `../shared/dist/index`.
- `tsconfig.build.json` sets `rootDir: "./src"` explicitly, so anything that sneaks in from outside `src/` is a compile error rather than a silently moved entry point.
- Because `shared/` contains only `interface` and `type` declarations, every import of it is erased at compile time. The runtime image never needs `shared/`.
- `npm run build:shared` (`tsc -p ../shared/tsconfig.json`, using the engine's TypeScript) runs as `prebuild` and `pretest`, so the declarations always exist before compiling or type-checking.

### Module Wiring

```
AppModule
├── ConfigModule (global)        ENGINE_CONFIG
├── MetricsModule                PrometheusClient, MetricsCollectorService
├── ChaosProxyModule             ChaosLogService, ChaosProxyService, ChaosProxyController
├── IncidentsModule              IncidentsController            (reads EngineStateService)
└── EngineModule                 EngineStateService, PollerService, EventsGateway,
                                 SnapshotController, HealthController
```

`EngineStateService` is the single owner of mutable state (latest `ClusterSnapshot`, `TrackerState`). `PollerService` is the only writer. Controllers and the gateway only read it.

---

## Components and Interfaces

### Configuration (`config/engine-config.ts`)

```ts
interface Thresholds { ok: number; critical: number }

interface EngineConfig {
  port: number;
  prometheusUrl: string;
  serviceChain: string[];                  // upstream → downstream
  serviceUrls: Record<string, string>;     // from <SERVICE>_URL
  pollIntervalMs: number;
  rateWindow: string;                      // PromQL duration, e.g. "15s"
  prometheusTimeoutMs: number;
  latencyMs: Thresholds;
  errorRatio: Thresholds;
  memoryMb: Thresholds;
  openAfterPolls: number;
  closeAfterPolls: number;
  incidentHistoryLimit: number;
  chaosEvidenceWindowSeconds: number;
  chaosProxyTimeoutMs: number;
  corsOrigin: string;
}

function loadEngineConfig(env: NodeJS.ProcessEnv): EngineConfig; // throws ConfigError
```

`loadEngineConfig` is pure: it throws a `ConfigError` naming the variable. `main.ts` catches it, logs `[Bootstrap] <message>. Exiting.`, and calls `process.exit(1)` before `NestFactory.create`. Validation:
- `PROMETHEUS_URL` and `<SERVICE>_URL` for each chain entry (upper-cased, `-` → `_`) are required.
- Numeric variables must parse to finite numbers; poll counts and limits must be positive integers.
- `RATE_WINDOW` must match `/^\d+[smh]$/`.
- Every threshold pair must satisfy `ok < critical`.
- `SERVICE_CHAIN` must be non-empty with no duplicates.

### PromQL (`metrics/promql.ts`)

`buildQueries(config)` returns five instant queries (`W` = `rateWindow`, `JOBS` = chain joined with `|`):

| Signal | Query |
|---|---|
| request rate | `sum by (service) (rate(http_requests_total[W]))` |
| error rate | `sum by (service) (rate(http_errors_total[W]))` |
| p95 latency (s) | `histogram_quantile(0.95, sum by (service, le) (rate(http_request_duration_seconds_bucket[W])))` |
| RSS (bytes) | `max by (service) (process_rss_bytes)` |
| scrape health | `up{job=~"JOBS"}` |

`up` is labelled by Prometheus's `job`, everything else by the app's `service` label. This relies on `job_name` in `prometheus/prometheus.yml` matching the service name, which it does (`gateway`, `orders`, `payments`). The design records this as an invariant; a mismatch would show the service as `unknown`, not as healthy.

Notes on the victim metrics this depends on:
- Latency buckets top out at 10 s; a p95 in the `+Inf` bucket reads as 10 000 ms, which is far past `LATENCY_CRITICAL_MS` anyway.
- `http_errors_total` has no series for a service until its first 5xx, which is why a missing error series means 0 (Requirement 2.5).
- When a scrape fails, Prometheus marks that target's series stale, so a crashed service's app metrics disappear and only `up == 0` remains.

### PrometheusClient (`metrics/prometheus.client.ts`)

```ts
type Vector = Map<string, number | null>;  // label value → sample (null for NaN/±Inf/unparseable)

class PrometheusClient {
  query(promql: string, labelKey: 'service' | 'job'): Promise<Vector>;
}

function parseVector(body: unknown, labelKey: string): Vector;  // pure, never throws on sample values
```

- Uses Node's global `fetch` on `GET <PROMETHEUS_URL>/api/v1/query?query=…` with `AbortSignal.timeout(prometheusTimeoutMs)`.
- Throws `MetricsUnavailableError` (with the cause) on network failure, timeout, non-2xx, or a body whose `status` isn't `"success"` / whose shape isn't a vector. That's a whole-Poll failure (Requirement 11.1).
- Individual sample values (`"NaN"`, `"+Inf"`, `"-Inf"`, garbage) become `null`. Series missing the label key are skipped.

### MetricsCollectorService (`metrics/metrics-collector.service.ts`)

```ts
collect(): Promise<Record<ServiceName, ServiceSignals>>
```

Runs the five queries in parallel with `Promise.all`; any rejection fails the whole collection. Then for each service in the chain:

```
requestRate  = rate[service] ?? null
errorRate    = errors.has(service) ? errors[service] : (requestRate != null ? 0 : null)
errorRatio   = requestRate && requestRate > 0 && errorRate != null ? errorRate / requestRate : null
latencyP95Ms = p95[service] != null ? p95[service] * 1000 : null
rssMb        = rss[service] != null ? rss[service] / 1_048_576 : null
up           = up.has(service) ? (up[service] === 1) : null
```

### Health Scoring (`health/health-scoring.ts`), pure

```ts
const BREACH_BADNESS = 0.2;
const CRITICAL_BADNESS = 0.6;

function badness(value: number | null, t: Thresholds): number;
// null → 0, else clamp((value − t.ok) / (t.critical − t.ok), 0, 1)

function scoreService(service: ServiceName, s: ServiceSignals, config: EngineConfig): ServiceHealth;
function clusterDread(services: ServiceHealth[]): number;
```

`scoreService` logic:

```
b = { latency: badness(s.latencyP95Ms, latencyMs), errors: badness(s.errorRatio, errorRatio), memory: badness(s.rssMb, memoryMb) }
maxB = max(b.latency, b.errors, b.memory)

if s.up === null  → status 'unknown',  score null, breachedKinds []
if s.up === false → status 'down',     score 0,    breachedKinds ['down']
else
  score  = round(100 × (1 − maxB))
  status = maxB ≤ 0.2 ? 'healthy' : maxB ≤ 0.6 ? 'degraded' : 'critical'
  breachedKinds = kinds with b[k] > 0.2, in the order errors, latency, memory
```

Status is derived from `maxB`, not from the rounded score, so status and `breachedKinds` can never disagree (a service is non-healthy if and only if it has at least one breached kind).

`clusterDread`: max over services of (`down` → 1, `unknown` → skipped, otherwise `maxB`); 0 when no service contributes.

With the default thresholds, roughly: healthy means p95 ≤ 280 ms, errors ≤ 4.8 %, RSS ≤ 142 MB. A judge setting 500 ms of latency gets `degraded`, ≥ 1000 ms gets `critical`. 10 % errors gives `degraded`, 50 % gives `critical`.

### Fault Attribution (`incidents/attribution.ts`), pure

```ts
interface Attribution {
  rootService: ServiceName;
  kinds: SignalKind[];                                       // root's own breached kinds
  affected: { service: ServiceName; kinds: SignalKind[] }[]; // upstream, chain order
}

function attributeFaults(chain: ServiceName[], health: Record<ServiceName, ServiceHealth>): Attribution[];
```

Algorithm:

```
known = chain filtered to status ≠ 'unknown'
prop(s) = breachedKinds(s) ∩ {down, errors, latency}

root = last service in `known` (most downstream) with prop(s) non-empty
if root:
  add { rootService: root, kinds: prop(root),
        affected: [ {service: u, kinds: prop(u)} for u in known upstream of root with prop(u) non-empty ] }

for s in known with 'memory' ∈ breachedKinds(s):
  if an attribution for s exists → add 'memory' to its kinds
  else add { rootService: s, kinds: ['memory'], affected: [] }

return attributions in chain order
```

**Known limitation (documented, accepted):** two independent propagating faults in the same chain at once, for example latency injected on gateway while payments throws errors, are reported as one incident rooted at the downstream service, with the upstream service listed as affected *with its own kinds*. The narrator can still see gateway's latency in `affected`. Separating the two would require knowing which upstream errors were caused by downstream ones, which aggregate metrics can't tell us.

Worked examples (chain `gateway → orders → payments`):

| Chaos | Breaches observed | Attribution |
|---|---|---|
| 100 % errors on orders | gateway: errors, orders: errors | root orders [errors], affected gateway [errors] |
| 1500 ms latency on payments | all three: latency | root payments [latency], affected orders, gateway |
| 6000 ms latency on payments (> 5 s downstream timeout) | payments: latency; orders, gateway: errors+latency | root payments [latency], affected orders, gateway [errors, latency] |
| payments crashed | payments: down; orders, gateway: errors | root payments [down], affected orders, gateway |
| memory leak on orders | orders: memory | root orders [memory] |

### Incident Tracker (`incidents/incident-tracker.ts`), pure

```ts
interface TrackerState {
  open: Record<ServiceName, Incident>;                                // at most one per root
  streaks: Record<ServiceName, { asRoot: number; notRoot: number }>;
  history: Incident[];                                                // resolved, newest first, ≤ limit
}

type IncidentEvent =
  | { type: 'opened'; incident: Incident }
  | { type: 'updated'; incident: Incident }
  | { type: 'resolved'; incident: Incident };

interface PollInput {
  now: number;                                         // epoch ms
  metricsAvailable: boolean;
  health: Record<ServiceName, ServiceHealth>;
  attributions: Attribution[];
  chaosEvents: ChaosEvent[];                           // newest first
}

function trackIncidents(
  state: TrackerState, input: PollInput, config: EngineConfig, newId: () => string,
): { state: TrackerState; events: IncidentEvent[] };

function fingerprint(rootService: ServiceName, kinds: SignalKind[], health: ServiceHealth): string;
```

Per Poll:

```
if !metricsAvailable → return (state unchanged, events [])          // Req 5.6

roots = map rootService → attribution
for s in chain (in order):
  if health[s].status === 'unknown' → skip (streaks frozen)
  if s ∈ roots:
    streak.asRoot += 1; streak.notRoot = 0
    if s not open and (streak.asRoot ≥ openAfterPolls or 'down' ∈ roots[s].kinds):
        open new Incident  → event 'opened'
    else if s open:
        merge kinds (union) + replace affected + raise peaks
        if kinds or affected changed → event 'updated'
  else:
    streak.notRoot += 1; streak.asRoot = 0
    if s open and streak.notRoot ≥ closeAfterPolls:
        resolve (resolvedAt = now, durationMs = now − openedAt)
        prepend to history, trim to incidentHistoryLimit → event 'resolved'
```

Opening an incident:
- `fingerprint = "<root>:<primaryKind>"`, where `primaryKind` = `down` if present, else the kind with the highest badness among the root's kinds, ties broken `errors` > `latency` > `memory`.
- `recurrence`: matches = history entries with the same fingerprint; `null` if none, else `{ count: matches.length, lastIncidentId, lastResolvedAt, lastDurationMs }` from `matches[0]` (newest).
- `relatedChaos`: `chaosEvents` with `service === root` and `at ≥ now − chaosEvidenceWindowSeconds × 1000`, newest first.
- `peak`: the root's current `latencyP95Ms`, `errorRatio`, `rssMb` and `score`; later Polls keep the max of each value and the min score.

Kinds only ever grow while an incident is open (union). That keeps the story "it started as latency, then errors appeared" intact for the narrator, and stops kinds from flickering when a signal hovers around the breach line.

### ChaosLogService (`chaos-proxy/chaos-log.service.ts`)

Holds up to 100 `ChaosEvent`s, newest first (`record(event)`, `recent(): ChaosEvent[]`). Purely in-memory.

### ChaosProxyService (`chaos-proxy/chaos-proxy.service.ts`)

```ts
forward(service: ServiceName, action: ChaosAction, body?: Record<string, number | boolean>): Promise<{ status: number; body: unknown }>;
state(service: ServiceName): Promise<unknown>;
resetAll(): Promise<{ results: { service: ServiceName; ok: boolean; status?: number; message?: string }[] }>;
```

- Uses `fetch` with `AbortSignal.timeout(chaosProxyTimeoutMs)` against `serviceUrls[service] + '/chaos/<action>'`.
- Error mapping (Requirement 7.4), mirroring the victim-app's `mapDownstreamError`:

| Victim outcome | Engine response |
|---|---|
| 2xx (including `202` from `/crash`) | same status and body; Chaos_Event recorded and `chaos:triggered` emitted |
| 4xx | same status and body passed through (shouldn't happen after engine-side validation) |
| 5xx | 502 `{ message: "<service> chaos endpoint failed" }` |
| network error | 502 `{ message: "<service> service unavailable" }` |
| `TimeoutError` / `AbortError` | 504 `{ message: "<service> timed out" }` |

- `resetAll` uses `Promise.allSettled`, records a Chaos_Event per successful reset, and always returns 200 with per-service results.

### ChaosProxyController (`chaos-proxy/chaos-proxy.controller.ts`), prefix `/api/chaos`

| Route | Body | Forwards to |
|---|---|---|
| `POST /:service/latency` | `SetLatencyDto { ms }` | `/chaos/latency` |
| `POST /:service/error-rate` | `SetErrorRateDto { percentage }` | `/chaos/error-rate` |
| `POST /:service/memory-leak` | `SetMemoryLeakDto { enabled }` | `/chaos/memory-leak` |
| `POST /:service/crash` | none | `/chaos/crash` |
| `POST /:service/reset` | none | `/chaos/reset` |
| `GET /:service/state` | none | `/chaos/state` |
| `POST /reset-all` | none | `/chaos/reset` on every service |

`:service` passes through `KnownServicePipe`, which throws `NotFoundException` (`{ message: "unknown service: <name>" }`) for names outside `SERVICE_CHAIN`. The controller sets the HTTP status from the forwarded response with `@Res({ passthrough: true })`. `/reset-all` is declared before `/:service/...` routes so it isn't captured as a service name.

The DTOs duplicate the victim's validation rules on purpose: the engine is a separate deployable and must reject bad input before it reaches a victim service. They are not event payloads, so they don't belong in `shared/`.

### EngineStateService (`engine/engine-state.service.ts`)

```ts
latestSnapshot: ClusterSnapshot | null;
tracker: TrackerState;
openIncidents(): Incident[];        // chain order
resolvedIncidents(): Incident[];    // newest first
```

### PollerService (`engine/poller.service.ts`)

- `onApplicationBootstrap` schedules the first Poll; `onModuleDestroy` clears the pending timer and sets `stopped = true`.
- Uses a **`setTimeout` chain, not `setInterval`**: the next Poll is scheduled only after the current one finishes, with delay `max(0, pollIntervalMs − elapsed)`. A slow Prometheus can therefore never cause overlapping Polls (Requirement 2.7).
- One Poll:

```
now = clock.now()
try
  signals = await collector.collect()
  health  = chain.map(s => scoreService(s, signals[s], config))
  metricsAvailable = true
catch (MetricsUnavailableError e)
  logger.warn('Poll failed: metrics unavailable', e.cause)
  health = chain.map(s => unknownHealth(s))
  metricsAvailable = false

snapshot = { timestamp: iso(now), metricsAvailable, services: health, dread: clusterDread(health) }
attributions = metricsAvailable ? attributeFaults(chain, byService(health)) : []
{ state, events } = trackIncidents(state.tracker, { now, metricsAvailable, health, attributions,
                                                    chaosEvents: chaosLog.recent() }, config, randomUUID)
engineState.update(snapshot, state)
gateway.emitSnapshot(snapshot); events.forEach(gateway.emitIncidentEvent)
```

Any other (unexpected) error is logged with `logger.error` and the loop continues. It is never swallowed silently, and the loop never dies.

`Clock` is an injectable token (`{ now(): number }`, default `Date.now`) so tests can control time.

### EventsGateway (`engine/events.gateway.ts`)

```ts
@WebSocketGateway({ cors: { origin: config.corsOrigin } })
class EventsGateway implements OnGatewayConnection {
  @WebSocketServer() server: Server<ClientToServerEvents, ServerToClientEvents>;
  handleConnection(client): void;          // emits cluster:snapshot (if any) + incident:list to this client
  emitSnapshot(s: ClusterSnapshot): void;
  emitIncidentEvent(e: IncidentEvent): void;
  emitChaos(e: ChaosEvent): void;
}
```

The gateway decorator options are evaluated at class-definition time, before DI, so CORS is set up in `main.ts` with a custom `IoAdapter` subclass that reads `corsOrigin` from config. `app.enableCors({ origin: corsOrigin })` covers the REST API.

### REST Read Controllers

- `HealthController`: `GET /health` → `{ status: 'ok', service: 'haunting-engine' }`.
- `SnapshotController`: `GET /api/snapshot` → latest snapshot, or `ServiceUnavailableException('no poll has completed yet')`.
- `IncidentsController`: `GET /api/incidents` → `{ open, resolved }`.

---

## Data Models

All types below live in `shared/src/` and are imported by both the Engine and the frontend.

```ts
// service-health.ts
export type ServiceName = string;   // values come from SERVICE_CHAIN
export type SignalKind = 'latency' | 'errors' | 'memory' | 'down';
export type ServiceStatus = 'healthy' | 'degraded' | 'critical' | 'down' | 'unknown';

export interface ServiceSignals {
  requestRate: number | null;     // requests per second
  errorRatio: number | null;      // 0–1
  latencyP95Ms: number | null;
  rssMb: number | null;
  up: boolean | null;
}

export interface ServiceHealth {
  service: ServiceName;
  status: ServiceStatus;
  score: number | null;           // 0–100, null when unknown
  signals: ServiceSignals;
  badness: { latency: number; errors: number; memory: number };   // each 0–1
  breachedKinds: SignalKind[];
}

export interface ClusterSnapshot {
  timestamp: string;              // ISO 8601
  metricsAvailable: boolean;
  services: ServiceHealth[];      // SERVICE_CHAIN order, upstream first
  dread: number;                  // 0–1
}

// incident.ts
export interface AffectedService { service: ServiceName; kinds: SignalKind[] }

export interface PeakSignals {
  latencyP95Ms: number | null;
  errorRatio: number | null;
  rssMb: number | null;
  minScore: number | null;
}

export interface IncidentRecurrence {
  count: number;                  // matching resolved incidents in history
  lastIncidentId: string;
  lastResolvedAt: string;
  lastDurationMs: number;
}

export interface Incident {
  id: string;                     // UUID v4
  status: 'open' | 'resolved';
  rootService: ServiceName;
  kinds: SignalKind[];
  affected: AffectedService[];
  fingerprint: string;            // "<rootService>:<primaryKind>"
  openedAt: string;
  resolvedAt: string | null;
  durationMs: number | null;
  peak: PeakSignals;
  recurrence: IncidentRecurrence | null;
  relatedChaos: ChaosEvent[];
}

// chaos.ts
export type ChaosAction = 'latency' | 'error-rate' | 'memory-leak' | 'crash' | 'reset';

export interface ChaosEvent {
  id: string;
  service: ServiceName;
  action: ChaosAction;
  params: Record<string, number | boolean>;   // e.g. { ms: 1500 }, {} for crash/reset
  at: string;                                 // ISO 8601
}

// events.ts
export interface ServerToClientEvents {
  'cluster:snapshot': (snapshot: ClusterSnapshot) => void;
  'incident:list': (open: Incident[]) => void;
  'incident:opened': (incident: Incident) => void;
  'incident:updated': (incident: Incident) => void;
  'incident:resolved': (incident: Incident) => void;
  'chaos:triggered': (event: ChaosEvent) => void;
}

// The frontend only listens; chaos goes through REST so it gets HTTP status codes.
export type ClientToServerEvents = Record<string, never>;
```

All timestamps are ISO strings so payloads survive JSON serialisation unchanged over Socket.IO and REST.

---

## Infrastructure

### `haunting-engine/Dockerfile`

```dockerfile
# Build context is the repo root (needs shared/):
#   docker build -f haunting-engine/Dockerfile .
FROM node:20-alpine AS builder
WORKDIR /app/haunting-engine
COPY haunting-engine/package*.json ./
RUN npm ci
COPY shared/ /app/shared/
COPY haunting-engine/ ./
RUN npm run build            # prebuild compiles shared/ to .d.ts first

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/haunting-engine/dist ./dist
COPY --from=builder /app/haunting-engine/node_modules ./node_modules
COPY --from=builder /app/haunting-engine/package.json ./
ENV NODE_ENV=production
CMD ["node", "dist/main"]
```

`shared/` is not copied into the runtime stage: it has no runtime code. The `CMD` path is only correct because `tsconfig.build.json` pins `rootDir` to `./src`. Task 13 verifies the actual output path before relying on it.

### Root `.dockerignore`

```
**/node_modules
**/dist
.git
.kiro
victim-app
haunted-house
```

This only affects builds whose context is the repo root. The victim-app builds use `./victim-app` as context and keep their own `victim-app/.dockerignore`.

### docker-compose.yml additions

```yaml
  prometheus:
    # ...existing config...
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:9090/-/ready"]
      interval: 5s
      timeout: 3s
      retries: 5

  haunting-engine:
    build:
      context: .
      dockerfile: haunting-engine/Dockerfile
    ports:
      - "4000:4000"
    restart: unless-stopped
    environment:
      PORT: 4000
      PROMETHEUS_URL: http://prometheus:9090
      SERVICE_CHAIN: gateway,orders,payments
      GATEWAY_URL: http://gateway:3000
      ORDERS_URL: http://orders:3001
      PAYMENTS_URL: http://payments:3002
      POLL_INTERVAL_MS: 2000
      CORS_ORIGIN: http://localhost:3100
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:4000/health"]
      interval: 10s
      timeout: 5s
      retries: 3
    depends_on:
      prometheus:
        condition: service_healthy
```

The `prom/prometheus` image is busybox-based and ships `wget`; task 14 confirms this.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Badness is bounded and monotonic

*For any* thresholds with `ok < critical` and any finite values `a ≤ b`, `badness(a)` and `badness(b)` SHALL lie in [0, 1] and `badness(a) ≤ badness(b)`; `badness(null)` SHALL be 0.

**Validates: Requirements 3.1**

### Property 2: Score, status and breached kinds are consistent

*For any* `ServiceSignals`, `scoreService` SHALL return: `unknown` / `null` score / no kinds when `up` is null; `down` / score 0 / `['down']` when `up` is false; otherwise a score in [0, 100], a status determined solely by `maxBadness`, and `status === 'healthy'` if and only if `breachedKinds` is empty. It SHALL never return `healthy` when `up` is not `true`.

**Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.6, 11.3**

### Property 3: Dread is the worst badness

*For any* list of `ServiceHealth`, `clusterDread` SHALL be in [0, 1], SHALL equal 1 when any service is `down`, SHALL ignore `unknown` services, and SHALL otherwise equal the maximum `maxBadness`.

**Validates: Requirements 3.7**

### Property 4: Attribution is complete and well-formed

*For any* chain and any health assignment, `attributeFaults` SHALL return at most one attribution containing a propagating kind; its root SHALL be the most downstream non-unknown service with a propagating breach; every `memory` breach SHALL appear in its own service's attribution; every service with a breached kind SHALL appear exactly once as a root or as an affected service of the propagating root, unless it is only a memory root; and no `unknown` service SHALL appear anywhere.

**Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6**

### Property 5: Hysteresis on open and close

*For any* sequence of Polls without `down`, an incident for service `s` SHALL open only on a Poll where `s` has been root for at least `openAfterPolls` consecutive available Polls, SHALL resolve only after at least `closeAfterPolls` consecutive available Polls where `s` was not root, and there SHALL never be more than one open incident per root.

**Validates: Requirements 5.1, 5.2, 5.5**

### Property 6: `down` opens immediately

*For any* tracker state where `s` has no open incident, a single available Poll in which `s` is root with kind `down` SHALL open an incident for `s`.

**Validates: Requirements 5.3**

### Property 7: Blind Polls are no-ops

*For any* Poll sequence, inserting any number of `metricsAvailable: false` Polls at any positions SHALL NOT change the resulting sequence of incident events (compared by type, root and kinds) or the final set of open incidents.

**Validates: Requirements 5.6, 11.1**

### Property 8: Recurrence and bounded history

*For any* sequence of resolved incidents followed by a newly opened one, the new incident's `recurrence.count` SHALL equal the number of history entries with the same fingerprint (or `recurrence` SHALL be `null` when there are none), `lastIncidentId` SHALL be the newest match, and the history length SHALL never exceed `incidentHistoryLimit`.

**Validates: Requirements 6.1, 6.2, 6.3**

### Property 9: Prometheus parsing never throws on sample values

*For any* well-formed vector response whose sample values are arbitrary strings (including `"NaN"`, `"+Inf"`, `"-Inf"`, and non-numeric text), `parseVector` SHALL not throw, SHALL map finite numeric strings to their number, and SHALL map everything else to `null`.

**Validates: Requirements 2.6**

### Property 10: Fingerprint follows the primary-kind rule

*For any* root service and non-empty set of kinds with badness values, `fingerprint` SHALL use `down` if present, otherwise the kind with the highest badness, with ties broken `errors` > `latency` > `memory`, and SHALL be identical for identical inputs.

**Validates: Requirements 5.7**

### Property 11: Chaos proxy DTOs reject out-of-range input

*For any* `ms` outside the integers in [0, 30000], `percentage` outside [0, 100] or not a number, and `enabled` not a boolean, validation SHALL fail; for any in-range value it SHALL pass.

**Validates: Requirements 7.2**

---

## Error Handling

| Condition | Behaviour |
|---|---|
| Missing/invalid env var at startup | `[Bootstrap] <VAR> …. Exiting.` logged, `process.exit(1)` |
| Prometheus unreachable / timeout / bad body | Poll emits snapshot with `metricsAvailable: false`, all `unknown`; incidents frozen; `logger.warn` with cause; next Poll scheduled normally |
| Unexpected error inside a Poll | `logger.error` with stack; loop continues |
| Unknown `:service` on chaos proxy | 404 `{ message: "unknown service: <name>" }` |
| Invalid chaos body | 400 from global `ValidationPipe({ whitelist: true })` |
| Victim unreachable / 5xx | 502 `{ message: "<service> service unavailable" }` / `"<service> chaos endpoint failed"` |
| Victim timeout | 504 `{ message: "<service> timed out" }` |
| `GET /api/snapshot` before first Poll | 503 `{ message: "no poll has completed yet" }` |
| Socket.IO client disconnect | Nothing to clean up; the gateway holds no per-client state |

Unhandled exceptions in controllers use Nest's default exception filter, which returns `{ statusCode, message }` and logs non-HTTP errors.

---

## Testing Strategy

### Unit Tests (Jest)

Co-located `*.spec.ts`:
- **`loadEngineConfig`**: defaults applied; each required variable missing → `ConfigError` naming it; `ok ≥ critical` rejected; non-numeric rejected; `<SERVICE>_URL` derived for a custom chain (`checkout-api` → `CHECKOUT_API_URL`).
- **`buildQueries`**: exact PromQL strings for a given window and chain.
- **`MetricsCollectorService`** (mocked `PrometheusClient`): missing error series with traffic → `errorRatio` 0; zero request rate → `errorRatio` null; seconds → ms and bytes → MB conversion; missing `up` → `up: null`; any query rejecting → whole `collect()` rejects.
- **`scoreService` / `attributeFaults`**: the worked-example table above as fixed cases.
- **`trackIncidents`**: `relatedChaos` filtered by service and window; `updated` emitted only on kind/affected change, not on peak change; peaks keep max/min; kinds only grow.
- **`ChaosProxyService`** (mocked `fetch`): 2xx passthrough + Chaos_Event recorded; 202 crash; 5xx → 502; `TypeError: fetch failed` → 502; `TimeoutError` → 504; `resetAll` with one service down returns per-service results.
- **`KnownServicePipe`**: 404 for unknown names, passthrough for known.
- **`PollerService`** (fake timers, mocked collector): no second Poll starts while the first is pending; delay subtracts elapsed time; `MetricsUnavailableError` → `unknown` snapshot emitted and loop continues; unexpected error logged and loop continues; `onModuleDestroy` stops the loop.
- **`EventsGateway`**: on connect, emits latest snapshot (when present) and `incident:list` to that client only.
- **`SnapshotController`**: 503 before the first Poll, snapshot after.

### Property-Based Tests (fast-check)

Minimum **100 iterations** each, tagged `// Feature: haunting-engine, Property <N>: <text>`.

| Property | Location | Generators |
|---|---|---|
| 1 | `health-scoring.prop.spec.ts` | thresholds via `fc.tuple(fc.double(), fc.double())` filtered `ok < critical`, value pairs sorted |
| 2 | `health-scoring.prop.spec.ts` | `ServiceSignals` with each field `fc.option(...)`, `up` from `fc.constantFrom(true, false, null)` |
| 3 | `health-scoring.prop.spec.ts` | arrays of generated `ServiceHealth` |
| 4 | `attribution.prop.spec.ts` | chain of 1–6 unique names; per service a status and a subset of kinds consistent with it |
| 5, 6, 7, 8, 10 | `incident-tracker.prop.spec.ts` | sequences of 1–40 Polls built from per-poll root sets; `newId` is a counter; `now` increases by `pollIntervalMs` |
| 9 | `prometheus.client.prop.spec.ts` | vector bodies with `fc.oneof(fc.double().map(String), fc.constantFrom('NaN','+Inf','-Inf'), fc.string())` values |
| 11 | `chaos-proxy/dto/dto.prop.spec.ts` | same strategy as victim-app Property 8 |

### Integration Tests (`haunting-engine/test/`, `npm run test:e2e`)

These run against the full `docker compose up` stack, using `socket.io-client` and `fetch`:
- **Snapshot stream**: connect, receive `cluster:snapshot` within 10 s with `metricsAvailable: true`; within 30 s all three services report `healthy`.
- **Incident lifecycle with evidence**: `POST /api/chaos/orders/error-rate { percentage: 100 }` → `incident:opened` with root `orders`, kinds containing `errors`, `gateway` in `affected`, and the chaos event in `relatedChaos`; then `POST /api/chaos/orders/reset` → `incident:resolved` for that ID within 45 s (15 s rate window decay + 3 close Polls).
- **Recurrence**: repeat the error-rate scenario; the second `incident:opened` has `recurrence.count ≥ 1` and `lastIncidentId` equal to the first incident's ID.
- **Proxy errors**: `POST /api/chaos/nope/crash` → 404; `POST /api/chaos/orders/latency { ms: -1 }` → 400.
- Every test's `afterAll` calls `POST /api/chaos/reset-all`.

**Crash is deliberately not integration-tested for a `down` incident** (see Open Questions): whether a Prometheus scrape lands inside a 1–3 s restart window is timing-dependent. Requirement 5.3 is covered by Property 6.

---

## Open Questions

1. **Crash visibility.** With a 2 s scrape interval and a container that restarts in about 1–3 s, a crash may produce zero or one failed scrapes. Requirement 5.3 handles the one-scrape case. If demos show crashes going unnoticed, options are a 1 s scrape interval, or having the engine also probe each service's `/health` directly every Poll. Decide after measuring in the final checkpoint.

   **Measured in the final checkpoint (2026-11-10):** 5 crashes of payments through the proxy, each from a settled, healthy cluster, watching for 25 s. Payments restarted all 5 times.

   | Crash | `down` seen | Incidents opened |
   |---|---|---|
   | 1 | yes | `payments:down`; `gateway:errors` |
   | 2 | no | `orders:errors` (gateway affected) |
   | 3 | yes | `payments:down` |
   | 4 | no | none |
   | 5 | yes | `payments:down` (gateway, orders affected); then `orders:errors` (gateway affected) |

   **3/5 crashes produced a `down` incident.** Two further effects this question did not anticipate:
   - **A missed crash can be blamed on the wrong service** (crash 2): with no failed scrape, payments looks healthy throughout, so the upstream 502s make orders the most downstream service with errors.
   - **A caught crash can leave a second, misattributed incident** (crashes 1 and 5): the failed requests stay in the 15 s `RATE_WINDOW` after payments is back up, and once payments looks healthy again, attribution moves to orders (or gateway).

   A 1 s scrape interval would make missing a short restart less likely but not impossible, and would not fix the second effect. A direct `/health` probe per Poll would catch most restarts, and could also suppress `errors` attribution upstream of a service that was down within the last `RATE_WINDOW`. **Decision (2026-11-10): recorded only, no change for now.** Latency and error-rate chaos attributed correctly in every test; revisit if crash demos matter.
2. **Frontend port.** `CORS_ORIGIN` defaults to `http://localhost:3100`, assuming the haunted-house Next.js app runs there (3000 is taken by gateway). The haunted-house spec must match it or override the variable.
3. **Memory thresholds.** `MEMORY_OK_MB=120` assumes idle victim RSS is well below that. The final checkpoint records real idle RSS and adjusts the default if needed.

   **Measured in the final checkpoint (2026-11-10):** idle, with the load generator running and no chaos, over 15 snapshots in 45 s after the stack had been up 44 minutes: RSS gateway 84.1–84.7 MB, orders 83.2–83.6 MB, payments 80.5–80.9 MB (71–77 MB just after start). p95 latency peaked at 24.7 ms (gateway) and the error ratio was 0. Both are well inside the defaults (35 MB below `MEMORY_OK_MB=120`; p95 under `LATENCY_OK_MS=100`), so **no defaults were changed.**
