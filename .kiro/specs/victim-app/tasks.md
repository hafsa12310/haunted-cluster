# Implementation Plan: victim-app

## Overview

Build the victim-app NestJS monorepo containing three services (Gateway, Orders, Payments), three shared libs (observability, chaos, common), and a load-generator script. Implementation proceeds bottom-up: shared libs first, then app modules, then Docker infrastructure, with property-based and unit tests co-located with the code they cover.

## Tasks

- [x] 1. Scaffold monorepo structure and shared configuration
  - Initialise the NestJS monorepo inside `victim-app/` with `nest new` or by hand-crafting `nest-cli.json`, `tsconfig.json`, and `package.json` at the `victim-app/` root.
  - Declare all three apps (`gateway`, `orders`, `payments`) and all three libs (`observability`, `chaos`, `common`) in `nest-cli.json`.
  - Install runtime dependencies: `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express`, `@nestjs/axios`, `axios`, `prom-client`, `class-validator`, `class-transformer`, `uuid`, `rxjs`, `reflect-metadata`.
  - Install dev dependencies: `jest`, `ts-jest`, `@types/jest`, `fast-check`, `@types/node`, `@nestjs/testing`, `@nestjs/cli`, `supertest`, `@types/supertest`.
  - Configure Jest `moduleNameMapper` in the root `jest.config.ts` (or `package.json`) for the lib path aliases: `@app/common`, `@app/observability`, `@app/chaos` — so tests can import shared libs without path gymnastics.
  - Create a `.gitignore` at `victim-app/` root ignoring `node_modules/`, `dist/`, and `.env`.
  - Create `victim-app/.env.example` with every environment variable listed in requirements 11.2–11.3 and 10.9.
  - _Requirements: 10.1, 11.1, 11.2, 11.3_

- [ ] 2. Implement `libs/common`
  - [x] 2.1 Create `env-validation.ts` — `validateRequiredEnv(vars: string[]): void`
    - Log a descriptive error and call `process.exit(1)` if any variable is absent from `process.env`.
    - _Requirements: 11.3, 11.4_

  - [x] 2.2 Create `is-excluded-route.ts` — `isExcludedRoute(path: string): boolean`
    - Return `true` for `/metrics`, `/health`, and any path starting with `/chaos/`.
    - _Requirements: 7.6_

  - [x] 2.3 Write property test for `isExcludedRoute`
    - **Property 7: Excluded routes are never affected by chaos**
    - **Validates: Requirements 7.6**

  - [ ] 2.4 Create `map-downstream-error.ts` — `mapDownstreamError(error: AxiosError, serviceName: string): HttpException`
    - Return 504 for `ECONNABORTED`, `ETIMEDOUT`, `ERR_CANCELED`; return 502 for everything else.
    - _Requirements: 1.4, 1.5, 1.6_

  - [ ] 2.5 Write property test for `mapDownstreamError`
    - **Property 10: mapDownstreamError maps error codes to correct HTTP status**
    - **Validates: Requirements 1.4, 1.5, 1.6**

  - [ ] 2.6 Create `downstream-http.module.ts` — `DownstreamHttpModule`
    - Wrap `HttpModule.registerAsync` reading `DOWNSTREAM_TIMEOUT_MS` from env (default 5000).
    - _Requirements: 1.6, 11.2_

  - [ ] 2.7 Create `common.module.ts` exporting `DownstreamHttpModule`, `mapDownstreamError`, `isExcludedRoute`, `validateRequiredEnv`, and `GlobalExceptionFilter`.
    - _Requirements: 1.4, 1.5, 1.6, 7.6_

  - [ ] 2.8 Create `global-exception.filter.ts` in `libs/common/src/` — `GlobalExceptionFilter`
    - Pass `HttpException` instances through unchanged, preserving their status code and response body.
    - For non-`HttpException` errors: log via NestJS `Logger` and return `500 { "message": "internal server error" }`.
    - Register via `APP_FILTER` in `CommonModule` so every app that imports `CommonModule` gets the filter for free.
    - Each app's `AppModule` imports `GlobalExceptionFilter` from `@app/common` — no local filter file needed.
    - _Requirements: 1.4, 1.5, 1.6_

  - [ ] 2.9 Write unit tests for `GlobalExceptionFilter`
    - Verify `HttpException` instances pass through with their original status code and body unchanged.
    - Verify unknown (non-`HttpException`) errors return HTTP 500 with `{ "message": "internal server error" }`.
    - _Requirements: 1.4, 1.5, 1.6_

