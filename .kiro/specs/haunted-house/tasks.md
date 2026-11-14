# Implementation Plan: haunted-house

## Overview

Six milestones, each ending with a real boot (build, start, hit a health endpoint), not just a green test run:

- A: engine chaos rate limit, CORS and trust proxy (haunting-engine).
- B: frontend scaffold and all pure logic (reducer, ghost builder, chaos client, audio mapping and more).
- C: UI (tokens, fonts, SVG scene, panels, controls, Tone.js engine, cues) and the full-page test.
- D: Docker, compose, root `.dockerignore` fix and `.env.example` files.
- E: full-stack verification, `npm audit`, manual sound check and the deployment note for the Client_Key.
- F: docs and steering updates.

Conventions for every task:

- Property tests use fast-check 3.20.0 with `numRuns` of at least 100 and carry the tag `// Feature: haunted-house, Property <N>: <text>`. Each property test lives in its own `*.prop.spec.ts` file next to the code it tests, so tasks never share a file.
- Engine pins follow tech.md: NestJS 10.3.10, TypeScript 5.5.3, Jest 29.7.0, fast-check 3.20.0, @types/node 20.14.10. Frontend pins follow design.md: Next 14.2.35, React and React DOM 18.3.1, `socket.io-client` 4.7.5, `tone` 14.7.77, `@testing-library/react` 16.0.0. Verify every pin with `npm view <pkg> version` at install time and use exact versions, never ranges.
- Frontend is TypeScript strict. Shared types come only from `@haunted-cluster/shared` (resolved to `shared/dist`). Pure logic takes time and visibility as arguments, never reads `Date.now()` or `document`.
- Requirement numbers read `<requirement>.<criterion>`, for example `9.3` is Requirement 9, criterion 3.
- Design property numbers (P1 to P37) refer to "Correctness Properties" in design.md.

## Tasks

- [x] 1. Engine configuration for the chaos rate limit
  - [x] 1.1 Extend `haunting-engine/src/config/engine-config.ts`
    - Add `ChaosRateLimitConfig { max; windowSeconds }`, `chaosRateLimit` and `trustProxy` to `EngineConfig`.
    - Read `CHAOS_RATE_LIMIT_MAX` (default 5) and `CHAOS_RATE_LIMIT_WINDOW_SECONDS` (default 60) with the strict pattern `/^[1-9]\d*$/`; anything else (`0`, `-1`, `1.5`, `abc`, `1e2`, `0x10`, whitespace) throws `ConfigError` naming the variable. Unset or blank uses the default.
    - Read `TRUST_PROXY`: `true` or `false`, case-insensitive and trimmed, unset means `false`; any other value throws `ConfigError('TRUST_PROXY', ...)`. Keep the existing collecting-reader behaviour (`variables` lists every offender).
    - Confirm `corsOrigin` already reads `CORS_ORIGIN` with default `http://localhost:3100`; add it if missing.
    - _Requirements: 9.7, 9.8, 14.8_

  - [x] 1.2 Write unit tests in `engine-config.spec.ts`
    - Defaults (5, 60, `false`, CORS default), valid overrides, one rejection per invalid class for each of the two limit variables with the variable named, `TRUST_PROXY` accepted as `true`, `TRUE`, ` false `, rejected as `maybe` and `1`.
    - Existing config tests keep passing unchanged.
    - _Requirements: 9.7, 9.8_

  - [x] 1.3 Write property test for rate-limit configuration
    - **Property 37: Rate-limit configuration rejects non-positive-integers**
    - File: `engine-config.rate-limit.prop.spec.ts`
    - **Validates: Requirements 9.7, 9.8**

- [x] 2. Sliding-window limiter
  - [x] 2.1 Create `haunting-engine/src/chaos-proxy/rate-limit/sliding-window.ts`
    - Export `WindowDecision`, `decide(timestamps, nowMs, max, windowMs)` and `prune(timestamps, nowMs, windowMs)`. Pure functions: no I/O, no clock reads, inputs never mutated.
    - Counted requests are those with `nowMs - t < windowMs`. Under the limit returns `{ allowed: true, retryAfterSeconds: 0 }`. At the limit returns `retryAfterSeconds = clamp(ceil((oldest + windowMs - nowMs) / 1000), 1, windowSeconds)`.
    - _Requirements: 9.2, 9.3_

  - [x] 2.2 Write property test for Retry-After
    - **Property 34: Retry-After is a whole number inside the window**
    - File: `sliding-window.prop.spec.ts`
    - **Validates: Requirements 9.2, 9.3**

  - [x] 2.3 Create `chaos-rate-limit.service.ts`
    - `ChaosRateLimitService` with `reserve(key)` returning `{ ok: true; reservation }` or `{ ok: false; retryAfterSeconds }`, and `refund(reservation)` removing one occurrence of that timestamp. State is `Map<string, number[]>`; `reserve` prunes the key first, empty keys are deleted, and a sweep removes keys with nothing inside the window once the map passes 10 000 keys.
    - Inject config through `ENGINE_CONFIG` and time through an injectable `CLOCK` provider (create `CLOCK` beside the service if no equivalent exists).
    - _Requirements: 9.1, 9.5, 9.6, 9.12_

  - [x] 2.4 Write unit tests in `chaos-rate-limit.service.spec.ts`
    - Fake clock: N+1 requests from one key give a rejection; window expiry re-allows; two keys are independent; refund restores one slot; the sweep bounds memory; `reserve` on a limited key does not add a timestamp.
    - _Requirements: 9.1, 9.2, 9.5, 9.12_

  - [x] 2.5 Write property tests for the store
    - **Property 33: Exactly `min(N, max)` requests are accepted**, file `chaos-rate-limit.accept.prop.spec.ts`
    - **Property 35: Clients are limited independently**, file `chaos-rate-limit.clients.prop.spec.ts`
    - **Property 36: Invalid requests do not use up the allowance**, file `chaos-rate-limit.refund.prop.spec.ts`
    - Add `rate-limit/test-support.ts` (test-only generators and a fake clock), never imported by production code.
    - **Validates: Requirements 9.1, 9.5, 9.12, 9.13, 15.4**

- [ ] 3. Guard, interceptor and wiring
  - [ ] 3.1 Create `chaos-rate-limit.guard.ts` and `rate-limited-chaos.decorator.ts`
    - Guard key is `req.ip` with the `::ffff:` prefix stripped; an undefined `ip` becomes the shared key `unknown` (fails closed). When `reserve` rejects, set the `Retry-After` header and throw `HttpException({ message: 'The ghost needs rest: ... Try again in N seconds.' }, 429)`. When ok, store the reservation on the request.
    - `@RateLimitedChaos()` is `applyDecorators(UseGuards(...), UseInterceptors(...))`.
    - _Requirements: 9.1, 9.2, 9.3, 9.9, 9.10_

  - [ ] 3.2 Create `chaos-rate-limit-refund.interceptor.ts`
    - Wrap the handler with `catchError`: on an `HttpException` with status 400 or 404 call `refund` and rethrow; any other error is rethrown untouched.
    - _Requirements: 9.12_

  - [ ] 3.3 Apply the decorator and register providers
    - Put `@RateLimitedChaos()` on the six `POST` handlers in `chaos-proxy.controller.ts` (latency, error-rate, memory-leak, crash, reset, reset-all) and on nothing else. Register the service, guard, interceptor and `CLOCK` in `chaos-proxy.module.ts`. Validation, forwarding, status mapping and event recording stay unchanged.
    - _Requirements: 9.1, 9.4, 9.6, 9.11_

