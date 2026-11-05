# Requirements Document

## Introduction

The haunting-engine is the NestJS backend that turns raw victim-app telemetry into meaning. Every few seconds it queries Prometheus for each service's request rate, error ratio, p95 latency, memory and scrape health; scores each service from 0 to 100; works out which service is the root cause of a fault and which services are only affected by it; and tracks incidents from opening to resolution. When a new incident matches one seen before, the engine flags it as a recurrence. All of this is streamed to the haunted-house frontend over Socket.IO, so every room, sound and ghost line can be driven by real metric data.

The engine also exposes a chaos proxy, so the frontend can break the victim services from the UI without any setup, CORS changes or knowledge of the victim services' ports. Every chaos action is recorded and attached to the incidents it is likely to explain, so the AI narrator (a later spec) has ground truth to work from.

Event and payload types shared with the frontend live once in `shared/`, as a types-only package, and are imported by both sides.

**Out of scope for this spec:** the AI ghost narrator (LLM calls and prompt design), the haunted-house frontend and audio, persisting incident history across engine restarts, and statistical (baseline/z-score) anomaly detection. Detection here is threshold-based and deterministic.

## Glossary

- **Engine**: The haunting-engine NestJS application.
- **Shared_Package**: The `shared/` directory, which contains only TypeScript type declarations for every payload and event exchanged between the Engine and the frontend.
- **Service_Chain**: The ordered list of monitored services from most upstream to most downstream, read from `SERVICE_CHAIN` (default `gateway,orders,payments`).
- **Poll**: One cycle in which the Engine queries Prometheus, scores every service, updates incidents and emits events.
- **Signals**: The per-service measurements taken in one Poll: `requestRate` (requests/s), `errorRatio` (0–1), `latencyP95Ms`, `rssMb`, and `up`. Any measurement may be `null` when Prometheus has no data for it.
- **Badness**: A number in [0, 1] computed per signal kind, where 0 means at or below the signal's OK threshold and 1 means at or above its critical threshold.
- **Signal_Kind**: One of `latency`, `errors`, `memory`, `down`.
- **Propagating_Kind**: `latency`, `errors` and `down`; faults of these kinds travel upstream through the Service_Chain.
- **Local_Kind**: `memory`; a memory fault only affects the service it occurs in.
- **Breached_Kind**: A Signal_Kind whose Badness is greater than `0.2` for a service, or `down` when the service's `up` is false.
- **Health_Score**: An integer 0–100 per service; 100 is perfectly healthy.
- **Service_Status**: One of `healthy`, `degraded`, `critical`, `down`, `unknown`.
- **Dread**: A number in [0, 1] for the whole cluster, equal to the worst Badness of any service (1 when any service is down). The frontend uses it to set overall horror intensity.
- **Root_Service**: The service a fault is attributed to.
- **Affected_Service**: A service with propagating breaches that are attributed to a Root_Service further downstream.
- **Incident**: A tracked fault with one Root_Service, a set of Signal_Kinds, a set of Affected_Services, peak signal values, and a lifecycle of `open` → `resolved`.
- **Fingerprint**: The string `<rootService>:<primaryKind>` that identifies the kind of an Incident for recurrence matching.
- **Recurrence**: Information attached to a newly opened Incident about earlier resolved Incidents with the same Fingerprint.
- **Chaos_Proxy**: The Engine's REST endpoints that forward chaos commands to the victim services.
- **Chaos_Event**: A record of one chaos command sent through the Chaos_Proxy.
- **Cluster_Snapshot**: The complete per-Poll state of the cluster: timestamp, whether metrics were available, every service's health, and Dread.

## Requirements

### Requirement 1: Shared Event Contract

**User Story:** As a developer, I want every event and payload shape defined once in `shared/`, so that the Engine and the frontend can never disagree about the data they exchange.

#### Acceptance Criteria

1. THE Shared_Package SHALL define the types `ServiceName`, `SignalKind`, `ServiceSignals`, `ServiceStatus`, `ServiceHealth`, `ClusterSnapshot`, `Incident`, `IncidentRecurrence`, `ChaosAction`, `ChaosEvent`, `ServerToClientEvents` and `ClientToServerEvents`.
2. THE Shared_Package SHALL contain only type declarations and SHALL compile to declaration files (`.d.ts`) only, with no runtime JavaScript.
3. THE Engine SHALL import every type it sends to or receives from the frontend from the Shared_Package and SHALL NOT redeclare any of them.
4. THE Engine SHALL use `ServerToClientEvents` and `ClientToServerEvents` as the type parameters of its Socket.IO server, so that an event name or payload that does not match the contract fails to compile.