- [ ] 3. Implement `libs/observability`
  - [ ] 3.1 Create `metrics.service.ts` — `MetricsService`
    - Instantiate a dedicated prom-client `Registry` (not the global default).
    - Register `http_requests_total` (Counter, labels: `method`, `route`, `status_code`, `service`).
    - Register `http_request_duration_seconds` (Histogram, labels: `method`, `route`, `service`, buckets as per requirement 2.6).
    - Register `http_errors_total` (Counter, labels: `method`, `route`, `status_code`, `service`).
    - Register `process_heap_used_bytes` (Gauge, label: `service`) and `process_rss_bytes` (Gauge, label: `service`).
    - Accept `serviceName` via module config and set it as the prom-client default label.
    - Start a `setInterval` (5 000 ms) to update heap and RSS gauges from `process.memoryUsage()`.
    - Implement `getMetrics(): Promise<string>` and `recordRequest(method, route, statusCode, durationSeconds): void`.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 2.7, 2.8_

  - [ ] 3.2 Write unit tests for `MetricsService`
    - Test counter and histogram increment logic, gauge update, and `recordRequest` for each metric.
    - _Requirements: 2.2, 2.3, 2.4, 2.7, 2.8_

  - [ ] 3.3 Create `metrics.interceptor.ts` — `MetricsInterceptor`
    - On `intercept`: call `isExcludedRoute`; if excluded, return `next.handle()` immediately with no timer.
    - Record `startTime = performance.now()`.
    - Obtain the raw `ServerResponse` and register `res.once('close', ...)`.
    - In the `close` callback: compute `durationSeconds`, determine status code (499 if `res.writableFinished === false`, else `res.statusCode`), read `route` from `req.route?.path ?? "unmatched"`, call `metricsService.recordRequest(...)`.
    - Return `next.handle()` without modification.
    - _Requirements: 2.2, 2.3, 2.4, 2.5_

  - [ ] 3.4 Write property test for `MetricsInterceptor` — request counter increment
    - **Property 1: Request counter increments on every non-excluded request**
    - **Validates: Requirements 2.2, 2.5**

  - [ ] 3.5 Write property test for `MetricsInterceptor` — latency histogram duration
    - **Property 2: Latency histogram records observed duration (fake timers)**
    - **Validates: Requirements 2.3, 3.2**

  - [ ] 3.6 Write property test for `MetricsInterceptor` — error counter 5xx only
    - **Property 3: Error counter increments on 5xx only**
    - **Validates: Requirements 2.4**

  - [ ] 3.7 Write unit tests for `MetricsInterceptor`
    - Verify `recordRequest` called with correct args after `res.close` fires.
    - Verify `route` label from `req.route?.path`, falling back to `"unmatched"`.
    - Verify status 499 when `res.writableFinished === false`.
    - Verify excluded routes are skipped entirely.
    - _Requirements: 2.2, 2.3, 2.4, 2.5_

  - [ ] 3.8 Create `metrics.controller.ts` — `MetricsController`
    - `GET /metrics` → set `Content-Type: text/plain; version=0.0.4`, return `metricsService.getMetrics()`.
    - _Requirements: 2.1_

  - [ ] 3.9 Create `health.controller.ts` in `libs/observability/src/` — `HealthController`
    - `GET /health` → return `{ status: 'ok', service: <serviceName> }` using the service name configured via `ObservabilityModule.forRoot({ serviceName })`.
    - No downstream calls are made.
    - _Requirements: 8.1, 8.2_

  - [ ] 3.10 Write unit tests for `HealthController`
    - Verify the response contains `status: 'ok'` and the correct `service` name as configured.
    - _Requirements: 8.1, 8.2_

  - [ ] 3.11 Create `observability.module.ts` — `ObservabilityModule` as a dynamic module
    - Expose `ObservabilityModule.forRoot({ serviceName: string })` — the `serviceName` is passed in and provided to both `MetricsService` and `HealthController`.
    - Export `MetricsService`, `MetricsInterceptor`, `MetricsController`, and `HealthController`.
    - _Requirements: 2.1, 2.8, 8.1_

