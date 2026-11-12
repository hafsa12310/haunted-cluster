# Implementation Plan: engine-intelligence

## Overview

Add the learned layer to the haunting-engine: shared types first, then the victim-app leak fix, then configuration, then the pure functions (anomaly, forecast, similarity), then the pipeline step, poller wiring, victim-app fix and integration tests. Everything new is a pure function plugged into the existing `PollerService` pipeline. Property tests use fast-check with at least 100 runs and carry the tag `// Feature: engine-intelligence, Property <N>: <text>`. Each app milestone ends with a real boot (build, start, hit `/health`), not just a green test run.

Tasks 1 and 3 to 6 cover shared types, configuration and the pure functions, and task 2 fixes the victim-app leak so RSS really grows. Tasks 7 to 14 cover the pipeline step, poller wiring, victim-app changes, compose, the integration test and the final checkpoint.

## Tasks

- [x] 1. Add shared intelligence types
  - [x] 1.1 Create `shared/src/intelligence.ts`
    - Define `MonitoredSignal` (`'latencyP95Ms' | 'errorRatio' | 'rssMb'`), `AnomalyMethod`, `AnomalyReading`, `ForecastClearReason` (`'stopped-rising' | 'memory-dropped'`), `MemoryForecast`, `SimilarIncident`, `AnomalyClearedPayload` and `ForecastClearedPayload` exactly as in design.md "Shared types".
    - Only `interface` and `type` declarations: no enums, no `const`, no functions. Every field is a number, string, boolean or `null`, never `undefined`.
    - _Requirements: R10.1, R10.2, R10.5, R10.8_

  - [x] 1.2 Extend `ClusterSnapshot`, `Incident` and `ServerToClientEvents`
    - In `shared/src/service-health.ts` add `anomalies: AnomalyReading[]` and `forecasts: MemoryForecast[]` to `ClusterSnapshot`.
    - In `shared/src/incident.ts` add `similar: SimilarIncident | null` to `Incident`.
    - In `shared/src/events.ts` add `'anomaly:detected'`, `'anomaly:cleared'`, `'forecast:warning'` and `'forecast:cleared'` to `ServerToClientEvents` with the payloads from the design.
    - _Requirements: R10.3, R10.4, R10.5_

  - [x] 1.3 Re-export from `shared/src/index.ts` and rebuild `shared/dist`
    - Add `export type * from './intelligence';` to `shared/src/index.ts`.
    - Run `npm run build:shared` from `haunting-engine/`; confirm `shared/dist/` contains only `.d.ts` files and zero `.js` files (for example `find shared/dist -name '*.js'` returns nothing).
    - Existing code that builds a `ClusterSnapshot` or `Incident` literal (poller, incident tracker `openIncident`, and specs under `engine/`, `incidents/` and `test/`) will not compile until it supplies the new fields. Fix each so the engine compiles: `anomalies: []`, `forecasts: []` and `similar: null` for now. Do not change any decision logic.
    - Write a throwaway file in `haunting-engine/src/` that imports every new type from `@haunted-cluster/shared`, run `tsc --noEmit`, then delete it.
    - _Requirements: R10.6, R10.7_

- [x] 2. Fix the victim-app memory leak and verify RSS growth
  - [x] 2.1 Allocate real memory per leak unit in `libs/chaos/src/chaos.service.ts`
    - In `enableMemoryLeak()` push `Buffer.alloc(ONE_MB_BYTES, 1)` with `ONE_MB_BYTES = 1024 * 1024` instead of the string. The array stays `unknown[]`, so length, `reset()`, TTL expiry and `getState()` are unchanged. The code default for `LEAK_MB_PER_SECOND` stays `'5'`.
    - _Requirements: R15.8, R15.9, R15.10_

  - [x] 2.2 Extend `libs/chaos/src/chaos.service.spec.ts`
    - Each leak entry is a `Buffer` of `1_048_576` bytes. A test with real timers enables the leak for about 3 ticks and asserts `process.memoryUsage().rss` grew by at least half of the nominal amount. Existing length-based tests keep passing. Reset the leak in `afterEach`.
    - _Requirements: R15.8, R15.10_

  - [x] 2.3 Set the leak rate in `docker-compose.yml`
    - For each of `gateway`, `orders` and `payments` replace `LEAK_MB_PER_SECOND: 5` with `LEAK_MB_PER_SECOND: ${LEAK_MB_PER_SECOND:-2}`. Change nothing else in the file here.
    - _Requirements: R15.1_

  - [x] 2.4 Manual check of RSS growth on the running stack
    - Rebuild and start the stack with `docker compose up --build -d`, and wait until every container is healthy.
    - Enable the payments leak through the engine's chaos proxy only: `POST /api/chaos/payments/memory-leak` on the haunting-engine with body `{ "enabled": true }` (route from `haunting-engine/src/chaos-proxy/chaos-proxy.controller.ts`). Never call the victim-app `/chaos/*` endpoints directly.
    - For about 20 seconds sample payments RSS about every 2 seconds, from `GET /api/snapshot` on the engine or from Prometheus (`process_rss_bytes` for payments). Confirm RSS rises at roughly 2 MB/s (fit the slope over the samples).
    - Always finish with `POST /api/chaos/reset-all`, even if the check fails.
    - Record the observed rate, the measurement method (snapshot or Prometheus) and the date and time in `.kiro/specs/engine-intelligence/design.md` under "F1" in "Findings that change the plan".
    - If the observed rate is far from 2 MB/s, stop and ask the user before continuing.
    - _Requirements: R15.1, R15.8, R15.10_

