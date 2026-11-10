# Project structure

## Top level
- `victim-app/` — NestJS monorepo with three services that can be broken on purpose. Complete.
  - `apps/gateway`, `apps/orders`, `apps/payments` — call chain gateway → orders → payments
  - `libs/common` — downstream HTTP client, error mapping, route exclusion, env validation, global exception filter
  - `libs/observability` — Prometheus metrics, metrics interceptor, /metrics and /health
  - `libs/chaos` — chaos service, interceptor, controller and DTOs
  - `load-generator/` — steady fake traffic to gateway
- `haunting-engine/` — standalone NestJS app that polls Prometheus, scores health, attributes faults, tracks incidents, proxies chaos and streams events over Socket.IO. Complete (rule-based; the ML layer comes from the engine-intelligence spec).
  - `src/config/` — env config and validation
  - `src/health/` — health scoring
  - `src/incidents/` — fault attribution and incident tracking
  - `src/metrics/` — PromQL queries, Prometheus client, metrics collector
  - `src/chaos-proxy/` — proxy to the victim-app chaos endpoints
  - `src/engine/` — engine state, poller, Socket.IO gateway
  - `test/` — integration tests against the running stack
- `shared/` — types-only package (`@haunted-cluster/shared`): interfaces and types, no runtime code
- `haunted-house/` — Next.js frontend (visuals, audio, chaos triggers, and display of the ghost's messages). Not started. The ghost narrator's LLM calls run server-side, never in the browser.
- `prometheus/prometheus.yml` and `docker-compose.yml` — at the repository root; compose starts the whole stack

## NestJS conventions
- Organize by feature modules: each feature has its own folder with its module, controller, service, and DTOs together.
- Controllers only handle HTTP/WebSocket input and output. All business logic lives in services.
- DTOs are validated with class-validator.
- Test files sit next to the file they test, named `*.spec.ts`. Integration tests live in each app's `test/` folder.
- In the victim-app, shared code lives in `libs/` and is imported through path aliases (`@app/common`, `@app/observability`, `@app/chaos`). Never duplicate it inside an app.

## Haunting engine conventions
- Scoring, attribution, incident tracking (and any new analysis logic) are pure functions: no I/O, no timers, no shared state.
- Only `PollerService` changes engine state. New logic plugs into its per-Poll pipeline.

## Frontend conventions
- Components in `haunted-house/components/`, audio logic in `haunted-house/audio/`.
- Keep audio logic separate from UI components.

## Shared types
- Any event sent between haunting-engine and haunted-house must be defined once in `shared/`
  and imported by both sides. Never duplicate event types.
- `shared/` contains only types and is imported from `shared/dist` (declarations), never from `shared/src`.