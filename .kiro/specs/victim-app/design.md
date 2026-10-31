# Design Document

## Overview

The victim-app is a **NestJS monorepo** containing three applications — **Gateway** (port 3000), **Orders** (port 3001), and **Payments** (port 3002) — that form a deliberate call chain for The Haunted Cluster demo. Every real request flows Gateway → Orders → Payments, giving the haunting-engine a live call graph with meaningful latency and error signals.

Shared code lives in three libraries inside the monorepo so nothing is duplicated across apps:

- **`libs/observability`** — `MetricsService`, `MetricsInterceptor`, and the `/metrics` controller.
- **`libs/chaos`** — `ChaosService`, `ChaosInterceptor`, `ChaosController`, and all chaos DTOs.
- **`libs/common`** — downstream HTTP client configuration, `mapDownstreamError` pure function, and startup env-var validation.

Design goals:
- **Observability first** — every non-excluded request updates counters and histograms without developer effort; the `MetricsInterceptor` is registered globally and hooks into the Node.js response `close` event so it always reads the final status code (or 499 for client-aborted requests), including codes set by exception filters.
- **Controllable chaos** — the `ChaosInterceptor` (not middleware) lets operators inject latency and errors independently per service; `MetricsInterceptor` wraps `ChaosInterceptor` so injected latency and injected 500s are captured in the recorded metrics.
- **No shared-code duplication** — identical capabilities (metrics, chaos, error mapping) are imported from shared libs, not copy-pasted across apps.
- **Self-healing demo** — all chaos settings expire after `CHAOS_TTL_SECONDS`; expiry stops timers AND frees retained memory.

---

## Architecture

### Monorepo Layout

```
victim-app/
  apps/
    gateway/
      src/
        app.module.ts        # imports CoreModule, ObservabilityModule, ChaosModule
        main.ts
        core/
          core.module.ts
          core.controller.ts
          core.service.ts
    orders/
      src/  (same shape as gateway)
    payments/
      src/  (same shape as gateway)
  libs/
    observability/
      src/
        metrics.service.ts
        metrics.interceptor.ts
        metrics.controller.ts
        observability.module.ts
    chaos/
      src/
        chaos.service.ts
        chaos.interceptor.ts
        chaos.controller.ts
        dto/
          set-latency.dto.ts
          set-error-rate.dto.ts
          set-memory-leak.dto.ts
        chaos.module.ts
    common/
      src/
        downstream-http.module.ts   # HttpModule configured from env
        map-downstream-error.ts     # pure function: AxiosError → 502 | 504
        env-validation.ts           # startup required-var check
        common.module.ts
  load-generator/
    src/
      index.ts
  package.json            # monorepo root — single node_modules
  tsconfig.json
  nest-cli.json           # declares all apps and libs
```

### Call Chain

```
External traffic
      │
      ▼
┌─────────────┐   POST /order      ┌─────────────┐   POST /payment    ┌──────────────┐
│   Gateway   │ ─────────────────► │   Orders    │ ─────────────────► │   Payments   │
│  :3000      │ ◄───────────────── │   :3001     │ ◄───────────────── │   :3002      │
└─────────────┘   orders response  └─────────────┘  payment response  └──────────────┘
      ▲
      │  POST /order (continuous)
┌─────────────┐
│    Load     │
│  Generator  │
└─────────────┘

        │ metrics scrape (every 2 s)
        ▼
┌─────────────┐
│ Prometheus  │
│   :9090     │
└─────────────┘
```

### Error Propagation

- Downstream timeout (ECONNABORTED, ETIMEDOUT, ERR_CANCELED) → 504 `{ "message": "..." }`
- Everything else (ECONNREFUSED, ECONNRESET, ENOTFOUND, EAI_AGAIN, downstream 4xx, downstream 5xx, unknown errors) → 502 `{ "message": "..." }`

### Interceptor Registration Order

Both interceptors are registered globally in `AppModule` via `APP_INTERCEPTOR`. NestJS applies global interceptors in registration order, wrapping outward:

