# Implementation Plan: haunting-engine

## Overview

Build the `shared/` types-only package and the `haunting-engine` NestJS app. Implementation goes pure core first (config, scoring, attribution, incident tracker), then I/O around it (Prometheus client, chaos proxy, poller, Socket.IO), then Docker and compose, then integration tests against the full stack. Each app milestone ends with a real boot, not just a green test run (lesson from victim-app task 7).

## Tasks

- [x] 1. Scaffold `shared/` and `haunting-engine/`
  - Create `shared/package.json` (`@haunted-cluster/shared`, private, `"types": "dist/index.d.ts"`) and `shared/tsconfig.json` (strict, `declaration: true`, `emitDeclarationOnly: true`, `outDir: dist`, `rootDir: src`).
  - Create `haunting-engine/` as a standalone NestJS app: `package.json`, `nest-cli.json`, `tsconfig.json`, `tsconfig.build.json` (`rootDir: ./src`, excludes `**/*.spec.ts` and `test/`).
  - Pin the same versions as victim-app where they overlap (`@nestjs/*` 10.3.10, TypeScript 5.5.3, Jest 29.7.0, fast-check 3.20.0, `@types/node` 20.14.10). Add `@nestjs/websockets` and `@nestjs/platform-socket.io` 10.3.10, `class-validator`, `class-transformer`, `rxjs`, `reflect-metadata`; dev: `@nestjs/testing`, `@nestjs/cli`, `ts-jest`, `@types/jest`, `socket.io-client`, `supertest`, `@types/supertest`.
  - Add `paths: { "@haunted-cluster/shared": ["../shared/dist/index"] }` to `tsconfig.json`.
  - Scripts: `build:shared` (`tsc -p ../shared/tsconfig.json`), `prebuild` and `pretest` running `build:shared`, `test` (`jest --runInBand`), `test:e2e` (`jest --config ./test/jest-e2e.json --runInBand`).
  - Jest config in `package.json` with `roots: ["<rootDir>/src/"]`.
  - Add `shared/dist/` and `haunting-engine/dist/` to the root `.gitignore` (it already covers `node_modules/`).
  - _Requirements: 1.2, 12.1_

- [x] 2. Implement `shared/` types
  - [x] 2.1 Write `service-health.ts`, `incident.ts`, `chaos.ts`, `events.ts` and `index.ts` exactly as in design.md Data Models
    - Only `interface` and `type` declarations: no enums, no `const`, no functions.
    - _Requirements: 1.1, 1.2_

  - [x] 2.2 Verify the shared build output
    - Run `npm run build:shared` from `haunting-engine/`; confirm `shared/dist/` contains only `.d.ts` files.
    - Write a throwaway file in `haunting-engine/src/` that imports every type from `@haunted-cluster/shared`, run `tsc --noEmit`, then delete it.
    - _Requirements: 1.2, 1.3_

- [x] 3. Implement configuration
  - [x] 3.1 Create `config/engine-config.ts`: `EngineConfig`, `ConfigError`, `loadEngineConfig(env)`
    - Required: `PROMETHEUS_URL`, `<SERVICE>_URL` per chain entry (upper-case, `-` → `_`).
    - Defaults and validation exactly as design.md Configuration.
    - _Requirements: 13.1, 13.2, 13.3, 7.7_

  - [x] 3.2 Write unit tests for `loadEngineConfig`
    - Defaults; each missing required var; `ok ≥ critical`; non-numeric; bad `RATE_WINDOW`; duplicate chain entries; custom chain URL derivation.
    - _Requirements: 13.1, 13.2, 13.3_

  - [x] 3.3 Create `config/config.module.ts` — global module providing `ENGINE_CONFIG` and a `CLOCK` token (`{ now: () => Date.now() }`)
    - _Requirements: 13.2_

  - [x] 3.4 Create `haunting-engine/.env.example` listing every variable from Requirement 13 with its default
    - _Requirements: 13.4_

- [x] 4. Implement health scoring
  - [x] 4.1 Create `health/health-scoring.ts`: `badness`, `scoreService`, `clusterDread`, `unknownHealth`
    - Status from `maxBadness`, never from the rounded score.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 11.3_

  - [x] 4.2 Write property test for `badness`
    - **Property 1: Badness is bounded and monotonic**
    - **Validates: Requirements 3.1**

  - [x] 4.3 Write property test for `scoreService`
    - **Property 2: Score, status and breached kinds are consistent**
    - **Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.6, 11.3**

  - [x] 4.4 Write property test for `clusterDread`
    - **Property 3: Dread is the worst badness**
    - **Validates: Requirements 3.7**

