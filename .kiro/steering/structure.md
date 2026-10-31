# Project structure

## Top level
- `victim-app/` — three NestJS services (gateway, orders, payments) that can be broken on purpose
- `haunting-engine/` — NestJS backend that reads metrics, scores health, detects anomalies, and emits events
- `haunted-house/` — Next.js frontend (visuals, audio, ghost narrator)
- `shared/` — shared TypeScript types, especially event shapes used by both backend and frontend
- `prometheus/` — Prometheus config

## NestJS conventions
- Organize by feature modules: each feature has its own folder with its module, controller, service, and DTOs together.
- Controllers only handle HTTP/WebSocket input and output. All business logic lives in services.
- DTOs are validated with class-validator.
- Test files sit next to the file they test, named `*.spec.ts`.

## Frontend conventions
- Components in `haunted-house/components/`, audio logic in `haunted-house/audio/`.
- Keep audio logic separate from UI components.

## Shared types
- Any event sent between haunting-engine and haunted-house must be defined once in `shared/`
  and imported by both sides. Never duplicate event types.