```
Request
  │
  ▼
MetricsInterceptor (skips excluded routes; starts timer, hooks res.once('close', ...))
  │
  ▼
ChaosInterceptor  (skips excluded routes; applies latency delay; may throw HttpException 500)
  │
  ▼
Route Handler
  │
  ▼
Response / Exception Filter
  │
  ▼
res 'close' event fires → MetricsInterceptor records counter + histogram with final status code
                          (499 if res.writableFinished === false, otherwise res.statusCode)
```

Because `MetricsInterceptor` wraps `ChaosInterceptor`, injected latency is included in the recorded histogram duration, and chaos-injected 500s are counted by the error counter.

---

## Components and Interfaces

### libs/observability

#### `MetricsService`

- Creates and owns a dedicated `prom-client` `Registry` (not the global default, for test isolation).
- Registers on construction:
  - `http_requests_total` — Counter, labels: `method`, `route`, `status_code`, `service`.
  - `http_request_duration_seconds` — Histogram, labels: `method`, `route`, `service`, buckets: `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`.
  - `http_errors_total` — Counter, labels: `method`, `route`, `status_code`, `service`.
  - `process_heap_used_bytes` — Gauge, label: `service`.
  - `process_rss_bytes` — Gauge, label: `service`.
- Sets the `service` default label to the service name at startup (passed via constructor or module config).
- Starts a `setInterval` every 5 000 ms that reads `process.memoryUsage()` and updates heap and RSS gauges.
- Exposes `getMetrics(): Promise<string>` for the `/metrics` endpoint.
- Exposes `recordRequest(method: string, route: string, statusCode: number, durationSeconds: number): void`.

#### `MetricsInterceptor` (implements `NestInterceptor`)

- On `intercept(context, next)`:
  1. Reads the request path and calls `isExcludedRoute(path)` from `libs/common`. If the route is excluded, returns `next.handle()` immediately — no timer is started, no `close` listener is registered, and no metrics are recorded.
  2. Records `startTime = performance.now()`.
  3. Obtains the raw `res` (`ServerResponse`) from `context.switchToHttp().getResponse()`.
  4. Registers `res.once('close', () => { ... })` — this callback fires when the underlying connection closes (whether the response completed normally or the client disconnected mid-flight).
  5. Inside the `close` callback: calculates `durationSeconds = (performance.now() - startTime) / 1000`, reads `route` from `req.route?.path ?? "unmatched"`, determines `statusCode` as `res.writableFinished === false ? 499 : res.statusCode` (499 indicates a client-aborted request), calls `metricsService.recordRequest(method, route, statusCode, durationSeconds)`.
  6. Returns `next.handle()` without modification.

> **Why `close` instead of `finish`?** The `close` event fires for both normal completions and client disconnections, allowing aborted requests to be recorded with status 499. `finish` only fires when the response is written successfully and would miss client aborts. NestJS exception filters set the status code on the raw `ServerResponse` after the RxJS observable errors; `res.writableFinished` distinguishes a fully sent response from an aborted one.

#### `MetricsController`

- `GET /metrics` → sets `Content-Type: text/plain; version=0.0.4`, returns `metricsService.getMetrics()`.
- Lives inside `ObservabilityModule`; imported by each app's `AppModule`.

### libs/chaos

#### `ChaosService`

- Holds a `ChaosState` object in memory (see Data Models).
- `setLatency(ms: number)`: updates `state.latencyMs`, cancels existing TTL timer, starts a new `setTimeout` for `CHAOS_TTL_SECONDS` seconds that calls `resetLatency()`.
- `setErrorRate(percentage: number)`: same TTL pattern for `errorRatePercent`.
- `enableMemoryLeak()`: starts a `setInterval` (1 000 ms) that pushes `LEAK_MB_PER_SECOND` × 1 MB strings into the leak array; schedules TTL expiry. TTL expiry **stops the leak timer AND reassigns `_leakArray = []`** (freeing retained memory).
- `disableMemoryLeak()`: stops the leak timer but does **not** free the array until reset or TTL expiry.
- `reset()`: sets all fields to zero/false, clears all timers, reassigns `_leakArray = []`.
- `getState()`: returns a `ChaosStateResponse` snapshot.
- `crash()`: schedules `process.exit(1)` in 100 ms.

#### `ChaosInterceptor` (implements `NestInterceptor`)