- [ ] 4. Checkpoint — Ensure all tests pass for libs/common and libs/observability
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Implement `libs/chaos`
  - [ ] 5.1 Create chaos DTOs in `dto/`
    - `set-latency.dto.ts`: `SetLatencyDto` with `@IsInt() @Min(0) @Max(30000) ms: number`.
    - `set-error-rate.dto.ts`: `SetErrorRateDto` with `@IsNumber() @Min(0) @Max(100) percentage: number`.
    - `set-memory-leak.dto.ts`: `SetMemoryLeakDto` with `@IsBoolean() enabled: boolean`.
    - _Requirements: 3.3, 3.4, 3.5, 4.3, 4.4, 4.5, 5.5_

  - [ ] 5.2 Write property test for chaos DTOs
    - **Property 8: DTO validation rejects out-of-range chaos inputs**
    - **Validates: Requirements 3.3, 3.4, 4.3, 4.4**

  - [ ] 5.3 Create `chaos.service.ts` — `ChaosService`
    - Initialise `ChaosState` with all fields zeroed and all timers null.
    - Implement `setLatency(ms)`: update `state.latencyMs`, cancel and restart TTL timer.
    - Implement `setErrorRate(percentage)`: same TTL pattern.
    - Implement `enableMemoryLeak()`: start a 1 000 ms interval pushing `LEAK_MB_PER_SECOND × 1 MB` strings into `_leakArray`; schedule TTL expiry that stops timer AND sets `_leakArray = []`.
    - Implement `disableMemoryLeak()`: stop leak timer without freeing array.
    - Implement `reset()`: zero all fields, clear all timers, set `_leakArray = []`.
    - Implement `getState()`: return `ChaosStateResponse` snapshot.
    - Implement `crash()`: schedule `process.exit(1)` in 100 ms.
    - _Requirements: 3.1, 3.2, 4.1, 4.2, 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 7.1, 7.2, 7.4, 7.5_

  - [ ] 5.4 Write property test for `ChaosService` — reset clears all state
    - **Property 6: Chaos reset clears all state and frees leak memory**
    - **Validates: Requirements 7.1**

  - [ ] 5.5 Write property test for `ChaosService` — state serialisation round-trip
    - **Property 9: ChaosState serialisation round-trip**
    - **Validates: Requirements 7.5**

  - [ ] 5.6 Write unit tests for `ChaosService`
    - Test state transitions, TTL timer scheduling with `jest.useFakeTimers()`, reset clearing all fields, TTL expiry of memory leak freeing array, `getState()` snapshot accuracy.
    - _Requirements: 3.1, 3.2, 4.1, 4.2, 5.1, 5.2, 5.3, 5.4, 7.1, 7.4, 7.5_

  - [ ] 5.7 Create `chaos.interceptor.ts` — `ChaosInterceptor`
    - On `intercept`: call `isExcludedRoute`; if excluded, return `next.handle()` immediately.
    - If `latencyMs > 0`, `await sleep(latencyMs)`.
    - If `errorRatePercent > 0`, draw `Math.random() * 100`; if below threshold throw `HttpException(500, { message: 'chaos: injected error' })`.
    - Return `next.handle()`.
    - _Requirements: 3.1, 3.2, 4.1, 4.2, 7.6_

  - [ ] 5.8 Write property test for `ChaosInterceptor` — error rate statistical accuracy
    - **Property 4: Chaos error-rate injection statistical accuracy**
    - **Validates: Requirements 4.1, 4.2**

  - [ ] 5.9 Write property test for `ChaosInterceptor` — latency injection adds delay
    - **Property 5: Chaos latency injection adds delay to every non-excluded request (fake timers)**
    - **Validates: Requirements 3.1, 3.2**

  - [ ] 5.10 Write unit tests for `ChaosInterceptor`
    - Excluded routes pass through with no delay or error.
    - Non-excluded routes: latency awaited (fake timers), error-rate injection statistical check.
    - _Requirements: 3.1, 3.2, 4.1, 4.2, 7.6_

  - [ ] 5.11 Create `chaos.controller.ts` — `ChaosController` (prefix `/chaos`)
    - `POST /latency` → `chaosService.setLatency(dto.ms)`, return `{ message: 'latency set', ms }`.
    - `POST /error-rate` → `chaosService.setErrorRate(dto.percentage)`, return `{ message: 'error rate set', percentage }`.
    - `POST /memory-leak` → enable or disable accordingly.
    - `POST /crash` (`@HttpCode(202)`) → return `{ message: 'crashing' }` then call `chaosService.crash()`.
    - `POST /reset` → `chaosService.reset()`, return `{ message: 'chaos reset' }`.
    - `GET /state` → return `chaosService.getState()`.
    - _Requirements: 3.1, 3.3, 3.4, 3.5, 4.1, 4.3, 4.4, 4.5, 5.1, 5.4, 5.5, 6.1, 6.2, 7.1, 7.2, 7.3, 7.5_

  - [ ] 5.12 Create `chaos.module.ts` exporting `ChaosService`, `ChaosInterceptor`, `ChaosController`.
    - _Requirements: 3.1, 4.1, 5.1, 6.1, 7.1_