- [x] 5. Implement fault attribution
  - [x] 5.1 Create `incidents/attribution.ts`: `Attribution`, `attributeFaults(chain, health)`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [x] 5.2 Write property test for `attributeFaults`
    - **Property 4: Attribution is complete and well-formed**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6**

  - [x] 5.3 Write unit tests for `attributeFaults` covering every row of the worked-examples table in design.md, plus the documented concurrent-fault limitation (gateway latency + payments errors → one incident rooted at payments, gateway affected with `latency`)
    - _Requirements: 4.1, 4.2, 4.3_

- [x] 6. Implement the incident tracker
  - [x] 6.1 Create `incidents/incident-tracker.ts`: `TrackerState`, `IncidentEvent`, `PollInput`, `initialTrackerState(chain)`, `fingerprint`, `trackIncidents`
    - Follow the per-Poll algorithm in design.md exactly, including: blind Polls return state unchanged; `unknown` services freeze streaks; `down` opens immediately; kinds only grow; `updated` only on kind/affected change; history newest first, trimmed to the limit.
    - _Requirements: 5.1–5.7, 6.1–6.3, 8.1_

  - [x] 6.2 Write property test for hysteresis
    - **Property 5: Hysteresis on open and close**
    - **Validates: Requirements 5.1, 5.2, 5.5**

  - [x] 6.3 Write property test for immediate `down`
    - **Property 6: `down` opens immediately**
    - **Validates: Requirements 5.3**

  - [x] 6.4 Write property test for blind Polls
    - **Property 7: Blind Polls are no-ops**
    - **Validates: Requirements 5.6, 11.1**

  - [x] 6.5 Write property test for recurrence and history
    - **Property 8: Recurrence and bounded history**
    - **Validates: Requirements 6.1, 6.2, 6.3**

  - [x] 6.6 Write property test for `fingerprint`
    - **Property 10: Fingerprint follows the primary-kind rule**
    - **Validates: Requirements 5.7**

  - [x] 6.7 Write unit tests for `trackIncidents`
    - `relatedChaos` filtered by root service and evidence window, newest first; `updated` not emitted for peak-only changes; peaks keep max values and min score; resolved incident has `resolvedAt` and `durationMs`.
    - _Requirements: 5.4, 5.5, 8.1_

- [x] 7. Checkpoint — Ensure all tests pass for the pure core
  - Run `npm test` in `haunting-engine/`; run `npx tsc --noEmit`.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement metrics collection
  - [x] 8.1 Create `metrics/promql.ts` — `buildQueries(config)`, with a unit test asserting the exact query strings
    - _Requirements: 2.2, 2.3_

  - [x] 8.2 Create `metrics/prometheus.client.ts`: `PrometheusClient.query`, `parseVector`, `MetricsUnavailableError`
    - `fetch` with `AbortSignal.timeout(prometheusTimeoutMs)`; whole-query failures throw `MetricsUnavailableError` with `cause`.
    - _Requirements: 2.2, 2.6, 2.8, 11.1_

  - [x] 8.3 Write property test for `parseVector`
    - **Property 9: Prometheus parsing never throws on sample values**
    - **Validates: Requirements 2.6**

  - [x] 8.4 Write unit tests for `PrometheusClient` (mocked `fetch`): non-2xx, `status: "error"` body, timeout, network error → `MetricsUnavailableError`
    - _Requirements: 2.8, 11.1_

  - [x] 8.5 Create `metrics/metrics-collector.service.ts` and `metrics.module.ts`
    - Combine the five vectors into `Record<ServiceName, ServiceSignals>` exactly as in design.md.
    - _Requirements: 2.2, 2.4, 2.5, 2.6_

  - [x] 8.6 Write unit tests for `MetricsCollectorService` (mocked client)
    - Missing error series with traffic → 0; zero rate → `errorRatio` null; unit conversions; missing `up` → null; one query rejecting → `collect()` rejects.
    - _Requirements: 2.4, 2.5, 2.6_