- [x] 3. Extend engine configuration
  - [x] 3.1 Add the config slices and variables in `haunting-engine/src/config/engine-config.ts`
    - Export `AnomalyConfig`, `ForecastConfig` and `SimilarityConfig` as in design.md "Configuration slices", and add `memoryLimitMb`, `anomaly`, `forecast` and `similarity` to `EngineConfig`. `MonitoredSignal` is imported from `@haunted-cluster/shared`.
    - Read every variable in `loadEngineConfig` only, with these defaults: `ANOMALY_ALPHA` 0.1, `ANOMALY_Z_THRESHOLD` 3, `ANOMALY_WARMUP_POLLS` 30, `ANOMALY_CONFIRM_POLLS` 2, `ANOMALY_RELEARN_POLLS` 30, `ANOMALY_MIN_STDDEV_LATENCY_MS` 5, `ANOMALY_MIN_STDDEV_ERROR_RATIO` 0.005, `ANOMALY_MIN_STDDEV_RSS_MB` 2, `MEMORY_LIMIT_MB` 256, `FORECAST_WINDOW_POLLS` 15, `FORECAST_MIN_SAMPLES` 5, `FORECAST_MIN_R2` 0.8, `FORECAST_MIN_SLOPE_MB_PER_S` 0.05, `FORECAST_WARN_SECONDS` 60, `FORECAST_RESTART_DROP_MB` 20, `SIMILARITY_THRESHOLD` 0.85, `SIMILARITY_DURATION_CAP_SECONDS` 300. Unset or blank uses the default.
    - Per-variable validation: `ANOMALY_ALPHA` finite in (0, 1]; `FORECAST_MIN_R2` and `SIMILARITY_THRESHOLD` finite in [0, 1]; the six count variables (`ANOMALY_WARMUP_POLLS`, `ANOMALY_CONFIRM_POLLS`, `ANOMALY_RELEARN_POLLS`, `FORECAST_WINDOW_POLLS`, `FORECAST_MIN_SAMPLES`, `SIMILARITY_DURATION_CAP_SECONDS`) positive integers; `ANOMALY_Z_THRESHOLD`, the three `ANOMALY_MIN_STDDEV_*`, `MEMORY_LIMIT_MB`, `FORECAST_MIN_SLOPE_MB_PER_S`, `FORECAST_WARN_SECONDS`, `FORECAST_RESTART_DROP_MB` finite and > 0.
    - Cross rules run only when both sides parsed: `FORECAST_MIN_SAMPLES` must be <= `FORECAST_WINDOW_POLLS` (names `FORECAST_MIN_SAMPLES`); `MEMORY_LIMIT_MB` must be > `memoryMb.critical` (names `MEMORY_LIMIT_MB`); `ANOMALY_RELEARN_POLLS` must be >= `ANOMALY_CONFIRM_POLLS` (names `ANOMALY_RELEARN_POLLS`).
    - Use a collecting reader (`readIssues`) that pushes `{ variable, message }` instead of throwing. If any issue exists, throw one `ConfigError` whose `message` joins every issue, whose `variable` is the first offender (existing callers keep working) and which gains `readonly variables: string[]` naming every offender. Existing parsing runs first, so a failure in an old variable still throws as before.
    - _Requirements: R11.1, R11.2, R11.3, R11.4, R11.5, R11.6, R11.7, R11.8, R11.9, R11.10, R11.13, R11.14_

  - [x] 3.2 Write unit tests in `haunting-engine/src/config/engine-config.spec.ts`
    - Defaults: with only the previously required variables set, every new key equals its default (one assertion per variable, including the three `minStdDev` entries).
    - Overrides: a valid value for each variable is used instead of the default.
    - Rejections, one test each, asserting the error names the variable: `ANOMALY_ALPHA` of 0, 1.5, `abc`; `FORECAST_MIN_R2` and `SIMILARITY_THRESHOLD` of -0.1 and 1.1; each count variable of 0, 2.5, `-1`; each > 0 variable of 0, -1, `NaN`, `Infinity`.
    - Cross rules: `FORECAST_MIN_SAMPLES` 10 with window 5; `MEMORY_LIMIT_MB` equal to and below `MEMORY_CRITICAL_MB`; `ANOMALY_RELEARN_POLLS` 1 with `ANOMALY_CONFIRM_POLLS` 2; equality is accepted for `RELEARN == CONFIRM` and `MIN_SAMPLES == WINDOW`.
    - Multiple offenders: set three invalid variables at once and assert `ConfigError.variables` contains all three and `message` names all three; assert `variable` is the first offender.
    - Existing config tests still pass unchanged.
    - _Requirements: R11.1, R11.2, R11.3, R11.4, R11.5, R11.6, R11.7, R11.8, R11.9, R11.10_

  - [x] 3.3 Update `haunting-engine/.env.example`
    - Add the block from design.md "Configuration variables" with a one-line description above each variable, plus `INTEGRATION_LEAK_TIMEOUT_SECONDS=300` and `INTEGRATION_MIN_LEAD_SECONDS=10` marked as test-only.
    - Pass the 17 engine variables through the `haunting-engine` service in the root `docker-compose.yml` as `${NAME:-default}` with the same defaults. Do not pass the two `INTEGRATION_*` variables.
    - _Requirements: R11.11, R11.12_