- [ ] 4. Application setup, trust proxy and CORS
  - [ ] 4.1 Create `config/cors-options.ts` and update `engine/cors-io.adapter.ts`
    - `buildCorsOptions(origin)` returns `{ origin, methods: ['GET','POST','OPTIONS'], exposedHeaders: ['Retry-After'] }`. The Socket.IO adapter passes the same object as `cors`.
    - _Requirements: 14.8_

  - [ ] 4.2 Create `src/app.setup.ts` and update `main.ts`
    - `configureApp(app, config)`: `app.set('trust proxy', config.trustProxy ? 1 : false)`, global `ValidationPipe({ whitelist: true })`, `enableCors(buildCorsOptions(...))`, `CorsIoAdapter`, `enableShutdownHooks()`. `main.ts` uses `NestFactory.create<NestExpressApplication>` then `configureApp`; a `ConfigError` still logs and exits with code 1.
    - _Requirements: 9.8, 9.9, 9.10, 14.8_

- [ ] 5. Engine environment files and compose
  - [ ] 5.1 Update `haunting-engine/.env.example` and the engine service in `docker-compose.yml`
    - Add `PORT`, `CORS_ORIGIN` (comment: set it to the public frontend URL when deployed), `CHAOS_RATE_LIMIT_MAX`, `CHAOS_RATE_LIMIT_WINDOW_SECONDS` and `TRUST_PROXY` (comment: `true` only behind exactly one proxy that appends the client address) with a one-line description each.
    - Pass `CORS_ORIGIN`, `CHAOS_RATE_LIMIT_MAX`, `CHAOS_RATE_LIMIT_WINDOW_SECONDS` and `TRUST_PROXY` as `${NAME:-default}` in compose, with a comment at `CORS_ORIGIN` saying it must match the public frontend URL.
    - _Requirements: 9.7, 14.8, 14.11, 14.12, 14.13_

  - [ ] 5.2 Extend `src/config/env-files.spec.ts`
    - Assert the new variables and defaults appear in `.env.example` and compose, and that the two comments exist.
    - _Requirements: 9.7, 14.11, 14.12, 14.13_

- [ ] 6. Engine HTTP tests
  - [ ] 6.1 Write `chaos-rate-limit.http.spec.ts` (limit and Retry-After)
    - Build the app with `AppModule.forRoot(config)` and `configureApp`, `CHAOS_RATE_LIMIT_MAX=2`, fake victim `fetch`. The third `POST /api/chaos/orders/crash` returns 429 with `{ message }`, `Retry-After` is an integer string with `1 <= value <= window`, the victim was called twice, no third chaos event was recorded.
    - Add `supertest` only if it is not already a devDependency, at an exact pinned version.
    - _Requirements: 9.2, 9.3, 15.6_

  - [ ] 6.2 Write `chaos-rate-limit.spoof.spec.ts` (X-Forwarded-For)
    - (a) `TRUST_PROXY` unset: `max + 1` requests from one direct address with a different `X-Forwarded-For` each give 429 on the last. (b) `TRUST_PROXY=true`: requests with different client-supplied left-hand entries but the same rightmost entry share a key and the last gets 429; a different rightmost entry gets its own allowance.
    - _Requirements: 9.9, 9.10, 15.11_

  - [ ] 6.3 Write `chaos-rate-limit.routes.spec.ts` (scope, CORS, validation)
    - All six POST routes share one counter; `reset-all` consumes exactly one slot; after the limit, `GET /api/chaos/orders/state`, `GET /api/snapshot` and `GET /health` still answer; invalid DTO bodies and an unknown service are not counted; a limited key does not block another key.
    - CORS: a preflight `OPTIONS` for `POST` with `content-type` from `http://localhost:3100` is accepted, the 429 response carries `Access-Control-Expose-Headers` containing `Retry-After`, another origin gets no `Access-Control-Allow-Origin`.
    - _Requirements: 9.1, 9.4, 9.5, 9.6, 9.12, 14.8_

  - [ ] 6.4 Extend `src/app.module.spec.ts` (AppModule init)
    - Build the full `AppModule` with the rate limit in place, run `configureApp`, and assert `app.init()` resolves without throwing. Close the app in `afterAll`.
    - _Requirements: 15.5_

- [ ] 7. Checkpoint A - Engine rate limit: tests green and real boot
  - In `haunting-engine/` run `npm run build:shared`, `npm run build`, `npm test`; all exit 0.
  - Start the engine in a separate terminal: `PROMETHEUS_URL=http://localhost:9090 GATEWAY_URL=http://localhost:3000 ORDERS_URL=http://localhost:3001 PAYMENTS_URL=http://localhost:3002 CHAOS_RATE_LIMIT_MAX=5 CHAOS_RATE_LIMIT_WINDOW_SECONDS=60 PORT=4000 npm start`.
  - `curl -fsS http://localhost:4000/health` returns 200. Then `for i in 1 2 3 4 5 6; do curl -s -o /dev/null -D - -X POST http://localhost:4000/api/chaos/gateway/reset | head -n 1; done`: the first five return 502 (no victim running, still counted) and the sixth returns 429. `curl -si -X POST http://localhost:4000/api/chaos/gateway/reset | grep -i -E '^(HTTP|retry-after)'` shows 429 and a `Retry-After` header.
  - `CHAOS_RATE_LIMIT_MAX=0 npm start` exits with code 1 and names the variable.
  - Stop the engine. Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 9.2, 9.3, 9.8, 15.9, 15.13_