- [ ] 6. Checkpoint — Ensure all tests pass for libs/chaos
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Implement Gateway app
  - [ ] 7.1 Create `apps/gateway/src/core/core.service.ts`
    - Inject `HttpService` from `DownstreamHttpModule`.
    - `processOrder()`: `POST <ORDERS_URL>/order`; on `AxiosError` call `mapDownstreamError(error, 'orders')` and throw the result.
    - _Requirements: 1.1, 1.4, 1.5, 1.6, 1.7_

  - [ ] 7.2 Write unit tests for Gateway `CoreService`
    - Mocked `HttpService`: 502 on ECONNREFUSED, 502 on downstream 5xx, 504 on timeout, happy-path response shape.
    - _Requirements: 1.1, 1.4, 1.5, 1.6_

  - [ ] 7.3 Create `apps/gateway/src/core/core.controller.ts`
    - `POST /order` → delegates to `CoreService.processOrder()`.
    - _Requirements: 1.1_

  - [ ] 7.4 Create `apps/gateway/src/core/core.module.ts`
    - Import `DownstreamHttpModule`; declare and export `CoreService`, `CoreController`.
    - _Requirements: 1.1, 1.7_

  - [ ] 7.5 Create `apps/gateway/src/app.module.ts`
    - Import `ObservabilityModule.forRoot({ serviceName: 'gateway' })`, `ChaosModule`, `CoreModule`, `CommonModule`.
    - Register both interceptors as global `APP_INTERCEPTOR` providers: `MetricsInterceptor` first, `ChaosInterceptor` second.
    - `GlobalExceptionFilter` is provided via `CommonModule` — no local `APP_FILTER` registration needed.
    - _Requirements: 1.1, 2.2, 3.1, 4.1_

  - [ ] 7.6 Create `apps/gateway/src/main.ts`
    - Call `validateRequiredEnv(['ORDERS_URL'])` before `NestFactory.create`.
    - Enable `ValidationPipe` globally with `{ whitelist: true }`.
    - Read `PORT` from env (default 3000) and listen.
    - _Requirements: 11.1, 11.3, 11.4_