Replaces the former `ChaosMiddleware`. Registered globally as `APP_INTERCEPTOR` after `MetricsInterceptor`.

```
intercept(context, next):
  1. If isExcludedRoute(req.path): return next.handle() immediately.
  2. If chaosService.state.latencyMs > 0: await sleep(chaosService.state.latencyMs).
  3. If chaosService.state.errorRatePercent > 0:
       draw random = Math.random() * 100
       if random < errorRatePercent:
         throw new HttpException({ message: 'chaos: injected error' }, HttpStatus.INTERNAL_SERVER_ERROR)
  4. return next.handle()
```

Using an interceptor (rather than middleware) means the thrown `HttpException` is handled by NestJS's exception filter pipeline and produces a proper JSON response body, consistent with all other error responses in the system.

#### `ChaosController` (prefix `/chaos`)

- `POST /latency` — `@Body() dto: SetLatencyDto`; calls `chaosService.setLatency(dto.ms)`; returns `{ message: 'latency set', ms: dto.ms }`.
- `POST /error-rate` — `@Body() dto: SetErrorRateDto`; calls `chaosService.setErrorRate(dto.percentage)`; returns `{ message: 'error rate set', percentage: dto.percentage }`.
- `POST /memory-leak` — `@Body() dto: SetMemoryLeakDto`; enables or disables accordingly.
- `POST /crash` — `@HttpCode(202)`; returns `{ message: 'crashing' }` then calls `chaosService.crash()`.
- `POST /reset` — calls `chaosService.reset()`; returns `{ message: 'chaos reset' }`.
- `GET /state` — returns `chaosService.getState()`.

### libs/common

#### `mapDownstreamError(error: AxiosError, serviceName: string): HttpException`

A **pure function** (no NestJS injection, no side effects) that maps an `AxiosError` to either an `HttpException(502)` or `HttpException(504)` and **returns** it — the calling `CoreService` is responsible for throwing the returned exception:

```
if error.code is one of ECONNABORTED | ETIMEDOUT | ERR_CANCELED
  → return HttpException(504, { message: '<serviceName> timed out' })
else (everything else: downstream 4xx, downstream 5xx, no-response errors, unknown errors)
  → return HttpException(502, { message: '<serviceName> service unavailable' })
```

Being a pure function that returns (rather than throws) makes it trivially property-testable and shareable across Gateway and Orders.

#### `isExcludedRoute(path: string): boolean`

A **pure helper function** that returns `true` if the given request path is an excluded route (`/metrics`, `/health`, or any path starting with `/chaos/`). Used by both `MetricsInterceptor` and `ChaosInterceptor` to consistently skip instrumentation and chaos injection on operational routes.

#### `DownstreamHttpModule`

- Wraps NestJS `HttpModule.registerAsync` configured from env (`DOWNSTREAM_TIMEOUT_MS`, default 5000).
- Exported and imported by each app's `CoreModule`.

#### `validateRequiredEnv(vars: string[]): void`

- Called at the top of `main.ts` before `NestFactory.create`.
- Iterates `vars`; if any is absent from `process.env`, logs a descriptive error and calls `process.exit(1)`.

### App Modules (Gateway, Orders, Payments)

Each app's `AppModule` imports `ObservabilityModule`, `ChaosModule`, `CoreModule`, and registers both interceptors:

```typescript
providers: [
  { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },  // registered first = outermost
  { provide: APP_INTERCEPTOR, useClass: ChaosInterceptor },    // registered second = inner
]
```

#### Gateway `CoreService`

- Calls `POST <ORDERS_URL>/order` via the injected `HttpService`.
- On error: calls `mapDownstreamError(error, 'orders')` from `libs/common` and throws the returned `HttpException`.

#### Orders `CoreService`

- Calls `POST <PAYMENTS_URL>/payment` via the injected `HttpService`.
- On error: calls `mapDownstreamError(error, 'payments')` from `libs/common` and throws the returned `HttpException`.

#### Payments `CoreService`

- Returns `{ status: 'paid', orderId: <uuid> }` with no downstream call.

### Load Generator