- [ ] 8. Frontend scaffold
  - [ ] 8.1 Create the `haunted-house/` project skeleton
    - `package.json` with exact pins (Next 14.2.35, React and React DOM 18.3.1, `socket.io-client` 4.7.5, `tone` 14.7.77, TypeScript 5.5.3, Jest 29.7.0, `jest-environment-jsdom`, fast-check 3.20.0, `@types/node` 20.14.10, `@testing-library/react` 16.0.0 and its jest-dom peer), verifying each with `npm view`. Scripts: `build:shared`, `prebuild` (clean, `build:shared`, `check-shared-dist`, `check-structure`), `build`, `start` (`next start -p 3100 -H 0.0.0.0`), `pretest` (`build:shared` and `check-shared-dist`), `test` (`jest --runInBand`), `typecheck` (`tsc --noEmit`).
    - `tsconfig.json` with `strict: true` and the path alias `@haunted-cluster/shared` to `../shared/dist/index`; `jest.config.mjs` using `next/jest` and jsdom; App Router `app/layout.tsx` and a minimal `app/page.tsx`; `.gitignore` entries for `.next` and `node_modules`.
    - _Requirements: 13.1, 13.3, 13.4, 13.9, 14.1_

  - [ ] 8.2 Environment validation: `lib/engine-url.mjs`, `lib/env.ts`, `next.config.mjs`
    - `parseEngineUrl(raw)` accepts only an absolute `http:` or `https:` URL, strips trailing slashes, and throws an error containing `NEXT_PUBLIC_ENGINE_URL` otherwise. `next.config.mjs` calls it so both `next build` and `next start` fail without serving anything. `lib/env.ts` is the only reader of the variable and exports `ENGINE_URL`; no hardcoded fallback host anywhere else. Add `lib/engine-url.d.mts`.
    - Unit tests: valid http and https, trailing slashes, empty, relative, `ftp:`, garbage; the error names the variable; idempotent re-parse.
    - _Requirements: 1.1, 1.2, 14.7, 14.9, 14.10_

  - [ ] 8.3 Create the structural checks in `scripts/`
    - `clean.mjs`, `check-shared-dist.mjs` (requires `index`, `events`, `service-health`, `incident`, `intelligence` and `chaos` `.d.ts` files in `shared/dist`, exits 1 naming the missing file), and `check-structure.mjs` with exported rule functions: import path containing `shared/src`; `any` without an adjacent `//` comment; React, JSX or hooks under `audio/`; `tone` imported outside `audio/audio-engine.ts`; `extends React.Component`, `Component` or `PureComponent`; colour literals outside `design/tokens.ts`; the words `openai`, `anthropic`, `api_key`, `apikey` or a `Bearer ` literal in non-test source; any `/chaos/` URL not preceded by `/api`.
    - Unit tests run each rule against fixture strings (pass and fail cases) and once against the real tree.
    - _Requirements: 6.16, 8.4, 12.6, 13.2, 13.4, 13.5, 13.6, 13.7, 13.8_

  - [ ] 8.4 Create `lib/constants.ts`
    - Every tunable with the documented default: `RECENT_INCIDENTS_LIMIT` 10, `GHOST_MESSAGE_LIMIT` 50, `CHAOS_COOLDOWN_MS` 3000, `CHAOS_REQUEST_TIMEOUT_MS` 5000, `RESULT_VISIBLE_MS` 6000, `SILENCE_MS` 1500, `HEARTBEAT_MIN_BPM` 40, `HEARTBEAT_MAX_BPM` 180, plus the design additions (`MAX_ROOMS`, `RATE_LIMIT_DEFAULT_WAIT_S`, `RETRY_AFTER_MAX_S`, `CHAOS_MARK_VISIBLE_MS`, `AUDIO_RAMP_MS`, `AMBIENT_BASE`, `BLIND_AMBIENT`, `LOST_CONTACT_TONE_LEVEL`, `FORECAST_HEARTBEAT_HORIZON_S`, `FORECAST_HEARTBEAT_FLOOR`, socket backoff and timeout values).
    - Unit test pins the documented defaults.
    - _Requirements: 14.7_

  - [ ] 8.5 Write property test for engine URL parsing
    - **Property 32: Engine URL parsing**
    - File: `lib/engine-url.prop.spec.ts`
    - **Validates: Requirements 1.2, 14.9**

- [ ] 9. Cluster state and payload validation
  - [ ] 9.1 Create `state/test-support.ts`
    - Test-only fast-check generators and `deepFreeze`: `arbService`, `arbSnapshot` (0 to 10 services, statuses including invalid strings), `arbIncident`, `arbForecast`, `arbAnomaly`, `arbClusterAction`, `arbAudioInput` (including `NaN`, `Infinity`, out-of-range values). Never imported by production code (extend `check-structure` if needed).
    - _Requirements: 15.3_

  - [ ] 9.2 Create `state/validate.ts`
    - `parseSnapshot`, `parseIncident`, `parseIncidentList`, `parseChaosEvent`, `parseAnomalyReading`, `parseAnomalyCleared`, `parseForecast`, `parseForecastCleared`, each `(raw: unknown) => T | null`, null on any missing or mistyped required field. Service `status` is checked only as a string so a bad status degrades one Room (2.12). Unit tests cover one missing field per event type.
    - _Requirements: 1.11, 2.12_

  - [ ] 9.3 Write property test for invalid payloads
    - **Property 2: Invalid payloads leave state unchanged**
    - File: `state/validate.prop.spec.ts`
    - **Validates: Requirements 1.11**

  - [ ] 9.4 Create `state/cluster-state.ts` and `state/connection.ts`
    - `ClusterState`, `ClusterAction`, `initialClusterState`, pure `clusterReducer` and total `connectionReducer`, with the rules in design.md (connect resets everything except `recentIncidents`; connect_error and disconnect clear anomalies and forecasts, set `lostContactAtMs` once, keep incidents; stale snapshots ignored; the same snapshot twice equals once; incident list, upsert and resolve rules; anomaly and forecast upserts and removals; chaos marks; silence deadline `atMs + SILENCE_MS` set when a service newly goes `down`, page visible, never on a first snapshot, always replacing the old deadline).
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 3.2, 3.3, 3.4, 3.9, 3.11, 4.1, 4.2, 4.3, 4.4, 4.15, 4.16, 6.11, 6.19, 8.13_

  - [ ] 9.5 Write unit tests in `state/cluster-state.spec.ts`
    - Action-by-action examples: reconnect reset, late REST snapshot ignored, 503 path leaves state empty, resolve twice keeps one entry, silence restart not extension, hidden page sets no silence, `connecting` never returns after a failure.
    - _Requirements: 1.5, 1.6, 4.3, 4.4, 6.11, 6.19, 15.1_

  - [ ] 9.6 Write property test for connection transitions
    - **Property 1: Connection loss and reconnect transitions**
    - File: `state/cluster-state.connection.prop.spec.ts`
    - **Validates: Requirements 1.4, 1.5, 1.6, 3.11, 4.15**

  - [ ] 9.7 Write property test for snapshot idempotence
    - **Property 3: Snapshot application is idempotent and never goes backwards**
    - File: `state/cluster-state.snapshot.prop.spec.ts`
    - **Validates: Requirements 1.9, 1.10, 3.4**

  - [ ] 9.8 Write property test for incident lists
    - **Property 11: Incident lists stay consistent**
    - File: `state/cluster-state.incidents.prop.spec.ts`
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**