- [x] 9. Implement the chaos proxy
  - [x] 9.1 Create DTOs in `chaos-proxy/dto/`: `SetLatencyDto`, `SetErrorRateDto`, `SetMemoryLeakDto`
    - _Requirements: 7.2_

  - [x] 9.2 Write property test for chaos proxy DTOs
    - **Property 11: Chaos proxy DTOs reject out-of-range input**
    - **Validates: Requirements 7.2**

  - [x] 9.3 Create `chaos-proxy/chaos-log.service.ts` (newest first, capped at 100) with unit tests
    - _Requirements: 8.2_

  - [x] 9.4 Create `chaos-proxy/chaos-proxy.service.ts`: `forward`, `state`, `resetAll`
    - Error mapping table from design.md; record a Chaos_Event and call `EventsGateway.emitChaos` on success.
    - _Requirements: 7.1, 7.4, 7.5, 7.6_

  - [x] 9.5 Write unit tests for `ChaosProxyService` (mocked `fetch`)
    - 2xx and 202 passthrough with event recorded; 5xx → 502; network error → 502; timeout → 504; no event recorded on failure; `resetAll` partial failure.
    - _Requirements: 7.4, 7.5, 7.6_

  - [x] 9.6 Create `known-service.pipe.ts` and `chaos-proxy.controller.ts` (`/reset-all` declared before `/:service/*`), with unit tests for the pipe's 404
    - _Requirements: 7.1, 7.3_

  - [x] 9.7 Create `chaos-proxy.module.ts`
    - _Requirements: 7.1_

- [x] 10. Implement engine state, poller and Socket.IO
  - [x] 10.1 Create `engine/engine-state.service.ts`
    - _Requirements: 9.4, 10.2, 10.3_

  - [x] 10.2 Create `engine/events.gateway.ts` typed with `Server<ClientToServerEvents, ServerToClientEvents>`, and a custom `IoAdapter` that reads `corsOrigin` from config
    - _Requirements: 1.4, 9.1, 9.2, 9.3, 9.4, 9.5_

  - [x] 10.3 Write unit tests for `EventsGateway`: on connect, sends snapshot (when present) and `incident:list` to that client only; `emitIncidentEvent` maps each event type to the right event name
    - _Requirements: 9.3, 9.4_

  - [x] 10.4 Create `engine/poller.service.ts` with the `setTimeout` chain and per-Poll pipeline from design.md
    - _Requirements: 2.1, 2.7, 9.2, 9.3, 11.1, 11.2_

  - [x] 10.5 Write unit tests for `PollerService` (fake timers, mocked collector and gateway)
    - No overlap while a Poll is pending; delay subtracts elapsed time; `MetricsUnavailableError` → `unknown` snapshot emitted and loop continues; unexpected error logged and loop continues; `onModuleDestroy` stops scheduling.
    - _Requirements: 2.1, 2.7, 11.1, 11.2_

- [x] 11. Implement REST read endpoints
  - [x] 11.1 Create `HealthController`, `SnapshotController`, `IncidentsController`
    - _Requirements: 10.1, 10.2, 10.3_

  - [x] 11.2 Write unit tests: `/api/snapshot` 503 before first Poll and 200 after; `/api/incidents` ordering
    - _Requirements: 10.2, 10.3_

- [x] 12. Wire the app and boot it for real
  - [x] 12.1 Create `engine/engine.module.ts`, `incidents/incidents.module.ts` and `app.module.ts`
    - _Requirements: 9.1_

  - [x] 12.2 Create `main.ts`
    - Call `loadEngineConfig(process.env)` before `NestFactory.create`; on `ConfigError` log `[Bootstrap] <message>. Exiting.` and `process.exit(1)`.
    - `ValidationPipe({ whitelist: true })`, `enableCors({ origin })`, custom IoAdapter, listen on `PORT`.
    - _Requirements: 9.1, 9.5, 13.1, 13.3_

  - [x] 12.3 Write a unit test that builds the full `AppModule` with `Test.createTestingModule` (Prometheus client and poller timers mocked) and calls `app.init()`
    - Catches module wiring errors (like the victim-app `exports` bug) that per-class tests can't see.
    - _Requirements: 9.1_

  - [x] 12.4 Smoke run: `npm run build`, confirm the entry is at `dist/main.js`, start it against the running victim stack (`PROMETHEUS_URL=http://localhost:9090`, service URLs on localhost), and check `/health`, `/api/snapshot` and one chaos proxy call by hand
    - _Requirements: 12.5_

- [x] 13. Write the Dockerfile and root `.dockerignore`
  - Exactly as in design.md Infrastructure.
  - Build with `docker build -f haunting-engine/Dockerfile .` from the repo root; check the build context size in the log is small (no `node_modules`), and run the image to confirm `CMD ["node", "dist/main"]` starts.
  - _Requirements: 12.1, 12.4_