### Requirement 2: Metrics Collection

**User Story:** As the haunting-engine, I want to read fresh telemetry for every service on a fixed interval, so that the soundscape reacts to failures within seconds.

#### Acceptance Criteria

1. THE Engine SHALL run a Poll every `POLL_INTERVAL_MS` milliseconds (default 2000).
2. WHEN a Poll runs, THE Engine SHALL query the Prometheus HTTP API at `PROMETHEUS_URL` for, per service: request rate, 5xx error rate, p95 request latency, resident memory (`process_rss_bytes`), and scrape health (`up`).
3. THE Engine SHALL compute request rate, error rate and latency over a range window of `RATE_WINDOW` (default `15s`).
4. THE Engine SHALL compute `errorRatio` as error rate divided by request rate, and SHALL set `errorRatio` to `null` when the request rate is zero or unavailable.
5. WHEN a service has request data but no `http_errors_total` series, THE Engine SHALL treat its error rate as zero.
6. WHEN Prometheus returns no sample, `NaN`, or an infinite value for a signal, THE Engine SHALL set that signal to `null` and SHALL NOT throw.
7. THE Engine SHALL never start a Poll while the previous Poll is still running.
8. THE Engine SHALL abort any Prometheus query that takes longer than `PROMETHEUS_TIMEOUT_MS` (default 1500).

### Requirement 3: Health Scoring

**User Story:** As the haunted-house frontend, I want a single score and status per service, so that each room's visuals and sounds can be driven directly by how sick that service is.

#### Acceptance Criteria

1. THE Engine SHALL compute Badness for `latency`, `errors` and `memory` as `clamp((value − OK) / (CRITICAL − OK), 0, 1)`, using the thresholds `LATENCY_OK_MS` / `LATENCY_CRITICAL_MS`, `ERROR_RATIO_OK` / `ERROR_RATIO_CRITICAL`, and `MEMORY_OK_MB` / `MEMORY_CRITICAL_MB`; a `null` signal SHALL have Badness 0.
2. THE Engine SHALL compute the Health_Score as `round(100 × (1 − maxBadness))`, where `maxBadness` is the largest Badness of the three kinds.
3. WHEN a service's `up` is false, THE Engine SHALL give it Health_Score 0 and Service_Status `down`.
4. WHEN a service's `up` is `null`, THE Engine SHALL give it Health_Score `null` and Service_Status `unknown`.
5. OTHERWISE, THE Engine SHALL set Service_Status from `maxBadness`: `healthy` when ≤ 0.2, `degraded` when ≤ 0.6, and `critical` above 0.6.
6. THE Engine SHALL report every service's Breached_Kinds alongside its score and status.
7. THE Engine SHALL compute Dread as the largest `maxBadness` across all services, using 1 for any `down` service and ignoring `unknown` services.

### Requirement 4: Root-Cause Attribution

**User Story:** As an on-call engineer, I want the engine to tell me which service actually broke, so that I don't chase symptoms in services that are only failing because something downstream did.

#### Acceptance Criteria

1. THE Engine SHALL attribute all Propagating_Kind breaches in the Service_Chain to the most downstream service that has at least one Propagating_Kind breach; that service SHALL be the Root_Service.
2. THE Engine SHALL list every service upstream of that Root_Service that also has a Propagating_Kind breach as an Affected_Service of it, together with its own Breached_Kinds.
3. THE Engine SHALL attribute every `memory` breach to the service in which it occurs, as that service's own Root_Service.
4. WHEN a service is the Root_Service for both propagating and memory breaches, THE Engine SHALL report one attribution for it with the union of its Breached_Kinds.
5. THE Engine SHALL ignore services whose Service_Status is `unknown` when attributing faults.
6. THE Engine SHALL ensure that every service with at least one Breached_Kind appears either as a Root_Service or as an Affected_Service.

### Requirement 5: Incident Lifecycle

**User Story:** As an on-call engineer, I want short blips ignored and real faults tracked from start to finish, so that the haunting reflects genuine incidents rather than noise.

#### Acceptance Criteria

