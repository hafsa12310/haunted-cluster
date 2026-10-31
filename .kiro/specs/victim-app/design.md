# Design Document

## Overview

The victim-app is a set of three NestJS microservices — **Gateway** (port 3000), **Orders** (port 3001), and **Payments** (port 3002) — that form a deliberate call chain for The Haunted Cluster demo. Every real request flows Gateway → Orders → Payments, giving the haunting-engine a live call graph with meaningful latency and error signals.

Each service is structurally identical in shape: a core feature module handling its business logic, a shared MetricsModule for Prometheus instrumentation, and a ChaosModule that exposes endpoints to inject failure modes on demand. A standalone load-generator script drives steady baseline traffic through the chain, and the whole stack is wired together by a single `docker compose up`.

Design goals:
- **Observability first** — every non-excluded request updates counters and histograms without developer effort; metrics are emitted automatically via an interceptor.
- **Controllable chaos** — each service can have latency, error rate, and memory-leak chaos enabled independently and will heal itself after `CHAOS_TTL_SECONDS`.
- **Uniform module layout** — identical NestJS feature-module structure across all three services makes the codebase predictable and easy to navigate.

---

## Architecture

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

        │metrics scrape (every 15 s)
        ▼
┌─────────────┐
│ Prometheus  │
│   :9090     │
└─────────────┘
```

### Error Propagation

- Downstream unreachable → 502 with `{ "message": "..." }`
- Downstream returns 5xx → 502 with `{ "message": "..." }`
- Downstream timeout (>`DOWNSTREAM_TIMEOUT_MS`) → 504 with `{ "message": "..." }`

### Chaos Intercept Order

For every inbound non-excluded request, the ChaosMiddleware runs first, applying latency delay and error-rate injection before the route handler executes. The MetricsInterceptor wraps the entire request lifecycle (including the middleware-injected delay) so the histogram records total observed latency.

```
Request
  │
  ▼
ChaosMiddleware ──► [delay if latency chaos] ──► [maybe return 500 if error-rate chaos]
  │
  ▼
MetricsInterceptor (starts timer)
  │
  ▼
Route Handler
  │
  ▼
MetricsInterceptor (stops timer, increments counters)
  │
  ▼
Response
```

---

## Components and Interfaces

### Shared Service Layout

Each of the three services follows this NestJS module layout:

```
src/
  app.module.ts          # Root module: imports CoreModule, MetricsModule, ChaosModule
  main.ts                # Bootstrap: reads PORT, validates required env vars, starts app
  core/
    core.module.ts
    core.controller.ts   # Handles the service's primary route (/order or /payment or /health)
    core.service.ts      # Business logic + downstream HTTP calls
  metrics/
    metrics.module.ts
    metrics.service.ts   # prom-client registry, counter/histogram/gauge creation
    metrics.interceptor.ts  # NestJS interceptor that records request metrics
  chaos/
    chaos.module.ts
    chaos.controller.ts  # All /chaos/* endpoints
    chaos.service.ts     # ChaosState management, TTL timers, leak timer
    chaos.middleware.ts  # Applies latency delay and error-rate injection per request
    dto/
      set-latency.dto.ts
      set-error-rate.dto.ts
      set-memory-leak.dto.ts