A standalone TypeScript script (`load-generator/src/index.ts`) with no NestJS dependency:
- Reads `GATEWAY_URL` (default `http://localhost:3000`) and `LOAD_INTERVAL_MS` (default 500).
- Runs an async loop: sends `POST /order` with `AbortController` timeout of 10 000 ms, logs status and response time, waits `LOAD_INTERVAL_MS`, repeats.
- On error: logs to stdout, continues loop (never exits on request failure).

---

## Data Models

### ChaosState (in-memory, per-service)

```typescript
interface ChaosState {
  latencyMs: number;              // 0 = disabled
  latencyExpiresAt: Date | null;

  errorRatePercent: number;       // 0–100; 0 = disabled
  errorRateExpiresAt: Date | null;

  memoryLeakEnabled: boolean;
  memoryLeakExpiresAt: Date | null;
  memoryLeakRetainedMb: number;

  // internal — not serialised to GET /chaos/state
  _leakArray: unknown[];
  _leakTimer: NodeJS.Timeout | null;
  _latencyTimer: NodeJS.Timeout | null;
  _errorRateTimer: NodeJS.Timeout | null;
}
```

### DTOs (in libs/chaos)

```typescript
// set-latency.dto.ts
class SetLatencyDto {
  @IsInt()
  @Min(0)
  @Max(30000)
  ms: number;
}

// set-error-rate.dto.ts
class SetErrorRateDto {
  @IsNumber()
  @Min(0)
  @Max(100)
  percentage: number;
}

// set-memory-leak.dto.ts
class SetMemoryLeakDto {
  @IsBoolean()
  enabled: boolean;
}
```

### GET /chaos/state Response

```typescript
interface ChaosStateResponse {
  latencyMs: number;
  latencyExpiresAt: string | null;       // ISO 8601
  errorRatePercent: number;
  errorRateExpiresAt: string | null;
  memoryLeakEnabled: boolean;
  memoryLeakRetainedMb: number;
  memoryLeakExpiresAt: string | null;
}
```

### GET /health Response

```typescript
interface HealthResponse {
  status: 'ok';
  service: 'gateway' | 'orders' | 'payments';
}
```

### Downstream Error Response

```typescript
interface ErrorResponse {
  message: string;
}
```

---

## Infrastructure

### Multi-Stage Dockerfiles

Each app in `apps/<name>/` has its own `Dockerfile` that builds from the monorepo root context. A single multi-stage pattern is used across all three:

```dockerfile
# Stage 1: build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx nest build <name>   # e.g. gateway, orders, payments

# Stage 2: runtime
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist/apps/<name> ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
ENV NODE_ENV=production
CMD ["node", "dist/main"]
```

The load-generator has its own `Dockerfile` in `load-generator/`:

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx tsc -p load-generator/tsconfig.json

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist/load-generator ./dist
COPY --from=builder /app/node_modules ./node_modules
CMD ["node", "dist/index.js"]
```

### Prometheus Configuration

`prometheus/prometheus.yml`:

```yaml
global:
  scrape_interval: 2s          # 2-second scrape for responsive demo visuals

scrape_configs:
  - job_name: gateway
    static_configs:
      - targets: ['gateway:3000']

  - job_name: orders
    static_configs:
      - targets: ['orders:3001']

  - job_name: payments
    static_configs:
      - targets: ['payments:3002']
```

### docker-compose.yml

```yaml
services:
  gateway:
    build:
      context: .
      dockerfile: apps/gateway/Dockerfile
    ports:
      - "3000:3000"
    restart: unless-stopped
    mem_limit: 256m
    environment:
      PORT: 3000
      ORDERS_URL: http://orders:3001
      DOWNSTREAM_TIMEOUT_MS: 5000
      CHAOS_TTL_SECONDS: 120
      LEAK_MB_PER_SECOND: 5
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 10s
      timeout: 5s
      retries: 3

  orders:
    build:
      context: .
      dockerfile: apps/orders/Dockerfile
    ports:
      - "3001:3001"
    restart: unless-stopped
    mem_limit: 256m
    environment:
      PORT: 3001
      PAYMENTS_URL: http://payments:3002
      DOWNSTREAM_TIMEOUT_MS: 5000
      CHAOS_TTL_SECONDS: 120
      LEAK_MB_PER_SECOND: 5
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3001/health"]
      interval: 10s
      timeout: 5s
      retries: 3

  payments:
    build:
      context: .
      dockerfile: apps/payments/Dockerfile
    ports:
      - "3002:3002"
    restart: unless-stopped
    mem_limit: 256m
    environment:
      PORT: 3002
      CHAOS_TTL_SECONDS: 120
      LEAK_MB_PER_SECOND: 5
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3002/health"]
      interval: 10s
      timeout: 5s
      retries: 3

  prometheus:
    image: prom/prometheus:v2.53.0
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
    depends_on:
      gateway:
        condition: service_healthy
      orders:
        condition: service_healthy
      payments:
        condition: service_healthy

  load-generator:
    build:
      context: .
      dockerfile: load-generator/Dockerfile
    restart: unless-stopped
    environment:
      GATEWAY_URL: http://gateway:3000
      LOAD_INTERVAL_MS: 500
    depends_on:
      gateway:
        condition: service_healthy