1. THE Engine SHALL keep at most one open Incident per Root_Service.
2. WHEN a service has been a Root_Service for `OPEN_AFTER_POLLS` consecutive Polls (default 2) and has no open Incident, THE Engine SHALL open an Incident for it.
3. WHEN a service becomes a Root_Service with the `down` kind, THE Engine SHALL open an Incident for it immediately, without waiting for `OPEN_AFTER_POLLS`, because a crashed container may restart before a second Poll.
4. WHILE an Incident is open, THE Engine SHALL update its Signal_Kinds, Affected_Services and peak signal values each Poll, and SHALL emit an update event only when its Signal_Kinds or Affected_Services change.
5. WHEN the Root_Service of an open Incident has not been a Root_Service for `CLOSE_AFTER_POLLS` consecutive Polls (default 3), THE Engine SHALL resolve the Incident and record its resolution time and duration.
6. WHEN a Poll cannot reach Prometheus, THE Engine SHALL NOT open, update or resolve any Incident, and SHALL NOT change any consecutive-Poll counters.
7. THE Engine SHALL compute an Incident's Fingerprint when it opens as `<rootService>:<primaryKind>`, where `primaryKind` is `down` if present, otherwise the Breached_Kind with the highest Badness, breaking ties in the order `errors`, `latency`, `memory`.

### Requirement 6: Incident Memory and Recurrence

**User Story:** As an on-call engineer, I want to be warned when a past incident is happening again, so that I can reuse what I learned last time.

#### Acceptance Criteria

1. THE Engine SHALL keep the most recent `INCIDENT_HISTORY_LIMIT` resolved Incidents in memory (default 50), discarding the oldest first.
2. WHEN an Incident opens and the history contains resolved Incidents with the same Fingerprint, THE Engine SHALL attach a Recurrence with the number of matches, and the ID, resolution time and duration of the most recent match.
3. WHEN an Incident opens and no resolved Incident has the same Fingerprint, THE Engine SHALL set its Recurrence to `null`.

### Requirement 7: Chaos Proxy

**User Story:** As a hackathon judge, I want to break any service from the haunted-house UI, so that I can see and hear the haunting react without touching a terminal.

#### Acceptance Criteria

1. THE Engine SHALL expose `POST /api/chaos/:service/latency`, `/error-rate`, `/memory-leak`, `/crash` and `/reset`, and `GET /api/chaos/:service/state`, and SHALL forward each to the matching `/chaos/*` endpoint of that victim service.
2. THE Engine SHALL validate proxy request bodies with the same rules as the victim services: `ms` an integer in [0, 30000], `percentage` a number in [0, 100], `enabled` a boolean.
3. IF `:service` is not in the Service_Chain, THEN THE Engine SHALL return HTTP 404 and SHALL NOT call any victim service.
4. IF the victim service cannot be reached or returns a 5xx status, THEN THE Engine SHALL return HTTP 502 with a `message` naming the service; IF it times out, THEN THE Engine SHALL return HTTP 504.
5. THE Engine SHALL expose `POST /api/chaos/reset-all`, which sends `/chaos/reset` to every service and reports the outcome per service, without failing the whole request when one service is unreachable.
6. WHEN a chaos command is accepted by the victim service, THE Engine SHALL record a Chaos_Event and emit `chaos:triggered` to all connected clients.
7. THE Engine SHALL read each service's base URL from the environment variable `<SERVICE>_URL` (for example `ORDERS_URL` for `orders`).

### Requirement 8: Chaos Evidence on Incidents

**User Story:** As the future AI narrator, I want each incident to carry the chaos actions that likely caused it, so that my explanations are grounded in what actually happened.

#### Acceptance Criteria

1. WHEN an Incident opens, THE Engine SHALL attach every Chaos_Event targeting its Root_Service within the last `CHAOS_EVIDENCE_WINDOW_SECONDS` (default 150) as `relatedChaos`, newest first.
2. THE Engine SHALL keep at most 100 Chaos_Events in memory, discarding the oldest first.

### Requirement 9: Real-Time Streaming

**User Story:** As the haunted-house frontend, I want to receive cluster state and incident changes the moment they happen, so that sound and visuals stay in sync with the system.

#### Acceptance Criteria