- [ ] 10. Selectors, countdown and atmosphere
  - [ ] 10.1 Create `state/forecast-format.ts`
    - `roundCountdown(t)` is `Math.max(5, Math.round(t / 5) * 5)`; `selectCountdown(forecast)` gives `"<service> dies in ~<N> s (est.)"`, `"<service> is about to die (~0 s, est.)"` for `0`, `null` for no warning or null time, each with a non-empty `ariaLabel`.
    - Unit tests: `roundCountdown(2) = 5`, `(47) = 45`, `(48) = 50`, the `0` text, the `null` cases.
    - _Requirements: 3.5, 3.6, 3.7, 3.8, 3.10, 3.12, 15.1_

  - [ ] 10.2 Write property test for countdown rounding
    - **Property 9: Countdown rounding**
    - File: `state/forecast-format.round.prop.spec.ts`
    - **Validates: Requirements 3.5, 3.6, 3.7**

  - [ ] 10.3 Write property test for countdown visibility
    - **Property 10: Countdown shown only for usable warnings**
    - File: `state/forecast-format.select.prop.spec.ts`
    - **Validates: Requirements 3.5, 3.8, 3.10, 3.12**

  - [ ] 10.4 Create `state/atmosphere.ts`
    - `atmosphereFor(dread)` with `d = clamp01(finite(dread))`: `darkness = 0.15 + 0.6d`, `flicker = clamp01((d - 0.3) / 0.7)`, `fog = 0.1 + 0.7d`. Unit tests for 0, 0.5, 1, `NaN`, out-of-range.
    - _Requirements: 2.10_

  - [ ] 10.5 Write property test for atmosphere
    - **Property 7: Atmosphere is monotonic in Dread**
    - File: `state/atmosphere.prop.spec.ts`
    - **Validates: Requirements 2.10**

  - [ ] 10.6 Create `state/format.ts` and `state/selectors.ts`
    - `formatMetric` (dash for null or undefined), `formatSignalValue`, `normalizeStatus`, `selectRooms` (first `MAX_ROOMS` services in order, forced `unknown` on lost contact or a blind snapshot, `[]` with no snapshot), `selectIncidentRows` (open first then recent, newest first, "suspected root" wording, restart caveat, durations frozen at lost contact, recurrence, similar, related chaos), `selectHighlightedServices`, `selectBlind`, `selectAtmosphere`, `selectAudioInput`.
    - _Requirements: 2.1, 2.2, 2.7, 2.8, 2.9, 2.12, 3.1, 3.12, 4.5, 4.7, 4.8, 4.9, 4.10, 4.11, 4.12, 4.13, 4.14, 4.17, 11.9, 11.10_

  - [ ] 10.7 Write unit tests in `state/selectors.spec.ts`
    - Examples: nine services show eight Rooms, bad status becomes `unknown` for one Room only, dashes for missing metrics, no wording that states a root cause as fact, caveat shown for a `down` kind, empty incident lists.
    - _Requirements: 2.7, 2.9, 2.12, 4.6, 4.12, 4.13, 11.10, 15.1_

  - [ ] 10.8 Write property test for Room mapping
    - **Property 4: Rooms map one to one onto services, capped at eight**
    - File: `state/selectors.rooms.prop.spec.ts`
    - **Validates: Requirements 2.1, 2.2, 2.12, 11.9, 11.10**

  - [ ] 10.9 Write property test for lost contact and blindness
    - **Property 5: Lost contact and blind snapshots make every Room unknown**
    - File: `state/selectors.unknown.prop.spec.ts`
    - **Validates: Requirements 1.7, 2.8**

  - [ ] 10.10 Write property test for metric formatting
    - **Property 6: Metrics format with a dash for missing values**
    - File: `state/format.prop.spec.ts`
    - **Validates: Requirements 2.7**

  - [ ] 10.11 Write property test for anomaly views
    - **Property 8: Anomaly effects follow the engine's confirmed set**
    - File: `state/selectors.anomalies.prop.spec.ts`
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.12**

  - [ ] 10.12 Write property test for incident rows
    - **Property 12: Incident rows are ordered, worded and flagged correctly**
    - File: `state/selectors.incidents.prop.spec.ts`
    - **Validates: Requirements 4.5, 4.7, 4.9, 4.10, 4.11, 4.12, 4.13, 4.14, 4.17**

  - [ ] 10.13 Write property test for open durations
    - **Property 13: Open durations freeze at lost contact**
    - File: `state/selectors.duration.prop.spec.ts`
    - **Validates: Requirements 4.8, 4.15**

- [ ] 11. Ghost message builder
  - [ ] 11.1 Create `state/ghost-messages.ts`
    - `GhostSourceEvent`, `GhostMessage` (with `source` allowing `'narrator'`), pure `buildGhostMessage(event, at)` returning `null` on a missing or non-finite field, and `ghostReducer` (prepend, dedupe by `id`, cap at `GHOST_MESSAGE_LIMIT`). Wording per design.md: incident opened uses "suspect"/"may", adds "seen this pattern before" for recurrence or similar, and the rounded similarity percentage; forecast uses "~N s (estimate)"; every number comes from the payload.
    - _Requirements: 3.9, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 5.13, 5.14, 5.15_

  - [ ] 11.2 Write unit tests in `state/ghost-messages.spec.ts`
    - One exact-text example per event type, incomplete payload gives `null`, 51st message drops the oldest.
    - _Requirements: 5.2, 5.3, 5.7, 5.15, 15.1_

  - [ ] 11.3 Write property test for the ghost list
    - **Property 14: Ghost list is bounded and newest first**
    - File: `state/ghost-messages.list.prop.spec.ts`
    - **Validates: Requirements 5.1, 5.2**

  - [ ] 11.4 Write property test for message content
    - **Property 15: Ghost messages carry the required content**
    - File: `state/ghost-messages.content.prop.spec.ts`
    - **Validates: Requirements 3.9, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.14**

  - [ ] 11.5 Write property test for number provenance
    - **Property 16: Every number in a ghost message comes from its event**
    - File: `state/ghost-messages.numbers.prop.spec.ts`
    - **Validates: Requirements 5.10**

  - [ ] 11.6 Write property test for determinism and purity
    - **Property 17: Ghost builder is deterministic and pure**
    - File: `state/ghost-messages.pure.prop.spec.ts`
    - **Validates: Requirements 5.11**

  - [ ] 11.7 Write property test for incomplete events
    - **Property 18: Incomplete events produce no message**
    - File: `state/ghost-messages.incomplete.prop.spec.ts`
    - **Validates: Requirements 5.15**

- [ ] 12. Chaos client and chaos UI state
  - [ ] 12.1 Create `lib/chaos-client.ts`
    - `CHAOS_PRESETS`, `sendChaos`, `sendResetAll`, `parseRetryAfter` (must match `/^\d+$/` and be 1 to 3600, else `null`), `classifyStatus`. URLs are always `${engineUrl}/api/chaos/${service}/${path}` and `/api/chaos/reset-all`; JSON body only for latency, errors and memory leak; `AbortController` abort after `CHAOS_REQUEST_TIMEOUT_MS` maps to `engine-unreachable`; 429 gives `{ waitSeconds, waitKnown }` with the 10 s default when the header is invalid; never retries.
    - _Requirements: 8.2, 8.3, 8.4, 8.7, 8.8, 8.9, 8.10, 8.11, 8.14, 8.15, 10.1, 10.2, 10.7_

  - [ ] 12.2 Write unit tests in `lib/chaos-client.spec.ts`
    - Fake `fetch`: 429 with `Retry-After: 37` gives 37 and `waitKnown`; 429 without the header gives the 10 s default; a never-resolving request aborts after 5000 ms with fake timers; crash carries no body and no content-type; one request only, no retry; 4xx message list joined with ", "; reset-all failure names no service.
    - _Requirements: 8.2, 8.3, 8.7, 8.11, 8.15, 10.1, 10.2, 10.7, 15.1, 15.2_

  - [ ] 12.3 Write property test for request shape
    - **Property 28: Chaos requests go only to the proxy with the right shape**
    - File: `lib/chaos-client.request.prop.spec.ts`
    - **Validates: Requirements 8.2, 8.3, 8.4**

  - [ ] 12.4 Write property test for status mapping
    - **Property 29: Every response status maps to exactly one outcome**
    - File: `lib/chaos-client.status.prop.spec.ts`
    - **Validates: Requirements 8.6, 8.7, 8.8, 8.9**

  - [ ] 12.5 Write property test for Retry-After parsing
    - **Property 30: Retry-After parsing**
    - File: `lib/chaos-client.retry-after.prop.spec.ts`
    - **Validates: Requirements 10.1, 10.2**

  - [ ] 12.6 Create `state/chaos-ui.ts` with unit tests
    - `chaosUiReducer`, `isServiceDisabled`, `isResetAllDisabled`, `rateLimitRemainingSeconds`. Sent sets in-flight and cooldown; completed sets a result visible for `RESULT_VISIBLE_MS`; a `rate-limited` outcome sets a global lock and a newer 429 replaces it. Unit tests: lock expiry re-enables, countdown seconds, result expiry, disabled while not `connected`.
    - _Requirements: 8.5, 8.12, 8.16, 10.3, 10.4, 10.5, 10.6_

  - [ ] 12.7 Write property test for control gating
    - **Property 31: Control gating follows connection, cooldown, in-flight and rate limit**
    - File: `state/chaos-ui.prop.spec.ts`
    - **Validates: Requirements 1.8, 8.5, 8.12, 8.16, 10.3, 10.4, 10.5, 10.6**