- [ ] 4. Checkpoint - Build, boot and test the engine
  - Run `npm run build` in `haunting-engine/`, start the engine with the default environment, `GET /health` and confirm it responds, then stop it. Run `npm test` in `haunting-engine/`.
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Implement the anomaly pure functions
  - [ ] 5.1 Create `haunting-engine/src/intelligence/intelligence-types.ts`
    - Define `PairObservation`-independent state types used across the layer: `PairTracking`, `TrackingMap`, `BaselineMap` (`Record<ServiceName, Record<MonitoredSignal, Baseline>>`), `RssSample`, `ServiceForecastState`, `IntelligenceState`, `IntelligenceEvent` as in design.md "Intelligence_State". Types only, no runtime code. Where the design places a type in a function file (`PairObservation`, `AnomalyEvent`, `TrackingContext`), define it there and re-export from here if needed, never twice.
    - _Requirements: R9.1, R9.4_

  - [ ] 5.2 Create `intelligence/anomaly/baseline.ts`
    - Export `Baseline`, `EMPTY_BASELINE`, `updateBaseline(b, sample, alpha)`, `resetBaseline(b)`, `isWarmUp(b, warmupPolls)` and `effectiveStdDev(b, floor)`.
    - Update rule: count 0 gives `{ mean: x, variance: 0, count: 1 }`; otherwise `mean' = m + α(x − m)`, `variance' = (1 − α)(v + α(x − m)²)`, `count' = count + 1`. Clamp variance at 0 from below. A `null`, `NaN`, infinite sample or a non-finite result returns the old Baseline. Never mutate the input; return new objects.
    - _Requirements: R1.1, R1.3, R1.4, R1.5, R1.6, R1.7, R1.8, R1.9_

  - [ ] 5.3 Write property tests in `intelligence/anomaly/baseline.prop.spec.ts`
    - **Property 2: Baseline update rule and invariants**
    - **Property 3: Non-finite samples change nothing**
    - **Property 4: Reset behaves like a fresh baseline**
    - **Validates: Requirements R1.3, R1.4, R1.5, R1.6, R1.7, R1.8, R1.9**

  - [ ] 5.4 Create `intelligence/anomaly/anomaly-detector.ts`
    - Export `zScore(value, baseline, floor)` (finite or `null`), `DetectionInput` and `detectAnomalies(input, config, chain)`.
    - Skip services with status `unknown`, `signals.up === false`, and non-finite or `null` values. In Warm_Up flag only when the matching badness is greater than `BREACH_BADNESS` (imported from `health/health-scoring`), method `fixed`, `zScore` null. After warm-up flag only when `x > mean` and `z > zThreshold`, method `learned`, regardless of fixed-threshold breaches.
    - `baselineStdDev` carries the floored standard deviation. Output order is chain order then `latencyP95Ms`, `errorRatio`, `rssMb`.
    - _Requirements: R3.1, R3.2, R3.3, R3.4, R3.5, R3.6, R3.7, R3.8, R3.9, R3.10, R3.12_

  - [ ] 5.5 Write property tests in `intelligence/anomaly/anomaly-detector.prop.spec.ts`
    - **Property 8: Z-scores are finite or null and respect the floor**
    - **Property 9: Warm-up flags only fixed-threshold breaches**
    - **Property 10: Learned flagging rule after warm-up**
    - **Property 11: Nothing evaluable, nothing flagged** (the `detectAnomalies` half; the `stepIntelligence` half is tested with the pipeline step)
    - **Validates: Requirements R3.1, R3.2, R3.3, R3.4, R3.5, R3.6, R3.7, R3.8, R3.9, R3.10, R3.12**

  - [ ] 5.6 Create `intelligence/anomaly/anomaly-learning.ts`
    - Export `LearningInput` and `learnBaselines(baselines, input, config)`.
    - Apply exactly one sample per pair unless a guard holds: blind Poll, unknown service, pre-Poll Open_Incident (`openBefore`), `null` or non-finite value, `up === false`, or a Raw_Anomaly for the pair in this Poll (the unconfirmed flag). Guarded Baselines are returned deeply equal. The function never resets a Baseline.
    - _Requirements: R2.1, R2.2, R2.3, R2.4, R2.5, R2.6, R2.7, R2.8, R2.9_

  - [ ] 5.7 Write property test in `intelligence/anomaly/anomaly-learning.prop.spec.ts`
    - **Property 5: Guarded pairs keep their Baseline**
    - **Validates: Requirements R2.1, R2.2, R2.3, R2.4, R2.5, R2.6, R2.9**

  - [ ] 5.8 Create `intelligence/anomaly/anomaly-tracker.ts`
    - Export `PairObservation` (`unknown-service`, `down-service`, `unusable`, `evaluated`), `PairTracking`, `TrackingMap`, `AnomalyEvent`, `TrackingContext`, `PairKey` and `trackAnomalies(prev, observations, context, config)` returning `{ tracking, events, relearn }`.
    - `evaluated` with a reading: `anomalousStreak += 1`, `clearStreak = 0`, `lastReading = reading`. Without a reading: `clearStreak += 1`, `anomalousStreak = 0`.
    - Confirmation hysteresis: emit `anomaly:detected` when `anomalousStreak === confirmPolls` and the pair is not confirmed; emit `anomaly:cleared` when `clearStreak === confirmPolls` and the pair is confirmed, and drop `lastReading` when the flag clears.
    - `unknown-service` and `down-service` clear at once: both streaks 0, `confirmed` false, `lastReading` null, emit `cleared` if it was confirmed, never add to `relearn`. `unusable` freezes the pair exactly as it was, no event.
    - Relearn: when the pair is `evaluated`, `anomalousStreak >= relearnPolls`, `!openBefore[service]`, and not (`signal === 'rssMb'` and `leakSuspected[service]`), add it to `relearn` and set both streaks to 0, leaving `confirmed` and `lastReading` untouched. While suppressed the streak keeps counting with no cap. With `relearnPolls === confirmPolls`, `detected` is emitted first and the reset leaves `confirmed` true.
    - Events are ordered by chain order then signal order.
    - _Requirements: R4.1, R4.2, R4.3, R4.4, R4.5, R4.6, R4.8, R4.9, R4.10, R4.11, R4.12, R4.13, R4.14, R4.15, R4.16_

  - [ ] 5.9 Write property test for confirmation events
    - In `intelligence/anomaly/anomaly-tracker.prop.spec.ts`.
    - **Property 12: Confirmation and clearing events fire once, at the right Poll**
    - **Validates: Requirements R4.2, R4.3, R4.4, R4.5, R4.6**

  - [ ] 5.10 Write property test for unknown, down and unusable observations
    - In `intelligence/anomaly/anomaly-tracker.prop.spec.ts`. Cover the tracker-level half: `unknown-service` and `down-service` clear at once and never relearn; `unusable` leaves the pair deeply equal with no event. The pipeline-level half (view and Baselines after a down Poll) is tested with the pipeline step.
    - **Property 14: Unknown and down services clear at once and unusable values freeze the pair**
    - **Validates: Requirements R2.5, R4.10, R4.11, R4.12**

  - [ ] 5.11 Write property tests for relearning
    - In `intelligence/anomaly/anomaly-tracker.prop.spec.ts`. Drive `trackAnomalies` with generated observation sequences, `openBefore` and `leakSuspected` maps.
    - **Property 15: Relearn happens in exactly the first eligible Poll**
    - **Property 16: A suspected leak is never relearned as normal**
    - **Validates: Requirements R4.8, R4.9, R4.13, R4.14, R4.15, R4.16**

  - [ ] 5.12 Write unit tests for the anomaly tracker edge cases
    - In `intelligence/anomaly/anomaly-tracker.spec.ts`: `confirmPolls` of 1 detects in the first anomalous Poll; `relearnPolls === confirmPolls` emits `detected` then resets with `confirmed` still true; a one-Poll gap resets the anomalous streak; an `rssMb` relearn is suppressed under Leak_Suspicion while `latencyP95Ms` of the same service is not.
    - _Requirements: R4.2, R4.8, R4.14, R4.15_