1. THE Engine SHALL serve Socket.IO on the same port as its HTTP API.
2. WHEN a Poll completes, THE Engine SHALL emit `cluster:snapshot` with the Cluster_Snapshot to all connected clients.
3. WHEN an Incident opens, changes or resolves, THE Engine SHALL emit `incident:opened`, `incident:updated` or `incident:resolved` respectively, with the full Incident.
4. WHEN a client connects, THE Engine SHALL immediately send that client the latest Cluster_Snapshot (if any Poll has completed) and an `incident:list` event containing all open Incidents.
5. THE Engine SHALL accept Socket.IO and HTTP requests from the origin in `CORS_ORIGIN` (default `http://localhost:3100`).

### Requirement 10: REST Read API

**User Story:** As a developer, I want to inspect the engine's state over plain HTTP, so that I can debug without a Socket.IO client.

#### Acceptance Criteria

1. THE Engine SHALL expose `GET /health` returning `{ "status": "ok", "service": "haunting-engine" }`.
2. THE Engine SHALL expose `GET /api/snapshot` returning the latest Cluster_Snapshot, or HTTP 503 with a `message` if no Poll has completed yet.
3. THE Engine SHALL expose `GET /api/incidents` returning `{ "open": Incident[], "resolved": Incident[] }`, with resolved Incidents newest first.

### Requirement 11: Degraded Operation

**User Story:** As a demo operator, I want the engine to stay honest when it can't see the cluster, so that the haunting never shows "all healthy" while it is actually blind.

#### Acceptance Criteria

1. IF any Prometheus query in a Poll fails or times out, THEN THE Engine SHALL emit a Cluster_Snapshot with `metricsAvailable: false` and every service's Service_Status set to `unknown`.
2. IF a Poll fails, THEN THE Engine SHALL log the failure with its cause and SHALL schedule the next Poll as normal.
3. THE Engine SHALL never report a service as `healthy` when its `up` signal is `null`.

### Requirement 12: Container and Compose Integration

**User Story:** As a developer, I want the engine to start with the rest of the stack, so that `docker compose up` still brings up the whole demo with one command.

#### Acceptance Criteria

1. THE repository SHALL contain `haunting-engine/Dockerfile`, a multi-stage build whose build context is the repository root, so that it can read `shared/`.
2. THE docker-compose.yml SHALL define a `haunting-engine` service exposing port 4000, with `restart: unless-stopped`, a `wget -qO-` healthcheck on `/health`, and every environment variable from Requirement 13.
3. THE docker-compose.yml SHALL add a healthcheck to the `prometheus` service on `/-/ready`, and the `haunting-engine` service SHALL depend on `prometheus` being healthy.
4. THE repository SHALL contain a root `.dockerignore` that keeps `node_modules`, `dist`, `.git`, `victim-app/` and `haunted-house/` out of the haunting-engine build context.
5. WHEN `docker compose up` is executed, THE `haunting-engine` container SHALL become healthy and emit its first Cluster_Snapshot within 30 seconds.

### Requirement 13: Configuration

**User Story:** As a developer, I want all engine behaviour to be configurable through environment variables, so that thresholds can be tuned for the demo without code changes.

#### Acceptance Criteria

1. THE Engine SHALL require `PROMETHEUS_URL` and one `<SERVICE>_URL` per service in the Service_Chain; IF any is absent at startup, THEN THE Engine SHALL log the missing variable by name and exit with code 1.
2. THE Engine SHALL read these optional variables with these defaults: `PORT=4000`, `SERVICE_CHAIN=gateway,orders,payments`, `POLL_INTERVAL_MS=2000`, `RATE_WINDOW=15s`, `PROMETHEUS_TIMEOUT_MS=1500`, `LATENCY_OK_MS=100`, `LATENCY_CRITICAL_MS=1000`, `ERROR_RATIO_OK=0.01`, `ERROR_RATIO_CRITICAL=0.2`, `MEMORY_OK_MB=120`, `MEMORY_CRITICAL_MB=230`, `OPEN_AFTER_POLLS=2`, `CLOSE_AFTER_POLLS=3`, `INCIDENT_HISTORY_LIMIT=50`, `CHAOS_EVIDENCE_WINDOW_SECONDS=150`, `CHAOS_PROXY_TIMEOUT_MS=3000`, `CORS_ORIGIN=http://localhost:3100`.
3. IF any configured threshold pair has its OK value greater than or equal to its CRITICAL value, or any numeric variable is not a valid number, THEN THE Engine SHALL log the offending variable and exit with code 1.
4. THE repository SHALL contain `haunting-engine/.env.example` listing every variable in this requirement with its default.