- [ ] 13. Socket client and snapshot fetch
  - [ ] 13.1 Create `lib/socket-client.ts` and `lib/engine-api.ts`
    - `createEngineConnection(url, factory, sink)` subscribes to the ten `ServerToClientEvents`, validates each payload, returns a disconnect function. Default factory: `io(url, { transports: ['websocket','polling'], reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 10000, randomizationFactor: 0, timeout: 5000 })` typed with `ServerToClientEvents` and `ClientToServerEvents`. `fetchSnapshot` does one `GET /api/snapshot`; 503 returns `null` silently, other failures log one warning.
    - _Requirements: 1.1, 1.3, 1.5, 1.9, 1.10, 1.11_

  - [ ] 13.2 Write unit tests in `lib/socket-client.spec.ts` and `lib/engine-api.spec.ts`
    - Fake emitter socket: subscribes to all ten events, maps `connect`, `connect_error` and `disconnect`, invalid payload warns once and is dropped, default factory options as listed; snapshot fetch 200, 503 (no warning), network error (one warning), called exactly once.
    - _Requirements: 1.3, 1.4, 1.5, 1.9, 1.10, 1.11, 15.1_

- [ ] 14. Audio mapping (pure)
  - [ ] 14.1 Create `audio/types.ts` and `audio/mapping.ts`
    - `AudioInput`, `AudioMapping`, `AudioCues`, `mapAudio`, `nextSilenceUntil`, `deriveCues` with the rules in design.md: unavailable, lost contact (tone only), blind (fixed ambient), live (ambient from Dread, whispers from latency badness of eligible services, screams from error badness, heartbeat from memory badness or active forecasts), silence zeroing, final `finite01` sanitising and bpm clamping. No Tone.js, React or clock reads.
    - _Requirements: 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.12, 6.13, 6.14, 6.15, 6.16, 7.1, 7.2, 7.3, 7.4, 7.5, 7.7, 7.8_

  - [ ] 14.2 Write unit tests in `audio/mapping.spec.ts`
    - Examples per state (unavailable, lost contact, blind, live, silence active and expired), empty service list, heartbeat off with no trigger, heartbeat bpm bounds, whisper and scream rooms tie to the first in order, a deep-frozen input.
    - _Requirements: 6.7, 6.8, 6.9, 6.11, 6.12, 6.13, 6.15, 15.1_

  - [ ] 14.3 Write property test for ranges
    - **Property 19: Audio output is always finite and in range**
    - File: `audio/mapping.range.prop.spec.ts`
    - **Validates: Requirements 6.10, 6.14**

  - [ ] 14.4 Write property test for ambient monotonicity
    - **Property 20: Ambient intensity is monotonic in Dread**
    - File: `audio/mapping.ambient.prop.spec.ts`
    - **Validates: Requirements 6.6**

  - [ ] 14.5 Write property test for whispers
    - **Property 21: Whispers are monotonic in the highest latency badness**
    - File: `audio/mapping.whispers.prop.spec.ts`
    - **Validates: Requirements 6.7**

  - [ ] 14.6 Write property test for screams
    - **Property 22: Screams are monotonic in the highest error badness**
    - File: `audio/mapping.screams.prop.spec.ts`
    - **Validates: Requirements 6.8**

  - [ ] 14.7 Write property test for the heartbeat
    - **Property 23: Heartbeat never slows as memory trouble grows**
    - File: `audio/mapping.heartbeat.prop.spec.ts`
    - **Validates: Requirements 6.9**

  - [ ] 14.8 Write property test for determinism and immutability
    - **Property 24: Audio mapping is deterministic and does not mutate its input**
    - File: `audio/mapping.pure.prop.spec.ts`
    - **Validates: Requirements 6.15**

  - [ ] 14.9 Write property test for overrides
    - **Property 25: Lost contact, blindness and silence override the layers**
    - File: `audio/mapping.overrides.prop.spec.ts`
    - **Validates: Requirements 1.8, 6.11, 6.12, 6.13**

  - [ ] 14.10 Write property test for the silence trigger
    - **Property 26: Silence is triggered by newly down services, restarts and respects page visibility**
    - File: `state/cluster-state.silence.prop.spec.ts`
    - **Validates: Requirements 6.11, 6.19**

  - [ ] 14.11 Write property test for cues
    - **Property 27: Cues are a function of the mapping output alone**
    - File: `audio/mapping.cues.prop.spec.ts`
    - **Validates: Requirements 6.11, 7.1, 7.2, 7.3, 7.4, 7.5, 7.7, 7.8**

- [ ] 15. Checkpoint B - Frontend pure logic: tests green and real boot
  - In `haunted-house/` run `npm ci`, `npm run typecheck`, `npm test`; all exit 0 (Jest via `next/jest` does not type-check, so `typecheck` is part of the gate).
  - `NEXT_PUBLIC_ENGINE_URL=http://localhost:4000 npm run build` exits 0. Then `NEXT_PUBLIC_ENGINE_URL=http://localhost:4000 npm run start` in a separate terminal and `curl -fsS -m 10 -o /dev/null -w '%{http_code}\n' http://localhost:3100/` returns 200.
  - `npm run build` with `NEXT_PUBLIC_ENGINE_URL` unset exits non-zero, names the variable and leaves no `.next` output. Break `shared/dist` on purpose (rename `index.d.ts`) and confirm the build stops naming the missing file, then restore it.
  - Stop the server. Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 1.2, 13.3, 13.8, 14.1, 14.9, 15.8, 15.13_