- [ ] 6. Implement the forecast and similarity pure functions
  - [ ] 6.1 Create `intelligence/forecast/trend-fitter.ts`
    - Export `RssSample` (re-export from `intelligence-types.ts` if defined there), `TrendFit` and `fitTrend(window, minSamples)`.
    - Return `null` for fewer than `minSamples` samples or equal timestamps. Use seconds relative to the first sample and center both axes before summing, so epoch-millisecond timestamps stay accurate. `slope = Sxy / Sxx`, `r2 = Sxy² / (Sxx · Syy)` clamped to [0, 1]; all-equal RSS gives `{ slope: 0, r2: 0 }`. A non-finite slope or R² returns `null`. Never mutate the window.
    - _Requirements: R5.3, R5.4, R5.5, R5.6, R5.7, R5.8, R5.11_

  - [ ] 6.2 Write property tests in `intelligence/forecast/trend-fitter.prop.spec.ts`
    - **Property 20: The trend fit recovers an exact line** (include epoch-ms timestamps, relative tolerance 1e-6)
    - **Property 21: Trend fits are well formed**
    - **Validates: Requirements R5.3, R5.4, R5.5, R5.6, R5.7, R5.8**

  - [ ] 6.3 Create `intelligence/forecast/forecaster.ts`
    - Export `ServiceForecastState`, `RssObservation`, `ForecastEvent`, `timeToLimitSeconds(latest, slope, limit)` (never below 0), `stepForecast(prev, obs, config, memoryLimitMb)` and `isLeakSuspected(forecast, config)`.
    - Order in `stepForecast`: (1) Memory_Drop when `up === false` or the fall from the previous sample exceeds `restartDropMb`: empty the window and, if a warning was active, clear it with reason `memory-dropped`; (2) append `{ t: now, mb: rssMb }` only when `up === true` and `rssMb` is finite, trimmed to `windowPolls`; (3) fit; (4) `timeToLimitSeconds` only when slope > `minSlopeMbPerS`, else `null`; (5) start a warning (and emit `forecast:warning`) when none is active, time to limit < `warnSeconds` and `r2 >= minR2`; (6) clear an active warning with `stopped-rising` when the fitted slope is <= `minSlopeMbPerS`; (7) `forecast` is `null` when there is no fit and no warning.
    - `isLeakSuspected` is true when the forecast has an active warning or a slope above `minSlopeMbPerS`, and false for `null`.
    - _Requirements: R5.1, R5.2, R5.9, R5.10, R6.1, R6.2, R6.3, R6.4, R6.5, R6.6, R6.7, R6.8, R6.9, R6.11, R6.12_

  - [ ] 6.4 Write property tests in `intelligence/forecast/forecaster.prop.spec.ts`
    - **Property 19: The RSS_Window follows its update rule**
    - **Property 22: Time to limit is null or a finite non-negative number**
    - **Property 23: Time to limit is monotonic**
    - **Property 24: Warnings start only from a good, close fit**
    - **Property 25: An active warning stays visible and silent** (the `stepForecast` half; the `intelligenceView` half is tested with the pipeline step)
    - **Property 26: Warnings clear with the right reason, once**
    - **Validates: Requirements R5.1, R5.2, R5.10, R6.1, R6.2, R6.3, R6.4, R6.5, R6.6, R6.7, R6.8, R6.9, R6.11, R6.12**

  - [ ] 6.5 Write unit tests for the forecaster in `intelligence/forecast/forecaster.spec.ts`
    - A steady leak ending in a `forecast:warning`; a restart (`up` false and an RSS fall above `restartDropMb`) giving `memory-dropped` and an emptied window that restarts with the current sample; a flattened series giving `stopped-rising`; `up` true with `rssMb` null leaving the window unchanged; `isLeakSuspected` for warning, slope above minimum, slope below minimum and `null`.
    - _Requirements: R6.2, R6.5, R6.6, R6.9_

  - [ ] 6.6 Create `intelligence/similarity/feature-extractor.ts`
    - Export `FeatureVector`, `featureVectorLength(n)` (2N + 8), `FeatureConfig`, `extractFeatures(incident, nowMs, chain, config)` and `withoutDuration(v)` (drops the last entry).
    - Layout: one-hot root (all 0 for an unknown root), affected flags, four kind flags (`latency`, `errors`, `memory`, `down`), three peaks over their critical values (latency critical, error ratio critical, `memoryLimitMb`) clamped to [0, 1] and 0 for `null`, then duration over `durationCapSeconds` clamped to [0, 1]. Duration is `durationMs / 1000` when resolved and `(nowMs − Date.parse(openedAt)) / 1000` when open. Any non-finite intermediate becomes 0. The vector depends on content only, never on id or timestamps as identifiers, and the incident is not modified.
    - _Requirements: R7.1, R7.2, R7.3, R7.4, R7.5, R7.6, R7.7, R7.8_

  - [ ] 6.7 Write property tests in `intelligence/similarity/feature-extractor.prop.spec.ts`
    - **Property 27: Feature vectors have the specified shape and range**
    - **Property 28: Feature vectors depend on content, not identity, and open duration starts at 0**
    - **Validates: Requirements R7.1, R7.2, R7.3, R7.4, R7.5, R7.6, R7.7, R7.8**

  - [ ] 6.8 Create `intelligence/similarity/similarity-matcher.ts`
    - Export `cosineSimilarity(a, b)`, `Candidate`, `Match` and `selectSimilar(target, candidates, threshold)`.
    - `cosineSimilarity` returns 0 for different lengths (never throws) and for a zero norm, otherwise `dot / (‖a‖‖b‖)` clamped to [0, 1]. `selectSimilar` picks the highest unrounded similarity, breaks exact ties by the latest `resolvedAt`, and returns `null` for an empty list or a best below `threshold`.
    - _Requirements: R8.1, R8.2, R8.3, R8.4, R8.5, R8.7, R8.8, R8.10_

  - [ ] 6.9 Write property tests in `intelligence/similarity/similarity-matcher.prop.spec.ts`
    - **Property 29: Cosine similarity laws**
    - **Property 30: The best candidate wins, ties go to the latest, and the threshold decides**
    - **Validates: Requirements R8.1, R8.2, R8.3, R8.4, R8.5, R8.7, R8.8, R8.10**

  - [ ] 6.10 Create `intelligence/similarity/incident-similarity.ts`
    - Export `toSimilarIncident(match)` (similarity rounded to 3 decimals, duration in whole seconds), `matchOnOpen`, `matchOnResolve`, `SimilarityFailure` and `applySimilarity(tracker, events, nowMs, chain, config)`.
    - `matchOnOpen` compares Comparison_Vectors (`withoutDuration` on both sides) against every history incident. `matchOnResolve` compares full vectors and excludes the incident's own id from the candidates.
    - `applySimilarity` walks the Poll's events: `opened` patches `tracker.open[root]` and the event with `matchOnOpen` over the post-step history; `resolved` patches the history entry with that id and the event with `matchOnResolve`; `updated` is untouched. Each incident is wrapped in its own `try/catch`: on a throw the field is `null` and a `SimilarityFailure` is returned for the poller to log with the stack. It changes no field other than `similar`, only on incidents that open or resolve in that Poll, and does not touch `recurrence`.
    - _Requirements: R8.6, R8.9, R8.11, R8.12, R8.13, R8.14, R7.4_

  - [ ] 6.11 Write property tests in `intelligence/similarity/incident-similarity.prop.spec.ts`
    - **Property 31: Matching at open time ignores durations**
    - **Property 32: Matching at resolve time excludes the incident itself and reports a well-formed record**
    - **Property 18: Existing decisions do not depend on the intelligence layer** (run `trackIncidents` with and without `applySimilarity` over generated Poll sequences and compare everything except `similar`)
    - **Validates: Requirements R8.6, R8.9, R8.11, R8.12, R8.13, R4.19, R9.7**

  - [ ] 6.12 Write unit tests in `intelligence/similarity/incident-similarity.spec.ts`
    - A matcher that throws on one incident yields `similar: null` for it, a `SimilarityFailure` with the incident id and phase, and still returns the event; the other incidents in the same Poll are matched normally.
    - Two incidents resolving in the same Poll each see the other; an opening incident sees incidents resolved in the same Poll.
    - Below-threshold history yields `null`.
    - _Requirements: R8.8, R8.11, R8.14_

