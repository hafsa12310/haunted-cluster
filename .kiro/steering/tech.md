# Tech stack

- Language: TypeScript everywhere, with strict mode enabled. No `any` unless justified in a comment.
- Backends: NestJS (victim-app services and haunting-engine).
- Frontend: Next.js with the App Router, React, functional components and hooks only.
- Real-time: Socket.IO between haunting-engine and the frontend.
- Audio: Tone.js in the browser.
- Metrics: prom-client in services, Prometheus for collection.
- Validation: class-validator and class-transformer for all DTOs.
- Testing: Jest for unit tests; fast-check for property-based tests on core logic.
- Running locally: Docker Compose starts every service with one command.

## Rules
- Configuration comes from environment variables, never hardcoded. Keep `.env.example` updated.
- Never commit secrets or API keys.
- Handle errors explicitly; never swallow exceptions silently.
- Prefer small, readable functions over clever code.