- [ ] 16. Design tokens, fonts and global styles
  - [ ] 16.1 Create `design/tokens.ts`, `design/tokens-css.ts` and `design/contrast.ts`
    - Every token from design.md once, with a light and a dark value, covering the five Room statuses, three anomaly signals, five Audio_Layer cues plus silence and lost contact, `focus` and `focus-inverse`, and decorative scene tokens. `tokensToCss()` emits `:root` plus `@media (prefers-color-scheme: dark)`. `contrastRatio()` implements the WCAG formula.
    - _Requirements: 11.4, 11.5, 12.2, 12.5, 12.6_

  - [ ] 16.2 Write tests in `design/tokens.spec.ts`
    - Contrast of every text token against its background in both themes for every Room_Status is at least 4.5; `focus` against each non-`down` background and `focus-inverse` against `room-down-bg` at least 3 in both themes; every token has a light and a dark value; `tokensToCss()` contains both blocks.
    - _Requirements: 11.6, 11.7, 12.5, 12.7, 12.8_

  - [ ] 16.3 Add fonts, `app/layout.tsx` and `app/globals.css`
    - Commit Creepster (heading) and Inter (body) `woff2` files with the SIL OFL licence text in `app/fonts/` and load them with `next/font/local` (`display: 'swap'`, fallback stacks ending in `serif` and `sans-serif`). Inject `tokensToCss()` as a `<style>`. `globals.css` holds layout rules only (no colour literals), `:focus-visible` using the `--focus` token, and `@media (prefers-reduced-motion: reduce)` rules that disable animation and transition. Set `<html lang>`.
    - _Requirements: 2.11, 11.7, 12.3, 12.4, 12.10_

- [ ] 17. Hooks
  - [ ] 17.1 Create `hooks/useDeadlineClock.ts`, `useReducedMotion.ts`, `usePageVisible.ts`
    - `useDeadlineClock(deadlines)` sets one timeout for the nearest future deadline (cooldown end, result expiry, rate-limit end, silence end) and a 1 s interval only while a known-wait countdown or an open incident is visible. `useReducedMotion` reads `matchMedia`; `usePageVisible` reads `document.visibilityState`.
    - _Requirements: 2.11, 4.8, 6.19, 7.5, 10.4, 10.5_

  - [ ] 17.2 Create `hooks/useClusterStore.ts`
    - Wires `createEngineConnection`, one `fetchSnapshot` at load, `validate` parsers, `clusterReducer` and the ghost list (`buildGhostMessage` then `ghostReducer`, kept outside `ClusterState`). Dispatches `atMs` and `pageVisible` from the hook. `console.warn` for dropped payloads at most once per event name per second. Unsubscribes on unmount.
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.9, 1.10, 1.11, 5.1, 5.15_

- [ ] 18. Haunted scene, Rooms and badges
  - [ ] 18.1 Create `components/HouseScene.tsx` and `components/RoomFacade.tsx`
    - Inline SVG scene (`scene-sky`, `scene-roof` with chimney, `scene-wall` pattern, `scene-fog`, `scene-ground`, decorative `scene-bats` shown when `--flicker` > 0.5), atmosphere applied as `--darkness`, `--flicker`, `--fog`. `RoomFacade` draws a distinct window per status (lit, cracked, boarded, dark with crossed frame and no animation, fogged with a dotted pattern and "?"). All fills use `var(--token)`. Under reduced motion fog, bats and flicker are static.
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 2.10, 2.11, 12.1, 12.9, 12.10_

  - [ ] 18.2 Create `components/RoomView.tsx`, `AnomalyBadge.tsx`, `ForecastBadge.tsx`, `ChaosMark.tsx`
    - One Room: service name, status as visible text, score, latency, error rate, RSS and request rate (dashes for missing), `data-status` and `data-dark` attributes, anomaly badges with signal, value and method and an `aria-label`, forecast badge with the countdown text and `aria-label`, chaos mark naming the action for `CHAOS_MARK_VISIBLE_MS`, highlight for a suspected root, whispers and screams cue marks. Room grid uses `--room-count` and the `minmax(max(220px, calc(100% / var(--room-count) - 1px)), 1fr)` rule with `min-width: 0` and `overflow-wrap: anywhere`.
    - _Requirements: 2.1, 2.4, 2.5, 2.6, 2.7, 3.1, 3.5, 3.7, 3.8, 3.12, 4.17, 7.2, 7.3, 8.13, 11.3, 11.9_

  - [ ] 18.3 Create `components/ConnectionBanner.tsx` and `BlindNotice.tsx`
    - "lost contact" banner shown while `lost_contact`; "the ghost cannot see" notice for a blind snapshot; "waiting for the first poll" message with zero Rooms.
    - _Requirements: 1.7, 2.8, 2.9_

- [ ] 19. Incident panel and ghost area
  - [ ] 19.1 Create `components/IncidentPanel.tsx` and `IncidentRow.tsx`
    - Renders `selectIncidentRows`: "suspected root" label, affected services with kinds, incident kinds, status, duration (updated at least once per second while open, `durationMs / 1000` to one decimal with "s" when resolved), recurrence, similar incident with percentage, restart caveat text "attribution may be wrong after a restart", related chaos line, "no incidents" message, a "possibly out of date" marker while lost contact.
    - _Requirements: 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 4.12, 4.13, 4.14, 4.15, 4.16_

  - [ ] 19.2 Create `components/GhostArea.tsx`
    - Newest-first list in a region with `aria-live="polite"`, reading from one message list so a later narrator can append with `source: 'narrator'` without a layout change.
    - _Requirements: 5.1, 5.12, 5.13_

- [ ] 20. Possess controls
  - [ ] 20.1 Create `hooks/useChaosControls.ts` and `components/PossessControls.tsx`, `ResetAllControl.tsx`, `ActionResult.tsx`
    - Five native buttons per Room with visible text (latency, errors, memory leak, crash, reset) and a "Reset all" control; wired to `sendChaos`, `sendResetAll`, `chaosUiReducer` and `useDeadlineClock`. In-progress indicator, result region with a polite live region for `RESULT_VISIBLE_MS`, friendly "the ghost needs rest" message with the remaining seconds when known, per-service reset-all results from the latest snapshot, all buttons disabled unless `connected`. Controls inside a `down` Room use `focus-inverse`. No retry on 429.
    - _Requirements: 1.8, 8.1, 8.2, 8.3, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10, 8.12, 8.14, 8.15, 8.16, 8.17, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 11.7, 11.8_