```

### Gateway Core Module

**Controller** (`GET /health`, `POST /order`):
- `GET /health` → returns `{ status: "ok", service: "gateway" }` directly (no downstream call).
- `POST /order` → delegates to `GatewayCoreService.placeOrder()`.

**Service** (`GatewayCoreService`):
- Calls `POST <ORDERS_URL>/order` via the injected `HttpService`.
- Wraps the Axios call with a timeout of `DOWNSTREAM_TIMEOUT_MS` ms.
- Maps errors: connection refused / ECONNREFUSED → 502; Axios timeout → 504; downstream 5xx → 502.

### Orders Core Module

**Controller** (`GET /health`, `POST /order`):
- `POST /order` → delegates to `OrdersCoreService.processOrder()`.

**Service** (`OrdersCoreService`):
- Calls `POST <PAYMENTS_URL>/payment` via `HttpService`.
- Same timeout and error-mapping logic as Gateway.

### Payments Core Module

**Controller** (`GET /health`, `POST /payment`):
- `POST /payment` → returns `{ status: "paid", orderId: <uuid> }`.

### MetricsModule

**`MetricsService`**:
- Creates and owns a `prom-client` `Registry` instance (not the global default, to allow test isolation).
- Registers the following metrics on construction:
  - `http_requests_total` — Counter, labels: `method`, `route`, `status_code`, `service`.
  - `http_request_duration_seconds` — Histogram, labels: `method`, `route`, `service`, buckets: `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`.
  - `http_errors_total` — Counter, labels: `method`, `route`, `status_code`, `service`.
  - `process_heap_used_bytes` — Gauge, label: `service`.
  - `process_rss_bytes` — Gauge, label: `service`.
- Sets the `service` default label to the service name at startup.
- Starts a `setInterval` every 5 000 ms that reads `process.memoryUsage()` and updates heap and RSS gauges.
- Exposes `getMetrics(): Promise<string>` for the `/metrics` endpoint.
- Exposes `recordRequest(method, route, statusCode, durationSeconds)` for the interceptor.

**`MetricsInterceptor`** (implements `NestInterceptor`):
- On `intercept()`: records start time with `performance.now()`.
- On observable `finalize()`: calculates duration, reads `response.statusCode`, resolves `route` from `request.route.path` (never raw URL), calls `metricsService.recordRequest(...)`.
- Applied globally in `AppModule` via `APP_INTERCEPTOR`.

**`/metrics` endpoint** lives in `MetricsModule`'s controller:
- `GET /metrics` → sets `Content-Type: text/plain; version=0.0.4` and returns `metricsService.getMetrics()`.

### ChaosModule

**`ChaosService`**:
- Holds a `ChaosState` object in memory (see Data Models).
- `setLatency(ms)`: updates state, cancels existing timer, starts a new `setTimeout` for `CHAOS_TTL_SECONDS` that calls `resetLatency()`.
- `setErrorRate(percentage)`: same TTL pattern.
- `enableMemoryLeak()`: starts a `setInterval` (1 000 ms) that pushes `LEAK_MB_PER_SECOND` × 1 MB strings into the leak array; schedules TTL reset.
- `disableMemoryLeak()`: clears the interval but does not free the array.
- `reset()`: calls all individual reset methods AND frees the leak array by reassigning to `[]`.
- `getState()`: returns a snapshot of `ChaosState` including expiry ISO strings.
- `crash()`: schedules `process.exit(1)` in 100 ms.

**`ChaosMiddleware`** (implements `NestMiddleware`):
- Applied to all routes, but short-circuits immediately for excluded routes (`/metrics`, `/health`, `/chaos/*`).
- If `latency > 0`: `await sleep(latency)`.
- If `errorRate > 0`: draws a random float `[0, 1)`; if `< errorRate/100`, sends `{ message: "chaos: injected error" }` with status 500 and calls `next()` skipping further processing.

**`ChaosController`** (prefix `/chaos`):
- `POST /latency` — body: `SetLatencyDto`; calls `chaosService.setLatency(dto.ms)`; returns `{ message: "latency set", ms: dto.ms }`.
- `POST /error-rate` — body: `SetErrorRateDto`; calls `chaosService.setErrorRate(dto.percentage)`; returns `{ message: "error rate set", percentage: dto.percentage }`.
- `POST /memory-leak` — body: `SetMemoryLeakDto`; calls `enable` or `disable` accordingly.
- `POST /crash` — returns 202 `{ message: "crashing" }` then calls `chaosService.crash()`.
- `POST /reset` — calls `chaosService.reset()`; returns `{ message: "chaos reset" }`.
- `GET /state` — returns `chaosService.getState()`.

### Load Generator

A standalone TypeScript script (`load-generator/src/index.ts`) with no NestJS dependency:
- Reads `GATEWAY_URL` (default `http://localhost:3000`) and `LOAD_INTERVAL_MS` (default `500`).
- Runs an async loop: sends `POST /order` with `AbortController` timeout of 10 000 ms, logs status and response time, waits `LOAD_INTERVAL_MS`, repeats.
- On error: logs to stdout, continues loop (never exits on request failure).
- Compiled with `tsc` and run with `node`.

### Inter-Service HTTP Client

Each service that makes downstream calls uses NestJS `HttpModule` (Axios under the hood):
- Registered in `CoreModule` with `HttpModule.registerAsync({ useFactory: () => ({ timeout: +process.env.DOWNSTREAM_TIMEOUT_MS || 5000 }) })`.
- Error handling in the service catches `AxiosError`:
  - `err.code === 'ECONNREFUSED'` or `err.code === 'ENOTFOUND'` → throw `HttpException` 502.
  - `err.code === 'ECONNABORTED'` or `err.response == null && err.code === 'ERR_CANCELED'` → throw `HttpException` 504.
  - `err.response?.status >= 500` → throw `HttpException` 502.

---

## Data Models

### ChaosState (in-memory, per-service)

```typescript
interface ChaosState {
  latencyMs: number;           // current injected delay in ms; 0 = disabled
  latencyExpiresAt: Date | null;

  errorRatePercent: number;    // 0–100; 0 = disabled
  errorRateExpiresAt: Date | null;

  memoryLeakEnabled: boolean;
  memoryLeakExpiresAt: Date | null;
  memoryLeakRetainedMb: number;  // approximate MB currently retained

  // internal, not serialised to GET /chaos/state
  _leakArray: unknown[];
  _leakTimer: NodeJS.Timeout | null;
  _latencyTimer: NodeJS.Timeout | null;
  _errorRateTimer: NodeJS.Timeout | null;
}
```

### DTOs

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

### GET /chaos/state response shape

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

### GET /health response shape

```typescript
interface HealthResponse {
  status: "ok";
  service: "gateway" | "orders" | "payments";
}
```

### Downstream error response shape

```typescript
interface ErrorResponse {
  message: string;  // e.g. "orders service unavailable" or "payments timed out"
}
```

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Request counter increments on every non-excluded request

*For any* HTTP method, route pattern (that is not `/metrics`, `/health`, or a `/chaos/*` path), and status code, completing one request SHALL increment `http_requests_total` by exactly one, labelled with the correct method, matched route pattern, and status code.

**Validates: Requirements 2.2, 2.5**

### Property 2: Latency histogram records observed duration

*For any* request to a non-excluded route with a known injected delay `d` (in seconds), the recorded `http_request_duration_seconds` observation SHALL be greater than or equal to `d` and less than `d + 0.5` (allowing reasonable scheduling overhead), using the matched route pattern as the `route` label.

**Validates: Requirements 2.3, 2.5**

### Property 3: Error counter increments on 5xx only

*For any* non-excluded request, `http_errors_total` SHALL be incremented if and only if the response status code is in the range 500–599; requests with status codes outside that range SHALL NOT increment it.

**Validates: Requirements 2.4**

### Property 4: Chaos error-rate injection statistical accuracy

*For any* error rate `p` (0 < p ≤ 100) and any sufficiently large batch of requests `n` (n ≥ 200), the number of requests that return HTTP 500 due to chaos SHALL be within the 99% confidence interval of a Binomial(n, p/100) distribution, and all non-injected requests SHALL return their normal status code.

**Validates: Requirements 4.1, 4.2**

### Property 5: Chaos latency injection adds delay to every non-excluded request

*For any* configured latency `ms` (1 ≤ ms ≤ 30 000), every non-excluded request processed while latency chaos is active SHALL take at least `ms` milliseconds to complete.

**Validates: Requirements 3.2**

### Property 6: Chaos reset clears all state

*For any* combination of active chaos settings (latency, error rate, memory leak simultaneously enabled), calling reset SHALL result in a `ChaosState` where `latencyMs === 0`, `errorRatePercent === 0`, `memoryLeakEnabled === false`, and `_leakArray` is empty.

**Validates: Requirements 7.1**

### Property 7: Excluded routes are never affected by chaos

*For any* chaos state (any latency, any error rate, memory leak enabled), requests to `/metrics`, `/health`, and any `/chaos/*` path SHALL always receive a response with status < 500 and SHALL complete without injected delay.

**Validates: Requirements 7.6**

### Property 8: DTO validation rejects out-of-range chaos inputs

*For any* integer `ms` outside [0, 30 000] sent to `/chaos/latency`, the service SHALL return HTTP 400. *For any* number `percentage` outside [0, 100] sent to `/chaos/error-rate`, the service SHALL return HTTP 400.

**Validates: Requirements 3.3, 3.4, 4.3, 4.4**

### Property 9: ChaosState GET /chaos/state serialisation round-trip

*For any* combination of chaos settings applied via the chaos endpoints, the JSON body returned by `GET /chaos/state` SHALL accurately reflect the current values of `latencyMs`, `errorRatePercent`, `memoryLeakEnabled`, `memoryLeakRetainedMb`, and all expiry timestamps.

**Validates: Requirements 7.5**

---

## Error Handling

### Service-Level HTTP Errors

| Condition | Status | Body |
|---|---|---|
| Downstream connection refused | 502 | `{ "message": "<service> service unavailable" }` |
| Downstream 5xx response | 502 | `{ "message": "<service> returned error" }` |
| Downstream timeout | 504 | `{ "message": "<service> timed out" }` |
| DTO validation failure | 400 | `{ "message": "<field> must be ..." }` (class-validator message) |
| Chaos-injected error | 500 | `{ "message": "chaos: injected error" }` |

### Startup Validation

`main.ts` in Gateway and Orders reads required env vars (`ORDERS_URL` / `PAYMENTS_URL`) before calling `app.listen()`. If absent:
```
logger.error('ORDERS_URL is required but not set. Exiting.');
process.exit(1);
```

### Unhandled Exceptions

NestJS's default exception filter handles all unhandled `HttpException` subclasses. A custom `AllExceptionsFilter` is registered globally to catch non-HTTP errors, log them via NestJS `Logger`, and return a generic 500 `{ "message": "internal server error" }` — never swallowing the exception silently.

---

## Testing Strategy

### Unit Tests (Jest)

Each service's test suite covers:

- **CoreService**: mocked `HttpService` — verifies 502 on connection refused, 502 on downstream 5xx, 504 on timeout, and the happy-path response shape.
- **ChaosService**: state transitions, TTL timer scheduling (using `jest.useFakeTimers()`), reset clears all fields, `getState()` returns correct snapshot.
- **ChaosMiddleware**: verifies excluded routes pass through instantly with no error injection; verifies that non-excluded routes are delayed by the configured amount; verifies statistical behavior of error-rate injection.
- **MetricsInterceptor**: verifies the counter/histogram methods on a mocked `MetricsService` are called with correct arguments after a request completes.
- **DTOs**: verifies that `validate()` rejects invalid inputs and passes valid ones.

Focus on specific examples and integration points; property-based tests handle broad input coverage.

### Property-Based Tests (fast-check)

The project uses **fast-check** for property-based testing, with each test running a minimum of **100 iterations**.

Each test is tagged with a comment in the format:
`// Feature: victim-app, Property <N>: <property_text>`

**Property 1 — Request counter increment**
Generator: arbitrary `{ method, route, statusCode }` (route drawn from a set of valid non-excluded patterns). Assert `http_requests_total` increments by exactly 1 per call to `metricsService.recordRequest(...)`.
`// Feature: victim-app, Property 1: request counter increments on every non-excluded request`

**Property 2 — Latency histogram duration**
Generator: arbitrary delay `d` in [0, 100] ms. Set latency chaos to `d`, fire a request through the middleware, measure elapsed time. Assert recorded histogram observation ≥ `d/1000` seconds.
`// Feature: victim-app, Property 2: latency histogram records observed duration`

**Property 3 — Error counter 5xx only**
Generator: arbitrary status code in [100, 599]. Assert `http_errors_total` is incremented iff code ≥ 500.
`// Feature: victim-app, Property 3: error counter increments on 5xx only`

**Property 4 — Error-rate statistical accuracy**
Generator: arbitrary `percentage` in (0, 100], batch size n = 200. Run the ChaosMiddleware mock 200 times, count 500 responses. Assert count is within a ±4 σ band of expected `n * percentage / 100`.
`// Feature: victim-app, Property 4: chaos error-rate injection statistical accuracy`

**Property 5 — Latency injection adds delay**
Generator: arbitrary `ms` in [1, 200]. Activate latency chaos, measure wall time for a middleware invocation. Assert elapsed ≥ ms.
`// Feature: victim-app, Property 5: chaos latency injection adds delay`

**Property 6 — Reset clears all state**
Generator: arbitrary combination of `{ latencyMs, errorRatePercent, memoryLeakEnabled }`. Apply all three via service methods, then call `reset()`. Assert all fields return to zero/false/empty.
`// Feature: victim-app, Property 6: chaos reset clears all state`

**Property 7 — Excluded routes bypass chaos**
Generator: arbitrary chaos state (latency, error rate). For each excluded path (`/metrics`, `/health`, `/chaos/state`), run the middleware. Assert response status < 500 and elapsed time < 50 ms (no injected delay).
`// Feature: victim-app, Property 7: excluded routes are never affected by chaos`

**Property 8 — DTO rejects out-of-range inputs**
Generator: arbitrary integer outside [0, 30 000] for `ms`; arbitrary number outside [0, 100] for `percentage`. Assert `validate(dto)` returns a non-empty errors array.
`// Feature: victim-app, Property 8: DTO validation rejects out-of-range chaos inputs`

**Property 9 — ChaosState serialisation round-trip**
Generator: arbitrary `{ latencyMs, errorRatePercent, memoryLeakEnabled }`. Apply settings, call `getState()`, assert every field in the response matches the applied settings (including expiry timestamps within a 1-second tolerance).
`// Feature: victim-app, Property 9: ChaosState GET /chaos/state serialisation round-trip`

### Integration Tests

- End-to-end smoke test: bring up Gateway + Orders + Payments with `docker compose up` (or test containers), send one `POST /order`, assert HTTP 200 and that Prometheus `/metrics` on each service now contains non-zero `http_requests_total`.
- Chaos propagation: enable error rate 100% on Orders, assert Gateway returns 502.
- Chaos TTL: set `CHAOS_TTL_SECONDS=1`, enable latency, wait 2 s, assert chaos is cleared.