- [ ] 7. Implement the intelligence pipeline step
  - [ ] 7.1 Create `haunting-engine/src/intelligence/intelligence-step.ts`
    - Export `initialIntelligenceState(chain)`, `IntelligenceInput` (`now`, `metricsAvailable`, `health`, `openBefore`), `IntelligenceEvent` (`ForecastEvent | AnomalyEvent`), `stepIntelligence(prev, input, config)` and `intelligenceView(state, chain)`. Pure: no I/O, no timers, no clock reads, no shared state.
    - `initialIntelligenceState`: 3 × N zero Baselines (`EMPTY_BASELINE`), tracking entries with streaks 0, `confirmed` false, `lastReading` null, and per service an empty window, no warning and a `null` forecast.
    - `stepIntelligence` order: (1) a blind Poll returns `prev` unchanged with no events; (2) forecast step per service in chain order; (3) derive `leakSuspected[service]` with `isLeakSuspected` from this Poll's forecasts; (4) `detectAnomalies` against the Baselines as they were before this Poll; (5) one observation per (service, signal), tested in order `unknown-service`, `down-service`, `unusable`, `evaluated`; (6) `trackAnomalies` with `openBefore` and `leakSuspected`; (7) `learnBaselines` with the unconfirmed Raw_Anomaly flags; (8) `resetBaseline` for the pairs in `relearn`; (9) return the new state and events, forecast events first, then anomaly events.
    - `intelligenceView` returns `anomalies` as the `lastReading` of every pair with `confirmed` true (chain order, then `latencyP95Ms`, `errorRatio`, `rssMb`) and `forecasts` as the non-null `forecast` of every service in chain order. It is the only place that turns state into snapshot fields.
    - _Requirements: R1.1, R1.2, R2.1, R2.7, R2.8, R4.1, R4.7, R4.14, R4.17, R4.18, R6.13, R9.1, R9.2, R9.8, R9.9_

  - [ ] 7.2 Create the test helper `haunting-engine/src/intelligence/test-support.ts`
    - Export `deepFreeze`, and builders that produce `ServiceHealth` records through the real `scoreService` so Fixed_Threshold_Breach logic is the production one.
    - Export fast-check generators for Poll sequences of 1 to 60 Polls over chains of 1 to 4 services: per Poll a blind flag, a per-service status, signal values mixing normal, anomalous, `null` and `NaN`, an open-incident map, and RSS ramps and drops.
    - Test-only helper: not imported by any production file.
    - _Requirements: R12.1, R12.2_

  - [ ] 7.3 Write property test for the initial state in `intelligence/intelligence-step.prop.spec.ts`
    - **Property 1: Initial state shape**
    - Tag: `// Feature: engine-intelligence, Property 1: Initial state shape`, `numRuns` at least 100.
    - **Validates: Requirements R1.1, R1.2, R4.1**

  - [ ] 7.4 Write property test for baseline replay equivalence
    - In `intelligence/intelligence-step.prop.spec.ts`. Use an independent reference model inside the test: a plain loop that applies `updateBaseline` for the (Poll, pair) combinations that a restatement of the guards allows and that were not relearn-reset.
    - **Property 6: Baselines equal a replay of the unguarded Polls**
    - **Validates: Requirements R2.8, R2.9**

  - [ ] 7.5 Write property test for the pre-Poll open-incident guard
    - In `intelligence/intelligence-step.prop.spec.ts`. An incident opening in a Poll does not stop learning in that Poll; an incident resolving in a Poll does.
    - **Property 7: Open-incident guard reads the pre-Poll state**
    - **Validates: Requirements R2.7**

  - [ ] 7.6 Write property test for Blind_Polls
    - In `intelligence/intelligence-step.prop.spec.ts`. Insert Blind_Polls at generated positions; compare state, events, `intelligenceView` and the final state with the sequence without them.
    - **Property 13: Blind Polls change nothing**
    - **Validates: Requirements R4.7, R4.18, R5.9, R6.10**

  - [ ] 7.7 Write property test for the reported anomalies
    - In `intelligence/intelligence-step.prop.spec.ts`. Check `intelligenceView(state).anomalies` against the confirmed pairs of states reached by generated sequences, including order and the absence of Raw_Anomaly-only pairs.
    - **Property 17: Reported anomalies are exactly the confirmed ones, in order**
    - **Validates: Requirements R4.17**

  - [ ] 7.8 Write property test for purity and replay
    - In `intelligence/intelligence-step.prop.spec.ts`. Deep-freeze inputs and states, run `stepIntelligence` and `applySimilarity` over the sequence, check no throw and that every argument is deeply equal to its copy from before the call, and that two replays give deeply equal final states and event lists.
    - **Property 33: Everything is pure and replayable**
    - **Validates: Requirements R3.11, R5.11, R7.8, R9.1, R9.2, R9.8**

  - [ ] 7.9 Write property test for the JSON round trip
    - In `intelligence/intelligence-step.prop.spec.ts`. Every `ClusterSnapshot` fields from `intelligenceView` and every `Incident` the pipeline produces satisfies `JSON.parse(JSON.stringify(x))` deeply equal to `x`, with no `NaN`, `Infinity` or `undefined` in any new field.
    - **Property 34: Snapshots and incidents survive a JSON round trip**
    - **Validates: Requirements R10.8**

  - [ ] 7.10 Write unit and worked-example tests in `intelligence/intelligence-step.spec.ts`
    - Pipeline halves left open by tasks 5 and 6: a Blind_Poll feeds the tracker nothing (Property 11); a down service has no reading in the view and unchanged Baselines (Property 14); an active warning stays in the view with no new event (Property 25).
    - Scripted leak: flat 85 MB for 10 Polls, then +4 MB per 2 s Poll; the warning appears on the expected Poll and the `rssMb` Baseline is not relearned.
    - Latency spike confirms after two Polls and clears after two. Payments restart (`up` false for one Poll) gives `memory-dropped`, `anomaly:cleared` for every confirmed payments pair in the same Poll, and unchanged payments Baselines. Flapping `up` gives one `detected` and one `cleared` per cycle only when `confirmPolls` anomalous Polls separate the outages.
    - Forecast events come before anomaly events in the returned list.
    - _Requirements: R3.8, R4.10, R4.11, R6.9, R9.9_