- [ ] 21. Audio engine and cues
  - [ ] 21.1 Create `audio/audio-engine.ts`
    - The only file that imports `tone`, via `import('tone')` inside `start()` (so nothing loads before the gesture). Layer graph (ambient, whispers, screams, heartbeat loop, lost-contact tone) through per-layer gains, a master gain and a limiter. Every gain change is `rampTo` with at least 0.1 s (`AUDIO_RAMP_MS`); `setMuted` ramps master gain; `apply(output)` keeps levels consistent while hidden and ignores `silence` while the page is hidden; `dispose()`.
    - _Requirements: 6.1, 6.2, 6.4, 6.16, 6.17, 6.18, 6.19_

  - [ ] 21.2 Write unit tests in `audio/audio-engine.spec.ts`
    - With a fake Tone module: zero loads and zero contexts before `start()`; `start()` builds the graph; every recorded gain change is a ramp of at least 0.1 s; mute ramps to 0 within 0.3 s and back; a rejecting `start()` surfaces an error and allows retry; `silence` ignored while hidden.
    - _Requirements: 6.1, 6.2, 6.4, 6.17, 6.18, 6.19_

  - [ ] 21.3 Create `hooks/useAudio.ts`
    - Holds the engine, enabled, muted and unavailable state; `start` runs only from the "enable sound" click handler; re-applies the current mapping on `visibilitychange` to visible.
    - _Requirements: 6.1, 6.2, 6.4, 6.18, 6.19_

  - [ ] 21.4 Create `components/SoundControls.tsx` and `components/AudioCues.tsx`
    - "enable sound" button with a "sound off" text indicator, Mute button (`aria-pressed`, Enter and Space), muted indicator as text, "sound unavailable" text with retry. `AudioCues` renders `deriveCues(output)` (ambient intensity quantised to 0.05, whispers and screams on their Rooms, heartbeat pulse at `bpm` or a static dot with bpm text under reduced motion, silence cue, lost-contact cue, a single "sound data unavailable" indicator otherwise); cues render whether sound is off, enabled or muted.
    - _Requirements: 6.3, 6.4, 6.5, 6.18, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.8, 7.9, 11.7, 11.8_

- [ ] 22. Page assembly
  - [ ] 22.1 Create `components/HauntedHouse.tsx`
    - Client root with injectable `engineUrl`, `socketFactory`, `fetchImpl` and clock. Calls `mapAudio` once in a `useMemo` and passes the same object to `useAudio` and `deriveCues` (one source for sound and picture). Renders banner, scene, Rooms, incident panel, ghost area, sound controls, reset-all.
    - _Requirements: 1.3, 7.6, 7.7, 11.2, 11.3_

  - [ ] 22.2 Update `app/page.tsx` and create `app/api/health/route.ts`
    - Page renders `<HauntedHouse engineUrl={ENGINE_URL} />`. `GET /api/health` answers 200 with `{ "status": "ok", "service": "haunted-house" }` without contacting the Engine. Test (`@jest-environment node`): the handler returns that body with no network access.
    - _Requirements: 14.1, 14.5_

  - [ ] 22.3 Finish responsive layout in `app/globals.css`
    - Single column below 768 px, side-by-side Rooms from 768 px that wrap in service-chain order, incident panel and ghost area beside the scene above 1200 px and under it below, no horizontal scrolling from 320 px to 1920 px, wrapping button groups, no fixed text widths.
    - _Requirements: 11.1, 11.2, 11.3, 11.9, 11.10, 12.4, 12.11_

- [ ] 23. UI tests
  - [ ] 23.1 Write the full-page test `components/HauntedHouse.spec.tsx`
    - Render with a fake emitter socket and fake `fetch`: (a) a snapshot with three services and exactly one `down` shows that Room `data-dark="true"` and the others `data-dark="false"`; (b) a blind snapshot shows every Room `data-status="unknown"` and the "the ghost cannot see" notice; no snapshot shows "waiting for the first poll" and zero Rooms.
    - _Requirements: 2.5, 2.8, 2.9, 15.7_

  - [ ] 23.2 Write component tests for the remaining behaviour
    - In `components/*.spec.tsx`: lost contact shows the banner, disables every button, shows only the lost-contact cue, and reconnect clears the banner and keeps recent incidents; incident rows show the caveat and "suspected root"; the ghost area is `aria-live="polite"`; each Room has five labelled buttons; a 429 disables every button and counts down, then re-enables; the "enable sound" control is the only thing that starts audio (fake Tone loaded 0 times before the click); every control has a non-empty accessible name and is keyboard operable.
    - _Requirements: 1.6, 1.7, 1.8, 4.12, 4.13, 4.15, 5.12, 6.1, 6.3, 8.1, 8.16, 8.17, 10.3, 10.5, 11.7, 11.8_

- [ ] 24. Checkpoint C - UI: tests green and real boot
  - In `haunted-house/` run `npm run typecheck` and `npm test`; both exit 0.
  - Build and start: `NEXT_PUBLIC_ENGINE_URL=http://localhost:4000 npm run build`, then `NEXT_PUBLIC_ENGINE_URL=http://localhost:4000 npm run start` in a separate terminal.
  - `curl -fsS -m 10 http://localhost:3100/api/health` returns `{"status":"ok","service":"haunted-house"}` and `curl -fsS -m 10 -o /dev/null -w '%{http_code}\n' http://localhost:3100/` returns 200, both within 10 seconds of the server reporting ready.
  - With the engine stopped, open the page and confirm the "lost contact" banner, disabled buttons and no layout break at 320 px, 768 px, 1200 px and 1920 px in light and dark themes (manual look).
  - Stop the server. Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 11.1, 14.5, 15.8, 15.13_

- [ ] 25. Docker, compose and environment files
  - [ ] 25.1 Create `haunted-house/Dockerfile`
    - Two-stage build with the repo root as context (needs `shared/`): builder runs `npm ci`, copies `shared/` and `haunted-house/`, takes `ARG NEXT_PUBLIC_ENGINE_URL` (comment: fixed at build time), runs `npm run build` then `npm prune --omit=dev`; runtime image copies `.next`, `node_modules`, `package.json`, `next.config.mjs` and `lib/engine-url.mjs`, sets the same `ARG` and `ENV`, exposes 3100 and runs `npm run start` (not `standalone`, so the start-time check still runs). With no build arg the build fails at `parseEngineUrl`.
    - _Requirements: 14.1, 14.3, 14.9, 14.10_

  - [ ] 25.2 Fix the root `.dockerignore`
    - Remove the `haunted-house` line so the frontend context is not empty and add `**/.next`; keep `**/node_modules` ignored. Confirm the engine and victim-app images still build (their Dockerfiles copy only named folders).
    - _Requirements: 14.3_

  - [ ] 25.3 Add the `haunted-house` service to `docker-compose.yml`
    - Build context `.`, `dockerfile: haunted-house/Dockerfile`, build arg `NEXT_PUBLIC_ENGINE_URL: ${NEXT_PUBLIC_ENGINE_URL:-http://localhost:4000}` with the comment that changing it requires `docker compose build haunted-house`, port `3100:3100`, `restart: unless-stopped`, `depends_on` engine with `condition: service_healthy`, healthcheck `["CMD","wget","-qO-","http://127.0.0.1:3100/api/health"]` with `interval: 10s`, `timeout: 5s`, `retries: 5` (and a `start_period`).
    - _Requirements: 14.4, 14.6, 14.13_

  - [ ] 25.4 Create `haunted-house/.env.example`
    - `NEXT_PUBLIC_ENGINE_URL=http://localhost:4000` with the comment that it is fixed at build time (inlined into the browser bundle, rebuild to change), plus every other variable the frontend reads, each with a documented value and a one-line description.
    - _Requirements: 14.2, 14.12_

  - [ ] 25.5 Extend `haunting-engine/src/config/env-files.spec.ts` for the frontend files
    - Assert the `haunted-house` compose service (build arg and default, port, `depends_on`, healthcheck values 10s, 5s, 5, comments) and `haunted-house/.env.example` contents.
    - _Requirements: 14.2, 14.4, 14.12, 14.13_

  - [ ] 25.6 Create `haunted-house/scripts/probe-snapshot.mjs`
    - Connects with `socket.io-client` to the URL given as argument, exits 0 on the first `cluster:snapshot` within 30 seconds, otherwise exits non-zero with a message.
    - _Requirements: 15.10_