- [x] 14. Update `docker-compose.yml`
  - Add the `prometheus` healthcheck (first confirm `wget` exists in the image: `docker run --rm --entrypoint wget prom/prometheus:v2.53.0 --help`).
  - Add the `haunting-engine` service exactly as in design.md.
  - _Requirements: 12.2, 12.3_

- [x] 15. Checkpoint — Ensure all tests pass and the stack starts
  - Run `npm test` in `haunting-engine/` and in `victim-app/`.
  - Run `docker compose up --build` from the repo root; confirm all six services start and `haunting-engine` is healthy and emitting snapshots within 30 seconds.
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 16. Write integration tests (`haunting-engine/test/`)
  - [ ] 16.1 Create `test/jest-e2e.json` and `test/helpers.ts` (engine URL from `ENGINE_URL`, default `http://localhost:4000`; a `nextEvent(socket, name, predicate, timeoutMs)` helper; `afterAll` calls `/api/chaos/reset-all`)
    - _Requirements: 9.1_

  - [ ] 16.2 Snapshot stream test
    - Snapshot with `metricsAvailable: true` within 10 s; all three services `healthy` within 30 s.
    - _Requirements: 9.2, 12.5_

  - [ ] 16.3 Incident lifecycle and chaos evidence test
    - Error rate 100 % on orders via the proxy → `incident:opened` (root orders, `errors`, gateway affected, chaos event in `relatedChaos`) → reset → `incident:resolved` with the same ID within 45 s.
    - _Requirements: 4.1, 4.2, 5.2, 5.5, 7.6, 8.1, 9.3_

  - [ ] 16.4 Recurrence test
    - Repeat 16.3's scenario; second incident has `recurrence.count ≥ 1` and `lastIncidentId` equal to the first incident's ID.
    - _Requirements: 6.2_

  - [ ] 16.5 Chaos proxy error test
    - Unknown service → 404; `{ ms: -1 }` → 400.
    - _Requirements: 7.2, 7.3_

- [ ] 17. Final checkpoint — Calibrate and verify
  - With the stack idle (load generator running, no chaos), record each service's p95 latency, error ratio and RSS from `/api/snapshot`. If idle RSS is within 20 MB of `MEMORY_OK_MB` or idle p95 is above `LATENCY_OK_MS`, adjust the defaults in config, `.env.example` and design.md, and say so.
  - Trigger `crash` on payments 5 times via the proxy and record how many produced a `down` incident; record the result in design.md Open Question 1 and ask the user whether to act on it.
  - Run `npm run test:e2e` and `npm test` in both projects.
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- All test tasks are required (no optional tasks in this plan).
- Each task references specific requirements for traceability.
- TypeScript strict mode throughout; no `any` without a justifying comment.
- Property-based tests use `fast-check` with at least 100 iterations, tagged `// Feature: haunting-engine, Property <N>: <text>`.
- Scoring, attribution and incident tracking are pure functions; only `PollerService` changes engine state.
- `shared/` contains only types and is imported from `shared/dist` (declarations), never from `shared/src`, to keep `dist/main.js` flat. See design.md "Why `shared/` is types-only".
- The haunting-engine Docker build context is the repo root; the victim-app build contexts stay `./victim-app`.
- Checkpoints at tasks 7, 15 and 17; a real boot at 12.4.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "3.1"] },
    { "id": 2, "tasks": ["2.2", "3.2", "3.3", "3.4", "4.1"] },
    { "id": 3, "tasks": ["4.2", "4.3", "4.4", "5.1", "8.1", "8.2", "9.1"] },
    { "id": 4, "tasks": ["5.2", "5.3", "6.1", "8.3", "8.4", "8.5", "9.2", "9.3"] },
    { "id": 5, "tasks": ["6.2", "6.3", "6.4", "6.5", "6.6", "6.7", "8.6", "10.1"] },
    { "id": 6, "tasks": ["10.2", "11.1"] },
    { "id": 7, "tasks": ["9.4", "10.3", "10.4", "11.2"] },
    { "id": 8, "tasks": ["9.5", "9.6", "10.5"] },
    { "id": 9, "tasks": ["9.7", "12.1"] },
    { "id": 10, "tasks": ["12.2", "12.3"] },
    { "id": 11, "tasks": ["12.4", "13"] },
    { "id": 12, "tasks": ["14"] },
    { "id": 13, "tasks": ["16.1"] },
    { "id": 14, "tasks": ["16.2", "16.3", "16.5"] },
    { "id": 15, "tasks": ["16.4"] }
  ]
}
```