- [ ] 8. Wire the intelligence layer into the engine
  - [ ] 8.1 Update `EngineStateService` and confirm the incident tracker field
    - In `engine/engine-state.service.ts` add `private intelligenceState` (initialized with `initialIntelligenceState` for the configured chain), a getter `intelligence`, and `update(snapshot, tracker, intelligence)` that replaces the three together. `openIncidents()` and `resolvedIncidents()` stay unchanged.
    - In `incidents/incident-tracker.ts` confirm `openIncident` sets `similar: null` in the object it builds (task 1.3 may already have done it); add it if missing. No decision logic changes.
    - _Requirements: R9.3, R10.4_

  - [ ] 8.2 Add `emitIntelligenceEvent` to `engine/events.gateway.ts`
    - Map each internal `IntelligenceEvent` to its Socket.IO name and payload (`anomaly:detected`, `anomaly:cleared`, `forecast:warning`, `forecast:cleared`) with an exhaustive `switch`. `handleConnection` is unchanged.
    - _Requirements: R10.5, R10.9, R10.10_

  - [ ] 8.3 Wire `PollerService` in `engine/poller.service.ts`
    - Keep the constructor. After attribution capture `prevTracker` and `prevIntel` before `trackIncidents`, then call `stepIntelligence(prevIntel, input, config)` inside a `try`, with `openBefore` derived from `prevTracker.open`.
    - On a throw, log `Intelligence step failed: <message>` with the stack, keep `prevIntel`, and emit no `anomaly:*` or `forecast:*` events. The snapshot is still stored and emitted.
    - Call `applySimilarity(tracker1, incidentEvents, now, chain, config)` in its own `try/catch`, log every returned `SimilarityFailure` and any thrown error with the stack, and use the returned tracker and events.
    - Build `anomalies` and `forecasts` with `intelligenceView` from the state that will be stored (also for blind Polls and the fallback). Call `state.update(snapshot, tracker2, intelligence)`.
    - Emit in this order: snapshot, incident events, forecast events, anomaly events, in the order the step returned them.
    - _Requirements: R8.14, R9.3, R9.4, R9.6, R9.9, R6.10_

  - [ ] 8.4 Update existing specs for the new required fields
    - Add `anomalies: []`, `forecasts: []` and `similar: null` wherever a `ClusterSnapshot` or `Incident` literal is built, and adapt calls to the new `update(snapshot, tracker, intelligence)` signature, in: `poller.service.spec.ts`, `events.gateway.spec.ts`, `snapshot.controller.spec.ts`, `incident-tracker.spec.ts`, `incident-tracker.prop.spec.ts`, `incidents.controller.spec.ts` and the e2e helpers in `haunting-engine/test/`. `app.module.spec.ts` is handled in task 8.7.
    - Do not change any expected decision or assertion beyond these fields.
    - _Requirements: R9.7, R10.3, R10.4_

  - [ ] 8.5 Extend `engine/poller.service.spec.ts`
    - Call order: forecast before tracking, and the pre-Poll incident state is passed to the step.
    - An injected throw in `stepIntelligence`: previous state kept, snapshot emitted with `anomalies` and `forecasts` from the retained state, no intelligence events, error logged with the stack.
    - A throw or failure in similarity: `similar` is `null`, the incident event is still emitted, the error is logged with the stack.
    - Emission order: snapshot, incident events, forecast events, anomaly events. A Blind_Poll snapshot repeats the previous `anomalies` and `forecasts`.
    - _Requirements: R8.14, R9.6, R9.9, R4.18_

  - [ ] 8.6 Extend `engine/events.gateway.spec.ts`
    - `emitIntelligenceEvent` maps each of the four internal events to the right Socket.IO name and payload; a connecting client still receives the latest snapshot with `anomalies` and `forecasts`; with no stored snapshot a connecting client receives none.
    - _Requirements: R10.5, R10.9, R10.10_

  - [ ] 8.7 Extend `src/app.module.spec.ts` with the real AppModule boot
    - Build the real `AppModule` (no new providers), call `app.init()` and assert it resolves without throwing. Assert that the first stored snapshot has `anomalies` and `forecasts` fields (empty arrays). Close the app in `afterAll`.
    - _Requirements: R13.1_

  - [ ] 8.8 Extend `haunting-engine/test/snapshot-stream.e2e-spec.ts`
    - Assert the first snapshot received over Socket.IO contains `anomalies` and `forecasts`.
    - _Requirements: R13.5, R10.9_