- [ ] 26. Checkpoint D - Images build and boot
  - From the repository root run `docker compose build haunted-house haunting-engine`; both exit 0, and `docker compose build haunted-house --build-arg NEXT_PUBLIC_ENGINE_URL=` (empty) fails naming `NEXT_PUBLIC_ENGINE_URL`.
  - `docker compose up -d --build --wait --wait-timeout 120` reports every service running or healthy, then `curl -fsS http://localhost:3100/api/health` returns 200. Run `docker compose down` after.
  - In `haunting-engine/` run `npm test` once more (compose and env-file specs); exit 0. Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 14.3, 14.4, 14.6, 15.10, 15.13_

- [ ] 27. Full-stack verification
  - [ ] 27.1 Run the full stack and probe the Engine stream
    - `docker compose up -d --build --wait --wait-timeout 120`; `curl -fsS http://localhost:3100/api/health` returns 200; `node haunted-house/scripts/probe-snapshot.mjs http://localhost:4000` exits 0 within 30 seconds. Open `http://localhost:3100`, confirm three Rooms appear, then trigger each Possess action once (latency, errors, memory leak, crash, reset, reset all) and confirm the Room, incident, ghost and cue reactions. Hit the rate limit on purpose and confirm the friendly message and countdown. Always finish with reset all.
    - _Requirements: 8.2, 10.1, 14.6, 15.10_

  - [ ] 27.2 Run the dependency audit
    - In `haunted-house/` run `npm audit --omit=dev`; it must report no high or critical findings. If it does, first move to a newer 14.2.x Next patch, then to a patched version of the affected package; never silence the check.
    - _Requirements: 13.9, 15.8_

  - [ ] 27.3 Manual sound check in Chrome, Firefox and Safari
    - In each browser: sound starts only after the "enable sound" click or key press (Safari must start on the first click), each Audio_Layer is heard (ambient, whispers, screams, heartbeat, and the lost-contact tone by stopping the engine), Mute silences within 300 ms and restores, and switching tabs and back plays no stale silence. Append an entry recording the browser versions to the existing `NOTES.md` at the repository root.
    - _Requirements: 6.2, 6.4, 6.19, 15.12_

  - [ ] 27.4 Add the Client_Key deployment-check note
    - Add a "Deployment check: Client_Key" section to `README.md`, or append it as an entry to the existing `NOTES.md` at the repository root, with the three steps from design.md for `TRUST_PROXY=true` behind a Cloudflare Tunnel: a known client is limited by its own address (5 accepted then 429 with `Retry-After`); a second network is not limited at the same time; a spoofed `X-Forwarded-For` from the limited network is still 429. Include the temporary `Logger.debug` of `req.ip` and its removal, and the fallback to `TRUST_PROXY=false`. This task only writes the note; the check is run once on the live deployment, outside this plan.
    - _Requirements: 14.14_

- [ ] 28. Checkpoint E - Full verification complete
  - Confirm tasks 27.1 to 27.3 passed (stack up, health 200 on port 3100, probe received a snapshot, audit clean, sound check recorded) and run `npm test` in `haunting-engine/` and `haunted-house/` one last time.
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 15.8, 15.9, 15.10, 15.12, 15.13_

- [ ] 29. Docs and steering
  - [ ] 29.1 Update `.kiro/steering/roadmap.md` and `.kiro/steering/structure.md`
    - Move `haunted-house` to Done, make `ghost-narrator` the next phase, keep the "Known open issues" entries, and change the `haunted-house/` line in structure.md from "Not started" to complete with its main folders.
    - _Requirements: 13.1_

  - [ ] 29.2 Update `README.md`
    - Add the frontend to the run instructions (`docker compose up`, house on port 3100, `NEXT_PUBLIC_ENGINE_URL` fixed at build time, `CORS_ORIGIN`, rate-limit variables) and the "Possess it" rate-limit behaviour.
    - _Requirements: 14.2, 14.6_

  - [ ] 29.3 Append a `NOTES.md` entry (repository root)
    - Record what shipped, the measured results (test counts, audit result, browser versions from 27.3) and any deviations or issues found. Append this entry to the existing `NOTES.md` at the repository root.
    - _Requirements: 15.13_

## Notes

- All property tests are required, not optional: Requirements 15.3 and 15.4 require them. Unit tests for core logic are required too.
- Each app milestone ends with a real boot, per the steering lessons and Requirement 15.
- Tasks 27.1 to 27.3 are manual verification runs, as in earlier plans; 27.4 writes a note only and the Cloudflare check happens at deployment time.
- Design property numbers P1 to P37 map one to one to the property test tasks above.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "4.1"] },
    { "id": 3, "tasks": ["2.4", "2.5", "3.1", "3.2"] },
    { "id": 4, "tasks": ["3.3", "4.2"] },
    { "id": 5, "tasks": ["5.1", "6.1", "6.2", "6.3", "6.4"] },
    { "id": 6, "tasks": ["5.2"] },
    { "id": 7, "tasks": ["8.1"] },
    { "id": 8, "tasks": ["8.2", "8.3", "8.4"] },
    { "id": 9, "tasks": ["8.5", "9.1", "9.2", "10.1", "10.4", "12.1", "13.1"] },
    { "id": 10, "tasks": ["9.3", "9.4", "10.2", "10.3", "10.5", "11.1", "12.2", "12.3", "12.4", "12.5", "12.6", "13.2"] },
    { "id": 11, "tasks": ["9.5", "9.6", "9.7", "9.8", "10.6", "11.2", "11.3", "11.4", "11.5", "11.6", "11.7", "12.7", "14.1"] },
    { "id": 12, "tasks": ["10.7", "10.8", "10.9", "10.10", "10.11", "10.12", "10.13", "14.2", "14.3", "14.4", "14.5", "14.6", "14.7", "14.8", "14.9", "14.10", "14.11"] },
    { "id": 13, "tasks": ["16.1"] },
    { "id": 14, "tasks": ["16.2", "16.3", "17.1"] },
    { "id": 15, "tasks": ["17.2", "18.1", "21.1"] },
    { "id": 16, "tasks": ["18.2", "18.3", "19.1", "19.2", "20.1", "21.2", "21.3"] },
    { "id": 17, "tasks": ["21.4"] },
    { "id": 18, "tasks": ["22.1"] },
    { "id": 19, "tasks": ["22.2", "22.3"] },
    { "id": 20, "tasks": ["23.1", "23.2"] },
    { "id": 21, "tasks": ["25.1", "25.2", "25.4", "25.6"] },
    { "id": 22, "tasks": ["25.3"] },
    { "id": 23, "tasks": ["25.5"] },
    { "id": 24, "tasks": ["27.1", "27.2", "27.3", "27.4"] },
    { "id": 25, "tasks": ["29.1", "29.2", "29.3"] }
  ]
}
```