- [ ] 8. Implement Orders app
  - [ ] 8.1 Create `apps/orders/src/core/core.service.ts`
    - `processOrder()`: `POST <PAYMENTS_URL>/payment`; on `AxiosError` call `mapDownstreamError(error, 'payments')` and throw.
    - _Requirements: 1.2, 1.4, 1.5, 1.6, 1.8_

  - [ ] 8.2 Write unit tests for Orders `CoreService`
    - Same mock patterns as Gateway: 502/502/504/happy-path.
    - _Requirements: 1.2, 1.4, 1.5, 1.6_

  - [ ] 8.3 Create `apps/orders/src/core/core.controller.ts`, `core.module.ts`, `app.module.ts`, and `main.ts`
    - Follow the same shape as Gateway.
    - `app.module.ts`: import `ObservabilityModule.forRoot({ serviceName: 'orders' })`, `ChaosModule`, `CoreModule`, `CommonModule`; register `MetricsInterceptor` (first) and `ChaosInterceptor` (second) globally; `GlobalExceptionFilter` comes from `CommonModule`.
    - `main.ts`: call `validateRequiredEnv(['PAYMENTS_URL'])`; enable `ValidationPipe` globally with `{ whitelist: true }`; default PORT 3001.
    - _Requirements: 1.2, 2.2, 3.1, 4.1, 11.1, 11.3, 11.4_

- [ ] 9. Implement Payments app
  - [ ] 9.1 Create `apps/payments/src/core/core.service.ts`
    - `processPayment()`: return `{ status: 'paid', orderId: <uuid> }` — no downstream call.
    - _Requirements: 1.3_

  - [ ] 9.2 Create `apps/payments/src/core/core.controller.ts`, `core.module.ts`, `app.module.ts`, and `main.ts`
    - `app.module.ts`: import `ObservabilityModule.forRoot({ serviceName: 'payments' })`, `ChaosModule`, `CoreModule`, `CommonModule`; register `MetricsInterceptor` (first) and `ChaosInterceptor` (second) globally; `GlobalExceptionFilter` comes from `CommonModule`.
    - `main.ts`: no required env validation; enable `ValidationPipe` globally with `{ whitelist: true }`; default PORT 3002.
    - _Requirements: 1.3, 2.2, 3.1, 4.1, 11.1_

- [ ] 10. Checkpoint — Ensure all tests pass for all three apps
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Implement load-generator
  - [ ] 11.1 Create `load-generator/src/index.ts`
    - Read `GATEWAY_URL` (default `http://localhost:3000`) and `LOAD_INTERVAL_MS` (default 500) from env.
    - Loop: send `POST /order` with `AbortController` timeout of 10 000 ms; log status and response time to stdout; on error log and continue; wait `LOAD_INTERVAL_MS` between requests.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [ ] 11.2 Create `load-generator/tsconfig.json` and `load-generator/Dockerfile`
    - Multi-stage Dockerfile: build stage compiles with `tsc`, runtime stage copies `dist/` and `node_modules`.
    - _Requirements: 10.1_

- [ ] 12. Write multi-stage Dockerfiles for Gateway, Orders, Payments
  - Create `apps/gateway/Dockerfile`, `apps/orders/Dockerfile`, `apps/payments/Dockerfile`.
  - Stage 1: `FROM node:20-alpine AS builder` — `npm ci`, then `npx nest build <name>`.
  - Stage 2: copy `dist/apps/<name>`, `node_modules`, `package.json`; set `NODE_ENV=production`; `CMD ["node", "dist/main"]`.
  - _Requirements: 10.1, 10.2_