- [ ] 9. Checkpoint - Build, boot and test the engine with the intelligence layer
  - Run `npm run build:shared` and `npm run build` in `haunting-engine/`, start the engine, `GET /health` and confirm a success response within 30 seconds, then stop it. Run `npm test` in `haunting-engine/`.
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: R13.2, R13.3, R13.4_

- [ ] 10. Update the victim-app for the leak demo
  - [ ] 10.1 Add `MEMORY_GAUGE_INTERVAL_MS` validation in `libs/common`
    - In `libs/common/src/env-validation.ts` add `parseMemoryGaugeIntervalMs(raw)` returning 1000 for `undefined` or an empty string, otherwise requiring the trimmed string to match `/^[1-9]\d*$/` and be a safe integer; any other value throws an `Error` naming `MEMORY_GAUGE_INTERVAL_MS`.
    - Add `validateMemoryGaugeInterval()` beside `validateRequiredEnv`: on error log `[Bootstrap] MEMORY_GAUGE_INTERVAL_MS … Exiting.` and call `process.exit(1)`. Export both from `libs/common/src/index.ts`.
    - Call `validateMemoryGaugeInterval()` in the `main.ts` of gateway, orders and payments before `NestFactory.create`.
    - _Requirements: R15.3, R15.4, R15.5_

  - [ ] 10.2 Write unit tests for the parser and validator
    - In `libs/common/src/env-validation.spec.ts`: default 1000 for unset and empty, a valid override, one rejection per invalid class (`0`, `-5`, `1.5`, `abc`, `NaN`, `Infinity`) with the error naming `MEMORY_GAUGE_INTERVAL_MS`, and `validateMemoryGaugeInterval` logging and exiting with code 1 (spy on `process.exit`).
    - _Requirements: R15.3, R15.4, R15.5, R12.6_

  - [ ] 10.3 Write property test in `libs/common/src/env-validation.prop.spec.ts`
    - **Property 35: Only positive integers are accepted as a gauge interval**
    - Tag: `// Feature: engine-intelligence, Property 35: Only positive integers are accepted as a gauge interval`, `numRuns` at least 100.
    - **Validates: Requirements R15.3, R15.4, R15.5**

  - [ ] 10.4 Use the configured interval in `MetricsService` and update the 5000 ms specs
    - In `libs/observability/src/metrics.service.ts` read `process.env.MEMORY_GAUGE_INTERVAL_MS` in the constructor through `parseMemoryGaugeIntervalMs` and use the result in `setInterval` (default 1000). Keep the initial gauge refresh, metric names, labels and values.
    - In `metrics.service.spec.ts` change the two tests that advance fake timers by `5_000` ("after 5000ms interval fires" and "every 5000ms tick") to `1_000`, and update the constructor comment from 5 000 ms to the configured interval.
    - _Requirements: R15.3, R15.4, R15.6, R15.8_

  - [ ] 10.5 Add `MEMORY_GAUGE_INTERVAL_MS` tests to `metrics.service.spec.ts`
    - Default 1000, a valid override, and one rejection per invalid class (`0`, `-5`, `1.5`, `abc`, `NaN`, `Infinity`).
    - _Requirements: R12.6, R15.3, R15.4, R15.5_

  - [ ] 10.6 Update `victim-app/.env.example`
    - List `LEAK_MB_PER_SECOND=2` and `MEMORY_GAUGE_INTERVAL_MS=1000`, each with a one-line description. Do not change the code default in `chaos.service.ts`.
    - _Requirements: R15.2, R15.7_

- [ ] 11. Update compose and environment files
  - [ ] 11.1 Update `docker-compose.yml`
    - Check that the `haunting-engine` service passes the 17 engine variables from task 3.3 as `${NAME:-default}` with the defaults of R11.1; add any that are missing. Do not pass the two `INTEGRATION_*` variables.
    - For each of `gateway`, `orders` and `payments` add `MEMORY_GAUGE_INTERVAL_MS: ${MEMORY_GAUGE_INTERVAL_MS:-1000}`. The `LEAK_MB_PER_SECOND` replacement was done in task 2.3. Leave `mem_limit`, healthchecks and `CHAOS_TTL_SECONDS` unchanged.
    - _Requirements: R11.11, R15.7, R15.8_

  - [ ] 11.2 Update `haunting-engine/.env.example`
    - Check whether `INTEGRATION_LEAK_TIMEOUT_SECONDS=300` and `INTEGRATION_MIN_LEAD_SECONDS=10` are present (task 3.3 may have added them). Add only the ones missing, each marked test-only with a one-line description.
    - _Requirements: R11.12, R14.1, R14.6_

  - [ ] 11.3 Write file-check specs for the env files and compose
    - In `haunting-engine/src/config/env-files.spec.ts` parse `haunting-engine/.env.example`, `victim-app/.env.example` and `docker-compose.yml`: every variable is listed with its documented default; compose uses `${NAME:-default}` with matching defaults; the two `INTEGRATION_*` variables are in `.env.example` but not in compose; the three victim services set the leak and gauge variables.
    - _Requirements: R11.11, R11.12, R15.1, R15.2, R15.7_

- [ ] 12. Checkpoint - Victim-app and full stack boot
  - Run `npm run build` and `npm test` in `victim-app/`. Run `docker compose up --build`; confirm every container is healthy and `haunting-engine` reports healthy within 30 seconds, and that a snapshot received within the next 30 seconds contains `anomalies` and `forecasts`.
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: R13.2, R13.3, R13.5, R13.6_