```

> **`wget` for healthchecks**: The base `node:20-alpine` image includes `wget` but not `curl`, so healthchecks use `wget -qO-` to avoid a missing-binary failure.

### .env.example

```
# Gateway
PORT=3000
ORDERS_URL=http://localhost:3001
DOWNSTREAM_TIMEOUT_MS=5000
CHAOS_TTL_SECONDS=120
LEAK_MB_PER_SECOND=5

# Orders
# PORT=3001
PAYMENTS_URL=http://localhost:3002

# Payments
# PORT=3002

# Load generator
GATEWAY_URL=http://localhost:3000
LOAD_INTERVAL_MS=500
```

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Request counter increments on every non-excluded request

*For any* HTTP method, route pattern (not `/metrics`, `/health`, or `/chaos/*`), and status code, completing one request SHALL increment `http_requests_total` by exactly one, labelled with the correct method, matched route pattern, and status code.

**Validates: Requirements 2.2, 2.5**

### Property 2: Latency histogram records observed duration (fake timers)

*For any* injected delay `d` milliseconds (in [0, 30 000]), with Jest fake timers advancing `d` ms, the `http_request_duration_seconds` observation recorded by `MetricsInterceptor` SHALL be greater than or equal to `d / 1000` seconds and use the matched route pattern as the `route` label.

**Validates: Requirements 2.3, 3.2**

### Property 3: Error counter increments on 5xx only

*For any* status code in [100, 599], `http_errors_total` SHALL be incremented if and only if the response status code is in the range 500–599.

**Validates: Requirements 2.4**

### Property 4: Chaos error-rate injection statistical accuracy

*For any* error rate `p` (0 < p ≤ 100) and a batch of `n = 200` requests, the number of requests that return HTTP 500 due to chaos SHALL be within the 99% confidence interval of a Binomial(n, p/100) distribution, and all non-injected requests SHALL complete normally.

**Validates: Requirements 4.1, 4.2**

### Property 5: Chaos latency injection adds delay to every non-excluded request (fake timers)

*For any* configured latency `ms` in [1, 30 000], with Jest fake timers, every non-excluded request processed while latency chaos is active SHALL trigger an awaited delay of exactly `ms` milliseconds inside `ChaosInterceptor` before passing control to the route handler.

**Validates: Requirements 3.1, 3.2**

### Property 6: Chaos reset clears all state and frees leak memory

*For any* combination of active chaos settings (latency, error rate, memory leak simultaneously enabled), calling `chaosService.reset()` SHALL result in a `ChaosState` where `latencyMs === 0`, `errorRatePercent === 0`, `memoryLeakEnabled === false`, and `_leakArray` has length 0.

**Validates: Requirements 7.1**

### Property 7: Excluded routes are never affected by chaos

*For any* chaos state (arbitrary latency, arbitrary error rate, memory leak enabled), requests to `/metrics`, `/health`, and any `/chaos/*` path SHALL pass through `ChaosInterceptor` without any delay and without receiving an injected error response.

**Validates: Requirements 7.6**

### Property 8: DTO validation rejects out-of-range chaos inputs

*For any* integer `ms` outside [0, 30 000] sent to `SetLatencyDto`, the class-validator `validate()` call SHALL return a non-empty errors array. *For any* number `percentage` outside [0, 100] sent to `SetErrorRateDto`, `validate()` SHALL return a non-empty errors array.

**Validates: Requirements 3.3, 3.4, 4.3, 4.4**

### Property 9: ChaosState serialisation round-trip

*For any* combination of chaos settings applied via `ChaosService` methods, the object returned by `chaosService.getState()` SHALL accurately reflect the current values of `latencyMs`, `errorRatePercent`, `memoryLeakEnabled`, `memoryLeakRetainedMb`, and all expiry timestamps (within a 1-second tolerance).

**Validates: Requirements 7.5**

### Property 10: mapDownstreamError maps error codes to correct HTTP status

*For any* `AxiosError` whose `error.code` is one of `ECONNABORTED`, `ETIMEDOUT`, or `ERR_CANCELED`, `mapDownstreamError` SHALL return an `HttpException` with status 504. *For any* other `AxiosError` — including downstream 4xx responses, downstream 5xx responses, no-response errors (e.g. `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `EAI_AGAIN`), and any unknown error or unexpected shape — `mapDownstreamError` SHALL return `HttpException` 502.

**Validates: Requirements 1.4, 1.5, 1.6**

---

## Error Handling

### Service-Level HTTP Errors

| Condition | Status | Body |
|---|---|---|
| Downstream connection refused / unreachable | 502 | `{ "message": "<service> service unavailable" }` |
| Downstream 5xx response | 502 | `{ "message": "<service> service unavailable" }` |
| Downstream timeout | 504 | `{ "message": "<service> timed out" }` |
| DTO validation failure | 400 | `{ "message": "<field> must be ..." }` |
| Chaos-injected error | 500 | `{ "message": "chaos: injected error" }` |

### Startup Validation

`main.ts` in Gateway calls `validateRequiredEnv(['ORDERS_URL'])` and Orders calls `validateRequiredEnv(['PAYMENTS_URL'])` before `NestFactory.create`. On failure:

```
[Bootstrap] ORDERS_URL is required but not set. Exiting.
process.exit(1)
```

### Unhandled Exceptions

A `GlobalExceptionFilter` is registered via `APP_FILTER`. It passes `HttpException` instances through unchanged, preserving their status code and response body. For any non-`HttpException` error (truly unknown errors), it logs via NestJS `Logger` and returns 500 `{ "message": "internal server error" }`. It never swallows exceptions silently.

---

## Testing Strategy

### Unit Tests (Jest)

Each shared lib and each app has collocated `*.spec.ts` files covering:

- **`mapDownstreamError`** (libs/common): verifies all timeout codes → returns HttpException 504; verifies all other inputs (no-response codes, downstream 4xx, downstream 5xx, unknown errors) → returns HttpException 502.
- **`ChaosService`**: state transitions, TTL timer scheduling (`jest.useFakeTimers()`), reset clears all fields including `_leakArray`, TTL expiry of memory leak frees array, `getState()` snapshot accuracy.
- **`ChaosInterceptor`**: excluded routes pass through with no delay/error; non-excluded routes: latency awaited (fake timers); error-rate injection statistical check.
- **`MetricsInterceptor`**: verifies that `metricsService.recordRequest` is called with correct arguments after the `res.close` event fires; verifies route label comes from `req.route?.path`, falling back to `"unmatched"`; verifies status 499 is recorded when `res.writableFinished === false`; verifies excluded routes are skipped entirely.
- **`MetricsService`**: counter/histogram increment logic for each metric.
- **DTOs**: `validate()` rejects invalid inputs, passes valid ones.
- **CoreService (Gateway, Orders)**: mocked `HttpService` — verifies 502 on ECONNREFUSED, 502 on downstream 5xx, 504 on timeout, happy-path response shape.

### Property-Based Tests (fast-check)

The project uses **fast-check** for property-based testing, with each test running a minimum of **100 iterations**.

Each test is tagged with a comment in this format:
`// Feature: victim-app, Property <N>: <property_text>`

**Property 1 — Request counter increment**
Generator: `fc.record({ method: fc.constantFrom('GET','POST','PUT','DELETE'), route: fc.constantFrom('/order','/payment'), statusCode: fc.integer({min:100,max:599}) })`. Assert `http_requests_total` increments by exactly 1.
`// Feature: victim-app, Property 1: request counter increments on every non-excluded request`

**Property 2 — Latency histogram duration (fake timers)**
Generator: `fc.integer({ min: 0, max: 30000 })` for delay. Use `jest.useFakeTimers()`. Set latency chaos to `d`, call `ChaosInterceptor.intercept(...)`, advance fake timers by `d` ms, assert histogram observation ≥ `d / 1000` seconds.
`// Feature: victim-app, Property 2: latency histogram records observed duration`

**Property 3 — Error counter 5xx only**
Generator: `fc.integer({ min: 100, max: 599 })` for status code. Assert `http_errors_total` increments iff code ≥ 500.
`// Feature: victim-app, Property 3: error counter increments on 5xx only`

**Property 4 — Error-rate statistical accuracy**
Generator: `fc.float({ min: 1, max: 100 })` for percentage, batch n = 200. Run `ChaosInterceptor` mock 200 times, count 500 responses. Assert count within ±4σ of `n * percentage / 100`.
`// Feature: victim-app, Property 4: chaos error-rate injection statistical accuracy`

**Property 5 — Latency injection adds delay (fake timers)**
Generator: `fc.integer({ min: 1, max: 30000 })` for `ms`. Use `jest.useFakeTimers()`. Activate latency chaos with `ms`, call `ChaosInterceptor.intercept(...)`, assert the `sleep(ms)` call is awaited (verified by advancing fake timers and checking execution proceeds only after advancing).
`// Feature: victim-app, Property 5: chaos latency injection adds delay`

**Property 6 — Reset clears all state**
Generator: `fc.record({ latencyMs: fc.integer({min:1,max:30000}), errorRatePercent: fc.float({min:0,max:100}), memoryLeakEnabled: fc.boolean() })`. Apply all settings, call `reset()`, assert all fields zeroed and `_leakArray.length === 0`.
`// Feature: victim-app, Property 6: chaos reset clears all state and frees leak memory`

**Property 7 — Excluded routes bypass chaos**
Generator: arbitrary chaos state + `fc.constantFrom('/metrics', '/health', '/chaos/state', '/chaos/reset')`. Assert `ChaosInterceptor` calls `next.handle()` immediately with no delay and no thrown exception.
`// Feature: victim-app, Property 7: excluded routes are never affected by chaos`

**Property 8 — DTO rejects out-of-range inputs**
Generator: `fc.integer().filter(n => n < 0 || n > 30000)` for `ms`; `fc.float().filter(n => n < 0 || n > 100)` for `percentage`. Assert `validate(dto)` returns a non-empty errors array.
`// Feature: victim-app, Property 8: DTO validation rejects out-of-range chaos inputs`

**Property 9 — ChaosState serialisation round-trip**
Generator: arbitrary `{ latencyMs, errorRatePercent, memoryLeakEnabled }`. Apply settings, call `getState()`, assert every field in the response matches the applied settings (expiry timestamps within 1-second tolerance).
`// Feature: victim-app, Property 9: ChaosState GET /chaos/state serialisation round-trip`

**Property 10 — mapDownstreamError status mapping**
Generator: `fc.constantFrom('ECONNABORTED','ETIMEDOUT','ERR_CANCELED')` → assert returns HttpException 504. Generator for all other cases: `fc.constantFrom('ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN')` (no-response) → assert returns HttpException 502. `fc.integer({min:400,max:599})` for downstream response status (covering 4xx and 5xx) → assert returns HttpException 502. Arbitrary unknown error shapes → assert returns HttpException 502.
`// Feature: victim-app, Property 10: mapDownstreamError maps error codes to correct HTTP status`

### Integration Tests

- **End-to-end smoke**: bring up all three services via `docker compose up`, send one `POST /order`, assert HTTP 200 and that `GET /metrics` on each service returns non-zero `http_requests_total`.
- **Chaos propagation**: enable error rate 100% on Orders; assert Gateway returns 502.
- **Chaos TTL**: set `CHAOS_TTL_SECONDS=1`, enable latency on Payments, wait 2 s, assert `GET /chaos/state` shows `latencyMs === 0`.