- [ ] 13. Write Prometheus configuration and docker-compose.yml
  - [ ] 13.1 Write `prometheus/prometheus.yml` at the repository root (one level above `victim-app/`)
    - Set `scrape_interval: 2s`; add three scrape jobs for gateway (3000), orders (3001), payments (3002).
    - _Requirements: 10.2_

  - [ ] 13.2 Write `docker-compose.yml` at the repository root (one level above `victim-app/`)
    - Build contexts for gateway, orders, payments, and load-generator are all set to `./victim-app` (relative to the repo root).
    - The Prometheus config volume mount references `./prometheus/prometheus.yml` at the repo root.
    - Define services: gateway, orders, payments, prometheus, load-generator.
    - Set `restart: unless-stopped` for gateway, orders, payments, load-generator.
    - Set `mem_limit: 256m` for gateway, orders, payments.
    - Add healthchecks using `wget -qO-` for each app service.
    - Set all inter-service env vars (`ORDERS_URL`, `PAYMENTS_URL`, `GATEWAY_URL`, chaos env vars).
    - Configure Prometheus to depend on all three app services reaching healthy state.
    - Expose ports 3000, 3001, 3002, 9090.
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8_

- [ ] 14. Checkpoint — Ensure all tests pass and Dockerfiles are valid
  - Run `npm test` to verify the full test suite.
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 15. Write integration tests
  - [ ] 15.1 End-to-end smoke test
    - Start all three services, send `POST /order` to Gateway, assert HTTP 200.
    - Assert `GET /metrics` on each service returns non-zero `http_requests_total`.
    - _Requirements: 9.1, 2.2_

  - [ ] 15.2 Chaos propagation test
    - Enable error rate 100% on Orders via `POST /chaos/error-rate`.
    - Send `POST /order` to Gateway, assert HTTP 502.
    - _Requirements: 4.1, 1.4_

  - [ ] 15.3 Chaos TTL expiry test
    - Set `CHAOS_TTL_SECONDS=1`, enable latency on Payments via `POST /chaos/latency`.
    - Wait 2 s, assert `GET /chaos/state` on Payments returns `latencyMs === 0`.
    - _Requirements: 7.4_

  - _Requirements: 3.1, 4.1, 7.4, 9.1_

- [ ] 16. Final checkpoint — Ensure all services are healthy and tests pass
  - Run `docker compose up` (from the repo root) and verify all five services are healthy within 30 seconds.
  - Run the integration tests from Task 15 against the running stack.
  - Run `npm test` for the full unit and property test suite.
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- All test tasks are required (no optional tasks in this plan).
- Each task references specific requirements for full traceability.
- Implementation language is TypeScript throughout (strict mode, per tech stack steering).
- Property-based tests use `fast-check` with a minimum of 100 iterations each and are tagged with `// Feature: victim-app, Property <N>: <text>`.
- All configuration is read from environment variables; no hardcoded values in application code.
- `GlobalExceptionFilter` lives in `libs/common` and is provided via `CommonModule` — no per-app filter file.
- `HealthController` lives in `libs/observability` and receives its `serviceName` via `ObservabilityModule.forRoot(...)`.
- `docker-compose.yml` and `prometheus/prometheus.yml` live at the repository root; all build contexts point to `./victim-app`.
- Checkpoints at tasks 4, 6, 10, 14, and 16 ensure incremental validation.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["2.1", "2.2", "2.4", "2.6"] },
    { "id": 1, "tasks": ["2.3", "2.5", "2.7"] },
    { "id": 2, "tasks": ["2.8", "3.1", "5.1"] },
    { "id": 3, "tasks": ["2.9", "3.2", "3.3", "5.2", "5.3"] },
    { "id": 4, "tasks": ["3.4", "3.5", "3.6", "3.7", "3.8", "5.4", "5.5", "5.6", "5.7"] },
    { "id": 5, "tasks": ["3.9", "5.8", "5.9", "5.10", "5.11"] },
    { "id": 6, "tasks": ["3.10", "3.11", "5.12", "7.1", "8.1", "9.1"] },
    { "id": 7, "tasks": ["7.2", "7.3", "7.4", "8.2", "8.3", "9.2"] },
    { "id": 8, "tasks": ["7.5", "7.6", "11.1", "12"] },
    { "id": 9, "tasks": ["11.2", "13.1"] },
    { "id": 10, "tasks": ["13.2"] },
    { "id": 11, "tasks": ["15.1", "15.2", "15.3"] }
  ]
}
```