- [ ] 13. Add the memory-leak lead-time integration test
  - [ ] 13.1 Create `haunting-engine/test/leak-lead-time.ts` with the test logic
    - Pure helpers: `parseIntegrationSettings(env)` for `INTEGRATION_LEAK_TIMEOUT_SECONDS` (default 300) and `INTEGRATION_MIN_LEAD_SECONDS` (default 10), each matching `/^[1-9]\d*$/` and otherwise throwing an error naming the variable; `isCrashSnapshot(snapshot, maxRssSeen, limitMb, restartDropMb)` with three signals (payments `down`, payments RSS at or above the limit, RSS more than `FORECAST_RESTART_DROP_MB` below the maximum seen in this run); `computeLeadSeconds(warningTs, crashTs)`.
    - _Requirements: R14.4, R14.5, R14.6, R14.11_

  - [ ] 13.2 Write tests for the helpers in `haunting-engine/test/leak-lead-time.e2e-spec.ts`
    - They need no running stack. Cover defaults, valid overrides, rejection of `0`, `-1`, `1.5`, `abc` with the variable named, each of the three crash signals, no crash signal on a small RSS fall, and the lead computation.
    - _Requirements: R14.4, R14.5, R14.11_

  - [ ] 13.3 Create `haunting-engine/test/memory-leak-forecast.e2e-spec.ts`
    - Reuse `connect`, `postJson`, `resetAllChaos`, `waitForNoOpenIncidents` and `ENGINE_URL` from `helpers.ts`. Set the per-test timeout to `(INTEGRATION_LEAK_TIMEOUT_SECONDS + 60) × 1000` ms.
    - Flow: parse settings first and fail before any chaos on a bad value; `GET /health` on the engine and, if the stack is absent, log that the full stack is required and return from every test with no chaos injected and no cleanup; `resetAllChaos()`, `waitForNoOpenIncidents()` and wait until payments is `healthy` with no payments warning; connect a Socket.IO client; `POST /api/chaos/payments/memory-leak` with `{ enabled: true }`.
    - Poll `GET /api/snapshot` every 1 s, skipping an already seen `timestamp`. Record the warning time (first snapshot whose `forecasts` has a payments entry with `warning: true`) and the crash time (first snapshot satisfying `isCrashSnapshot`), tracking the maximum payments RSS. Stop at the crash or after the timeout.
    - Assert: with a crash, a warning time exists (else fail "no forecast warning was observed"), is earlier than the crash time, and lead >= `INTEGRATION_MIN_LEAD_SECONDS`; print the lead and the minimum; a short lead fails with the lead, warning time, crash time and minimum. With no crash by the timeout, assert only that a warning was observed, print "no crash occurred" and skip the lead assertions.
    - Also assert the socket client received exactly one `forecast:warning` for payments and, after a crash, a `forecast:cleared` with reason `memory-dropped`.
    - `afterAll`, whenever chaos was injected: `resetAllChaos()` in a `finally`, close the socket, and `waitForNoOpenIncidents()`.
    - _Requirements: R14.1, R14.2, R14.3, R14.4, R14.5, R14.6, R14.8, R14.9, R14.10, R14.11, R14.12, R14.13, R6.3, R6.7_

- [ ] 14. Final checkpoint - Full stack run, measured lead time and roadmap
  - [ ] 14.1 Run the full stack and the integration test
    - Run `docker compose up --build`, then `npm run test:e2e` in `haunting-engine/`. Also run the full unit suites in `haunting-engine/` and `victim-app/`. Note the printed warning time, crash time, lead time and leak rate.
    - _Requirements: R13.5, R14.6_

  - [ ] 14.2 Record the measured lead time in `.kiro/specs/engine-intelligence/design.md`
    - Replace the "_not yet measured_" line under "Measured lead time (R14.7)" with `lead = <seconds> s, compared with INTEGRATION_MIN_LEAD_SECONDS = <value>`, with the date, the leak rate, and the warning and crash timestamps from the test output.
    - Update the "Assessment: known open issue" section only if a measurement changes a conclusion or its stated basis; otherwise leave it as it is.
    - _Requirements: R14.7, R16.1, R16.3_

  - [ ] 14.3 Update `.kiro/steering/roadmap.md`
    - Move `engine-intelligence` to Done, make `haunted-house` the next phase, and keep the "Known open issues" entry open (R16.4, R16.5).
    - _Requirements: R16.4_

## Notes

- Each task references specific requirements for traceability.
- Checkpoints ensure incremental validation; every app milestone ends with a real boot.
- Property tests use fast-check with at least 100 runs and the tag `// Feature: engine-intelligence, Property <N>: <text>`.
- Properties 11, 14 and 25 are split: the function-level half is tested in tasks 5 and 6, the pipeline half in task 7.10.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "2.3"] },
    { "id": 1, "tasks": ["1.2", "2.2", "2.4"] },
    { "id": 2, "tasks": ["1.3"] },
    { "id": 3, "tasks": ["3.1", "5.1"] },
    { "id": 4, "tasks": ["3.2", "3.3", "5.2", "6.1", "6.6"] },
    { "id": 5, "tasks": ["5.3", "5.4", "5.6", "6.2", "6.3", "6.7", "6.8"] },
    { "id": 6, "tasks": ["5.5", "5.7", "5.8", "6.4", "6.5", "6.9", "6.10"] },
    { "id": 7, "tasks": ["5.9", "5.12", "6.11", "6.12", "7.1", "7.2", "8.1", "10.1"] },
    { "id": 8, "tasks": ["5.10", "7.3", "7.10", "8.2", "10.2", "10.3", "10.4", "10.6"] },
    { "id": 9, "tasks": ["5.11", "7.4", "8.3", "10.5", "11.1", "11.2"] },
    { "id": 10, "tasks": ["7.5", "8.4", "8.7", "8.8", "11.3"] },
    { "id": 11, "tasks": ["7.6", "8.5", "8.6", "13.1"] },
    { "id": 12, "tasks": ["7.7", "13.2", "13.3"] },
    { "id": 13, "tasks": ["7.8", "14.1"] },
    { "id": 14, "tasks": ["7.9", "14.2", "14.3"] }
  ]
}
```
