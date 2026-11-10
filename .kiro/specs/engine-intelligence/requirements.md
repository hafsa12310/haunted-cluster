# Requirements Document

## Introduction

The haunting-engine is rule-based today: it scores each service against fixed thresholds, attributes faults, tracks incidents and flags recurrence by exact Fingerprint match. The engine-intelligence feature adds a small learned layer on top of that pipeline, with three capabilities:

1. **Learned anomaly detection.** For each service and each of three signals (p95 latency, error ratio, RSS), the Engine learns what "normal" looks like with an exponentially weighted mean and variance, and flags a signal when its z-score is too high. Until a baseline has seen enough samples, the Engine falls back to the existing fixed thresholds. Baselines never learn from blind Polls, unknown services, open incidents, or samples that are themselves anomalous, so chaos is never learned as normal.
2. **Memory-exhaustion forecasting.** For each service the Engine fits a linear trend to recent RSS samples and estimates how many seconds remain until RSS reaches the container memory limit. It emits a warning before the limit is reached and clears it when memory stops rising or the service restarts.
3. **Incident similarity.** Each Incident is described as a numeric feature vector, and the Engine finds the most similar resolved Incident by cosine similarity. This sits alongside, and does not replace, the existing Fingerprint recurrence.

All new analysis logic is written as pure functions (no I/O, no timers, no shared state) and plugged into the existing `PollerService` per-Poll pipeline, which remains the only writer of engine state. New events and snapshot fields are defined once in `shared/` so the haunted-house frontend can consume them. Every new setting comes from environment variables with documented defaults.

The feature does not change how Health_Score, Service_Status, Breached_Kinds, Dread, attribution or the Incident lifecycle are computed. Anomalies, forecasts and similar incidents are additional information, not new inputs to those decisions.

The feature also assesses whether baselines or forecasting could reduce the known open issue recorded in `roadmap.md` and in the haunting-engine design (after a fast payments restart, failed requests stay in the rate window, so the Engine can miss the outage or blame orders or gateway). The assessment is a documentation deliverable of the design phase.

**Out of scope for this spec:** persisting baselines, forecasts or incident history across Engine restarts; training from external datasets or any non-in-process model; the haunted-house frontend and audio; the ghost narrator; changing the existing scoring, attribution or incident lifecycle rules; fixing the known open issue itself.

## Glossary

- **Engine**: The haunting-engine NestJS application.
- **Poller**: The Engine's `PollerService`, the only component that changes Engine state.
- **Poll**: One cycle in which the Engine queries Prometheus, scores every service, updates incidents and emits events.
- **Blind_Poll**: A Poll in which Prometheus was unavailable, so `metricsAvailable` is false and every service is `unknown`.
- **Shared_Package**: The `shared/` types-only package (`@haunted-cluster/shared`).
- **Service_Chain**: The ordered list of monitored services read from `SERVICE_CHAIN`.
- **Known_Service**: A service listed in the Service_Chain.
- **Unknown_Service**: A service that is not a Known_Service, or a Known_Service whose Service_Status is `unknown` in the current Poll.
- **Open_Incident**: An Incident with status `open` whose Root_Service is the service in question.
- **Monitored_Signal**: One of `latencyP95Ms`, `errorRatio` or `rssMb`.
- **Fixed_Threshold_Breach**: A Monitored_Signal whose Badness for the matching kind (`latency`, `errors`, `memory`) is greater than `0.2`, as computed by the existing health scoring.
- **Baseline**: For one (service, Monitored_Signal) pair, the exponentially weighted mean, exponentially weighted variance and the count of samples learned so far.
- **Baseline_Sample**: A Monitored_Signal value that the Engine has used to update a Baseline.
- **Alpha**: The EWMA smoothing factor `ANOMALY_ALPHA`, in (0, 1].
- **Z_Score**: For a Monitored_Signal value `x` and a Baseline with mean `m` and standard deviation `s`, `(x − m) / max(s, floor)`, where `floor` is the configured minimum standard deviation for that signal.
- **Warm_Up**: The state of a Baseline whose Baseline_Sample count is below `ANOMALY_WARMUP_POLLS`.
- **Anomaly**: A Monitored_Signal flagged for a service in a Poll, either because its Z_Score is above `ANOMALY_Z_THRESHOLD` (learned detection) or, during Warm_Up, because it is a Fixed_Threshold_Breach.
- **Anomaly_Reading**: The per-Poll record of one Anomaly: service, signal, value, baseline mean, baseline standard deviation, Z_Score (null during Warm_Up), and the detection method (`learned` or `fixed`).
- **Memory_Limit_Mb**: The container memory limit, `MEMORY_LIMIT_MB` (default 256).
- **RSS_Window**: The last `FORECAST_WINDOW_POLLS` timestamped RSS samples of one service.
- **Trend_Fit**: A least-squares line through an RSS_Window with its slope (MB per second) and coefficient of determination R².
- **Time_To_Limit**: `(Memory_Limit_Mb − latest RSS) / slope`, in seconds, for a Trend_Fit with positive slope.
- **Memory_Forecast**: The per-Poll record for one service: slope, R², latest RSS, Time_To_Limit, and whether a forecast warning is active.
- **Forecast_Warning**: The state of a Memory_Forecast in which Time_To_Limit is below `FORECAST_WARN_SECONDS` and the Trend_Fit quality is sufficient.
- **Feature_Vector**: The numeric description of an Incident used for similarity matching.
- **Cosine_Similarity**: The dot product of two Feature_Vectors divided by the product of their norms, defined as 0 when either norm is 0.
- **Similar_Incident**: The resolved Incident with the highest Cosine_Similarity to a given Incident, provided it is at least `SIMILARITY_THRESHOLD`.
- **Recurrence**: The existing Fingerprint-based record on an Incident (unchanged by this feature).
- **Intelligence_State**: The Baselines, RSS_Windows and active Forecast_Warnings held by the Engine between Polls.
- **Baseline_Updater**: The pure function that applies one Baseline_Sample to one Baseline.
- **Anomaly_Detector**: The pure function that turns Baselines and current signal values into Anomaly_Readings.
- **Trend_Fitter**: The pure function that computes a Trend_Fit from an RSS_Window.
- **Forecaster**: The pure function that turns a Trend_Fit and the previous forecast state into a Memory_Forecast.
- **Feature_Extractor**: The pure function that turns an Incident into a Feature_Vector.
- **Similarity_Matcher**: The pure function that computes Cosine_Similarity and selects the Similar_Incident.


## Requirements

### Requirement 1: Per-Signal Baselines

**User Story:** As an on-call engineer, I want the Engine to learn what normal looks like for every service and signal, so that unusual behavior is noticed even when it stays below the fixed thresholds.

#### Acceptance Criteria

1. THE Engine SHALL maintain exactly one Baseline for each combination of Known_Service and Monitored_Signal, so that a Service_Chain of N services yields 3 × N Baselines.
2. WHEN the Engine starts, THE Engine SHALL initialize every Baseline with a sample count of 0, so that every Baseline is in Warm_Up until `ANOMALY_WARMUP_POLLS` Baseline_Samples have been applied to it.
3. WHEN the first Baseline_Sample is applied to a Baseline, THE Baseline_Updater SHALL set the mean to that sample, the variance to 0 and the sample count to 1.
4. WHEN a Baseline_Sample `x` is applied to a Baseline with a sample count of at least 1, THE Baseline_Updater SHALL set the new mean to `m + Alpha × (x − m)` and the new variance to `(1 − Alpha) × (v + Alpha × (x − m)²)`, where `m` and `v` are the previous mean and variance.
5. WHEN a Baseline_Sample is applied to a Baseline, THE Baseline_Updater SHALL increase the sample count of that Baseline by exactly 1 and SHALL leave every other Baseline unchanged.
6. THE Baseline_Updater SHALL keep every Baseline variance greater than or equal to 0 and every Baseline mean and variance a finite number, for every finite Baseline_Sample and every Alpha in (0, 1].
7. THE Baseline_Updater SHALL return a new Baseline and SHALL NOT modify the Baseline passed to it, so that the same Baseline, Baseline_Sample and Alpha always produce the same result.
8. IF a Baseline_Sample is `null`, `NaN` or infinite, THEN THE Baseline_Updater SHALL return the Baseline unchanged, with the same mean, variance and sample count.

### Requirement 2: Baseline Learning Guards

**User Story:** As an on-call engineer, I want baselines to ignore faults, so that chaos is never learned as normal.

#### Acceptance Criteria

1. IF a Poll is a Blind_Poll, THEN THE Engine SHALL leave every Baseline, including its mean, variance and sample count, unchanged in that Poll.
2. IF a service is an Unknown_Service in a Poll, THEN THE Engine SHALL leave every Baseline of that service, including its mean, variance and sample count, unchanged in that Poll.
3. WHILE a service has an Open_Incident, THE Engine SHALL leave every Baseline of that service, including its mean, variance and sample count, unchanged in every Poll.
4. IF a Monitored_Signal value is `null` or not finite, THEN THE Engine SHALL leave the Baseline for that signal unchanged in that Poll and SHALL leave the Baselines of the service's other Monitored_Signals subject only to the guards that apply to them.
5. IF a service has `up` equal to false in a Poll, THEN THE Engine SHALL leave every Baseline of that service unchanged in that Poll.
6. IF a Monitored_Signal is flagged as an Anomaly in a Poll, THEN THE Engine SHALL leave the Baseline for that signal unchanged in that Poll, whether the Anomaly was detected by method `learned` or `fixed`.
7. WHEN the Engine evaluates the Open_Incident guard in Criterion 3 for a Poll, THE Engine SHALL use the Incident state held before that Poll's incident tracking step, so that an Incident opened or resolved in the current Poll does not change the guard result for that Poll.
8. WHEN none of the guards in Criteria 1 to 6 applies to a (service, Monitored_Signal) pair in a Poll, THE Engine SHALL apply the signal value of that Poll as exactly one Baseline_Sample to that Baseline.
9. IF a guard in Criteria 1 to 6 applies, THEN THE Engine SHALL NOT apply a Baseline_Sample to the guarded Baseline and SHALL NOT reset the Baseline, so that the sample count after the Poll equals the sample count before it.

### Requirement 3: Anomaly Detection

**User Story:** As an on-call engineer, I want a signal flagged when it is statistically unusual for that service, so that I hear trouble early.

#### Acceptance Criteria

1. WHEN a Poll runs and a Monitored_Signal value is finite for a Known_Service that is not an Unknown_Service, THE Anomaly_Detector SHALL compute the Z_Score of that value against the Baseline of that service and signal as it was before the current Poll's Baseline_Sample is applied.
2. WHILE a Baseline is not in Warm_Up (its Baseline_Sample count is at least `ANOMALY_WARMUP_POLLS`), WHEN the Z_Score of a value is greater than `ANOMALY_Z_THRESHOLD`, THE Anomaly_Detector SHALL flag an Anomaly with detection method `learned`, and the Anomaly_Reading SHALL carry the finite Z_Score.
3. WHILE a Baseline is in Warm_Up, WHEN a Monitored_Signal is a Fixed_Threshold_Breach, THE Anomaly_Detector SHALL flag an Anomaly with detection method `fixed` and a Z_Score of `null`.
4. WHILE a Baseline is in Warm_Up, THE Anomaly_Detector SHALL flag a Monitored_Signal only when it is a Fixed_Threshold_Breach.
5. IF a Monitored_Signal value is less than or equal to the Baseline mean, THEN THE Anomaly_Detector SHALL NOT flag an Anomaly for that signal, because a latency, error ratio or memory value at or below normal is not a fault.
6. THE Anomaly_Detector SHALL compute the Z_Score with a standard deviation of at least `ANOMALY_MIN_STDDEV_LATENCY_MS` for `latencyP95Ms`, `ANOMALY_MIN_STDDEV_ERROR_RATIO` for `errorRatio` and `ANOMALY_MIN_STDDEV_RSS_MB` for `rssMb`, so that a Baseline with zero variance never produces an infinite or undefined Z_Score.
7. IF a Monitored_Signal value is `null` or not finite, THEN THE Anomaly_Detector SHALL NOT flag an Anomaly for that signal and SHALL return no Anomaly_Reading for it.
8. IF a Poll is a Blind_Poll, THEN THE Anomaly_Detector SHALL return an empty list of Anomaly_Readings.
9. IF a service is an Unknown_Service in a Poll, THEN THE Anomaly_Detector SHALL return no Anomaly_Readings for that service in that Poll.
10. FOR ALL Baselines and values, THE Anomaly_Detector SHALL return a Z_Score that is either a finite number or `null`, and never `NaN`, `Infinity` or `-Infinity`.
11. WHEN the Anomaly_Detector is called twice with the same Baselines, values and configuration, THE Anomaly_Detector SHALL return identical Anomaly_Readings both times, and SHALL leave the input Baselines unchanged.
12. WHILE a Baseline is not in Warm_Up, IF the Z_Score of a value is less than or equal to `ANOMALY_Z_THRESHOLD`, THEN THE Anomaly_Detector SHALL NOT flag an Anomaly for that signal, even when the value is a Fixed_Threshold_Breach.

### Requirement 4: Anomaly Reporting

**User Story:** As the haunted-house frontend, I want to know when a signal becomes anomalous and when it stops, so that I can drive sound and visuals from learned behavior.

#### Acceptance Criteria

1. WHEN a Poll completes, THE Engine SHALL include in the Cluster_Snapshot of that Poll an `anomalies` field containing the Anomaly_Readings of that Poll, ordered by Service_Chain order and then by signal order `latencyP95Ms`, `errorRatio`, `rssMb`, and containing an empty list when the Poll has no Anomaly.
2. WHEN a (service, signal) pair has an Anomaly in a non-blind Poll and had none in the previous non-blind Poll, THE Engine SHALL emit exactly one `anomaly:detected` event carrying the Anomaly_Reading of that pair.
3. WHEN a (service, signal) pair has an Anomaly in the first non-blind Poll after Engine startup, THE Engine SHALL treat the previous anomaly state of that pair as "no Anomaly" and emit one `anomaly:detected` event.
4. WHEN a (service, signal) pair has no Anomaly in a non-blind Poll and had one in the previous non-blind Poll, THE Engine SHALL emit exactly one `anomaly:cleared` event carrying the service name and the signal.
5. WHILE a (service, signal) pair has an Anomaly in consecutive non-blind Polls, THE Engine SHALL emit no further `anomaly:detected` event for that pair.
6. IF a Poll is a Blind_Poll, THEN THE Engine SHALL emit no `anomaly:detected` and no `anomaly:cleared` event, SHALL include an empty `anomalies` list in that Poll's Cluster_Snapshot, and SHALL keep the previous anomaly state unchanged for the next non-blind Poll.
7. IF a service is an Unknown_Service in a non-blind Poll and one of its signals had an Anomaly in the previous non-blind Poll, THEN THE Engine SHALL emit one `anomaly:cleared` event for each such (service, signal) pair in that Poll.
8. THE Engine SHALL NOT change any Health_Score, Service_Status, Breached_Kind, Dread value, attribution or Incident because of an Anomaly.

### Requirement 5: Memory Trend Fitting

**User Story:** As an on-call engineer, I want the Engine to estimate how fast a service's memory is growing, so that a leak is visible long before the container is killed.

#### Acceptance Criteria

1. WHEN a Poll runs and a Known_Service has a finite `rssMb` and `up` equal to true, THE Engine SHALL append a timestamped RSS sample (Poll timestamp and `rssMb`) to that service's RSS_Window and SHALL discard the oldest sample until the window holds at most `FORECAST_WINDOW_POLLS` samples.
2. IF a Known_Service has an `rssMb` that is `null` or not finite, or has `up` equal to false, in a Poll, THEN THE Engine SHALL NOT append an RSS sample to that service's RSS_Window in that Poll.
3. WHILE an RSS_Window holds at least `FORECAST_MIN_SAMPLES` samples, THE Trend_Fitter SHALL compute a Trend_Fit by least squares, using the Poll timestamps in seconds as the x values and RSS in MB as the y values, with the slope expressed in MB per second.
4. WHILE an RSS_Window holds fewer than `FORECAST_MIN_SAMPLES` samples, THE Trend_Fitter SHALL return no Trend_Fit.
5. IF all RSS values in an RSS_Window are equal, THEN THE Trend_Fitter SHALL return a slope of 0 and an R² of 0.
6. IF all timestamps in an RSS_Window are equal, THEN THE Trend_Fitter SHALL return no Trend_Fit.
7. THE Trend_Fitter SHALL return an R² in the range [0, 1] and a finite slope for every Trend_Fit.
8. FOR ALL RSS_Windows whose values are an exact line `a + b × t`, THE Trend_Fitter SHALL return a slope equal to `b` and an R² equal to 1, within a relative tolerance of 1e-6.
9. IF a Poll is a Blind_Poll, THEN THE Engine SHALL leave every RSS_Window unchanged in that Poll.
10. WHILE a service has an Open_Incident, THE Engine SHALL continue to update that service's RSS_Window, because a memory leak is itself the fault being forecast.
11. THE Trend_Fitter SHALL return the same Trend_Fit when called twice with the same RSS_Window, and SHALL NOT change its input RSS_Window.

### Requirement 6: Memory-Exhaustion Forecast Warning

**User Story:** As an on-call engineer, I want a warning with a time estimate before a service runs out of memory, so that I can act before it crashes.

#### Acceptance Criteria

1. WHEN a Trend_Fit has a slope greater than `FORECAST_MIN_SLOPE_MB_PER_S`, THE Forecaster SHALL compute Time_To_Limit in seconds as `(Memory_Limit_Mb − latest RSS) / slope`, using 0 when the latest RSS is at or above Memory_Limit_Mb.
2. WHEN a Poll produces a Trend_Fit with a Time_To_Limit below `FORECAST_WARN_SECONDS` and an R² of at least `FORECAST_MIN_R2` for a service that has no active Forecast_Warning, THE Forecaster SHALL set the Memory_Forecast of that service to a Forecast_Warning.
3. WHEN a Memory_Forecast becomes a Forecast_Warning, THE Engine SHALL emit exactly one `forecast:warning` event carrying that Memory_Forecast.
4. WHILE a Forecast_Warning remains active, THE Engine SHALL include the Memory_Forecast recomputed in the current Poll in every Cluster_Snapshot and SHALL emit no further `forecast:warning` event for that service.
5. WHEN the slope of a Trend_Fit is at most `FORECAST_MIN_SLOPE_MB_PER_S` while a Forecast_Warning is active, THE Forecaster SHALL clear the Forecast_Warning with the clearing reason `stopped-rising`.
6. WHEN a service restarts, THE Forecaster SHALL clear the Forecast_Warning of that service with the clearing reason `restarted` and SHALL empty its RSS_Window. A restart is detected when `up` is false for the service, or when `rssMb` falls by more than `FORECAST_RESTART_DROP_MB` compared with the previous RSS sample.
7. WHEN a Forecast_Warning is cleared, THE Engine SHALL emit exactly one `forecast:cleared` event carrying the service name and the clearing reason (`stopped-rising` or `restarted`).
8. IF a Trend_Fit has R² below `FORECAST_MIN_R2` and the service has no active Forecast_Warning, THEN THE Forecaster SHALL NOT start a Forecast_Warning from that Trend_Fit.
9. IF no Trend_Fit exists for a service, THEN THE Forecaster SHALL report a Memory_Forecast with `timeToLimitSeconds` equal to `null` and no Forecast_Warning.
10. IF a Poll is a Blind_Poll, THEN THE Engine SHALL keep every active Forecast_Warning unchanged and emit no `forecast:warning` or `forecast:cleared` event in that Poll.
11. THE Forecaster SHALL return a `timeToLimitSeconds` that is either `null` or a finite number greater than or equal to 0.
12. FOR ALL RSS_Windows with a positive slope, THE Forecaster SHALL return a Time_To_Limit that does not increase when the latest RSS increases with the slope held fixed, and does not increase when the slope increases with the latest RSS held fixed (monotonicity).
13. THE Engine SHALL include in every Cluster_Snapshot a `forecasts` field containing one Memory_Forecast for each Known_Service that has a Trend_Fit or an active Forecast_Warning, in Service_Chain order, and SHALL omit Known_Services that have neither.

### Requirement 7: Incident Feature Vectors

**User Story:** As a developer, I want each incident turned into a fixed-length numeric vector, so that incidents can be compared mathematically.

#### Acceptance Criteria

1. WHEN the Feature_Extractor is given an Incident, THE Feature_Extractor SHALL return a Feature_Vector whose length is `2 × N + 4 + 3 + 1`, where `N` is the number of Known_Services in the Service_Chain, and whose entries are in this order: (a) `N` entries one-hot encoding the Root_Service in Service_Chain order (1 at the index of the Root_Service, 0 elsewhere), (b) `N` entries holding 1 for each Known_Service that is an Affected_Service and 0 otherwise, in Service_Chain order, (c) 4 entries holding 1 or 0 for the Signal_Kinds `latency`, `errors`, `memory` and `down`, in that order, where 1 means the Incident has that kind, (d) 3 entries holding the peak latency, peak error ratio and peak RSS, in that order, each normalized per Criterion 2, and (e) 1 entry holding the duration normalized per Criterion 3.
2. THE Feature_Extractor SHALL normalize peak latency as peak latency divided by `LATENCY_CRITICAL_MS`, peak error ratio as peak error ratio divided by `ERROR_RATIO_CRITICAL`, and peak RSS as peak RSS divided by `MEMORY_LIMIT_MB`, clamping each result to the range [0, 1] and using 0 for a peak that is `null`.
3. THE Feature_Extractor SHALL normalize duration as the Incident duration in seconds divided by `SIMILARITY_DURATION_CAP_SECONDS` (default 300), clamped to the range [0, 1].
4. WHILE an Incident is open, THE Feature_Extractor SHALL compute the Incident duration as the elapsed time in seconds between the time the Incident opened and the current Poll time supplied as an argument, so that the duration of an Incident at the Poll in which it opens is 0. The weight given to the duration entry in similarity comparison is left to the design phase.
5. IF the Root_Service of an Incident is not a Known_Service, THEN THE Feature_Extractor SHALL set every entry of the Root_Service one-hot group to 0 and SHALL still return a Feature_Vector of the length given in Criterion 1.
6. THE Feature_Extractor SHALL produce Feature_Vectors whose entries are all finite numbers in the range [0, 1].
7. WHEN the Feature_Extractor is given two Incidents that have the same Root_Service, Affected_Services, Signal_Kinds, peaks and duration but different ids and timestamps, THE Feature_Extractor SHALL return equal Feature_Vectors for the two Incidents.
8. WHEN the Feature_Extractor is called twice with the same Incident, Service_Chain, Poll time and configuration, THE Feature_Extractor SHALL return equal Feature_Vectors and SHALL NOT change its input Incident.

### Requirement 8: Incident Similarity Matching

**User Story:** As an on-call engineer, I want to be told which past incident this one looks most like, even when the fingerprint differs, so that I can reuse what I learned last time.

#### Acceptance Criteria

1. WHEN the Similarity_Matcher is given two Feature_Vectors of equal length, THE Similarity_Matcher SHALL return their Cosine_Similarity as a finite number in the range [0, 1] (the entries are non-negative).
2. FOR ALL Feature_Vectors `a` and `b` of equal length, THE Similarity_Matcher SHALL return the same Cosine_Similarity for `(a, b)` and `(b, a)` (symmetry).
3. FOR ALL non-zero Feature_Vectors `a`, THE Similarity_Matcher SHALL return a Cosine_Similarity of 1 for `(a, a)`, within a tolerance of 1e-9.
4. IF either Feature_Vector has a norm of 0, THEN THE Similarity_Matcher SHALL return a Cosine_Similarity of 0.
5. IF two Feature_Vectors have different lengths, THEN THE Similarity_Matcher SHALL return a Cosine_Similarity of 0 and SHALL NOT throw an error.
6. WHEN an Incident opens, THE Engine SHALL compare the Feature_Vector of the opened Incident with the Feature_Vectors of all resolved Incidents in the incident history, and SHALL set the similar-incident field of the opened Incident to the Similar_Incident record, or to `null` under Criterion 10.
7. THE Similarity_Matcher SHALL select the resolved Incident with the highest Cosine_Similarity, and, WHEN two or more resolved Incidents have the same highest Cosine_Similarity, SHALL select the one with the latest resolution time.
8. THE Engine SHALL consider an Incident a Similar_Incident only when its Cosine_Similarity is greater than or equal to `SIMILARITY_THRESHOLD`, and SHALL compare the unrounded value with the threshold.
9. WHEN the Engine attaches a Similar_Incident to an Incident, THE Engine SHALL set the similar-incident field to a record containing the matched Incident's id, its Fingerprint, its resolution time, its duration in seconds, and its Cosine_Similarity rounded to 3 decimal places.
10. IF no resolved Incident has a Cosine_Similarity greater than or equal to `SIMILARITY_THRESHOLD`, or the incident history contains no resolved Incident, THEN THE Engine SHALL set the similar-incident field of the Incident to `null`.
11. WHEN an Incident resolves, THE Engine SHALL recompute the similar-incident field of that Incident from its final Feature_Vector against all other resolved Incidents (excluding the resolving Incident itself), and SHALL include the recomputed field in the `incident:resolved` event.
12. THE Engine SHALL keep the existing Recurrence field and its Fingerprint-based computation unchanged, so that an Incident can carry a Recurrence, a Similar_Incident, both or neither.
13. THE Engine SHALL NOT change the Feature_Vector, Fingerprint, status or any other field of any resolved Incident in the incident history when computing a similar-incident field.
14. IF the Similarity_Matcher or Feature_Extractor throws an unexpected error while computing the similar-incident field, THEN THE Engine SHALL set that field to `null`, log the error with its stack, and still open or resolve the Incident and emit its event.

### Requirement 9: Pure Functions and Pipeline Integration

**User Story:** As a developer, I want all new analysis written as pure functions that plug into the existing Poll pipeline, so that whole Poll sequences can be replayed in tests and the architecture stays consistent.

#### Acceptance Criteria

1. THE Engine SHALL implement the Baseline_Updater, Anomaly_Detector, Trend_Fitter, Forecaster, Feature_Extractor and Similarity_Matcher as pure functions that perform no I/O, start no timers, read no clock and hold no shared state.
2. THE Engine SHALL give each pure function the time, configuration and previous Intelligence_State it needs as arguments, and SHALL have each function return a new Intelligence_State without changing its arguments, so that every argument is deeply equal before and after the call.
3. THE Poller SHALL be the only component that stores the Intelligence_State.
4. WHEN a Poll runs, THE Poller SHALL run the intelligence steps inside the existing per-Poll pipeline after health scoring and incident tracking and before the Cluster_Snapshot is stored and emitted.
5. THE Engine SHALL place the new code under `haunting-engine/src/intelligence/`, organized into the folders `anomaly`, `forecast` and `similarity`, with each `*.spec.ts` test file in the same folder as the file it tests.
6. IF an intelligence step throws an unexpected error, THEN THE Poller SHALL log the error with its stack trace, keep the Intelligence_State that it held before that Poll, and still store and emit the Cluster_Snapshot in the same Poll with every pre-existing field unchanged, and with `anomalies` and `forecasts` set to empty arrays, and no `anomaly:*` or `forecast:*` event emitted for that Poll.
7. THE Engine SHALL keep every existing event, REST route and Cluster_Snapshot field with its current name, type and meaning, so that existing consumers keep working.
8. FOR ALL Poll sequences, THE Engine SHALL produce an Intelligence_State and a list of emitted `anomaly:*` and `forecast:*` events that depend only on the input sequence, the Poll timestamps carried in that sequence and the configuration, and not on wall-clock time, so that replaying the same sequence twice gives deeply equal results.

### Requirement 10: Shared Types

**User Story:** As the haunted-house frontend, I want anomaly, forecast and similarity data typed in one shared place, so that I consume them without redefining anything.

#### Acceptance Criteria

1. THE Shared_Package SHALL define the types `MonitoredSignal`, `AnomalyReading`, `MemoryForecast`, `ForecastClearReason` and `SimilarIncident`.
2. THE Shared_Package SHALL define `MonitoredSignal` as the union of `latencyP95Ms`, `errorRatio` and `rssMb`, and `ForecastClearReason` as the union of `stopped-rising` and `restarted`.
3. THE Shared_Package SHALL add an `anomalies: AnomalyReading[]` field and a `forecasts: MemoryForecast[]` field to `ClusterSnapshot`.
4. THE Shared_Package SHALL add a `similar: SimilarIncident | null` field to `Incident`.
5. THE Shared_Package SHALL add the events `anomaly:detected`, `anomaly:cleared`, `forecast:warning` and `forecast:cleared` to `ServerToClientEvents`, each with a payload type defined in the Shared_Package. The payloads SHALL be: an `AnomalyReading` for `anomaly:detected`; the service name and `MonitoredSignal` for `anomaly:cleared`; a `MemoryForecast` for `forecast:warning`; and the service name and `ForecastClearReason` for `forecast:cleared`.
6. THE Engine SHALL import every new type that it sends to the frontend from the Shared_Package and SHALL NOT redeclare any of them.
7. THE Shared_Package SHALL continue to contain only type declarations and SHALL compile to declaration files only, with zero emitted `.js` files in its build output.
8. FOR ALL Cluster_Snapshots and Incidents that the Engine produces, serializing to JSON and parsing back SHALL produce a value deeply equal to the original (round-trip property), which requires that no new field contains `NaN`, `Infinity` or `undefined`. A value that is absent SHALL be represented as `null`.
9. WHEN a frontend client connects, THE Engine SHALL send it the latest Cluster_Snapshot, which already carries the current anomalies and forecasts, so that a late joiner sees active warnings without waiting for a new event.
10. IF no Cluster_Snapshot has been stored yet when a frontend client connects, THEN THE Engine SHALL send no Cluster_Snapshot to that client and SHALL send the first Cluster_Snapshot to it when the first Poll completes.

### Requirement 11: Configuration

**User Story:** As a developer, I want every new setting configurable through environment variables with safe defaults, so that thresholds can be tuned for the demo without code changes.

#### Acceptance Criteria

1. WHEN `loadEngineConfig` runs and a variable listed in this criterion is unset or an empty string, THE Engine SHALL use the default given here: `ANOMALY_ALPHA` (0.1), `ANOMALY_Z_THRESHOLD` (3), `ANOMALY_WARMUP_POLLS` (30), `ANOMALY_MIN_STDDEV_LATENCY_MS` (5), `ANOMALY_MIN_STDDEV_ERROR_RATIO` (0.005), `ANOMALY_MIN_STDDEV_RSS_MB` (2), `MEMORY_LIMIT_MB` (256), `FORECAST_WINDOW_POLLS` (30), `FORECAST_MIN_SAMPLES` (10), `FORECAST_MIN_R2` (0.8), `FORECAST_MIN_SLOPE_MB_PER_S` (0.05), `FORECAST_WARN_SECONDS` (60), `FORECAST_RESTART_DROP_MB` (20), `SIMILARITY_THRESHOLD` (0.85) and `SIMILARITY_DURATION_CAP_SECONDS` (300).
2. WHEN `loadEngineConfig` runs and a variable listed in Criterion 1 is set to a valid value, THE Engine SHALL use that value instead of the default.
3. IF `ANOMALY_ALPHA` is not a finite number in the range (0, 1], THEN THE Engine SHALL exit at startup with a non-zero exit code and an error message naming `ANOMALY_ALPHA`.
4. IF `FORECAST_MIN_R2` or `SIMILARITY_THRESHOLD` is not a finite number in the range [0, 1], THEN THE Engine SHALL exit at startup with a non-zero exit code and an error message naming the offending variable.
5. IF `ANOMALY_WARMUP_POLLS`, `FORECAST_WINDOW_POLLS`, `FORECAST_MIN_SAMPLES` or `SIMILARITY_DURATION_CAP_SECONDS` is not a positive integer (a whole number of at least 1), THEN THE Engine SHALL exit at startup with a non-zero exit code and an error message naming the offending variable.
6. IF `ANOMALY_Z_THRESHOLD`, any `ANOMALY_MIN_STDDEV_*` value, `MEMORY_LIMIT_MB`, `FORECAST_MIN_SLOPE_MB_PER_S`, `FORECAST_WARN_SECONDS` or `FORECAST_RESTART_DROP_MB` is not a finite number greater than 0, THEN THE Engine SHALL exit at startup with a non-zero exit code and an error message naming the offending variable.
7. IF `FORECAST_MIN_SAMPLES` is greater than `FORECAST_WINDOW_POLLS`, THEN THE Engine SHALL exit at startup with a non-zero exit code and an error message naming `FORECAST_MIN_SAMPLES`.
8. IF `MEMORY_LIMIT_MB` is not greater than `MEMORY_CRITICAL_MB`, THEN THE Engine SHALL exit at startup with a non-zero exit code and an error message naming `MEMORY_LIMIT_MB`.
9. IF more than one validation rule in Criteria 3 to 8 is violated, THEN THE Engine SHALL exit at startup with an error message naming every offending variable.
10. THE Engine SHALL list every variable from Criterion 1 in `haunting-engine/.env.example` with its default and a one-line description.
11. THE Engine SHALL pass every variable from Criterion 1 through the `haunting-engine` service in `docker-compose.yml` using the form `${NAME:-default}` with the same default as `.env.example` and Criterion 1.
12. THE Engine SHALL contain no hardcoded value for any setting listed in Criterion 1 outside the configuration module.

### Requirement 12: Property-Based Testing

**User Story:** As a developer, I want the core learning logic covered by property tests, so that edge cases in the math are found before a demo does.

#### Acceptance Criteria

1. THE Engine SHALL include a fast-check property test file for each of the Baseline_Updater, Anomaly_Detector, Trend_Fitter, Forecaster, Feature_Extractor and Similarity_Matcher, placed next to the file it tests, and each property test SHALL run at least 100 iterations.
2. THE Engine SHALL tag every property test with a comment of the form `// Feature: engine-intelligence, Property <N>: <text>`, where `<N>` is a positive integer that is unique across all property tests of this feature and `<text>` is a non-empty statement of the property.
3. THE Engine SHALL include one property test for each of the following properties, and each test SHALL fail when the stated property is violated:
   - baseline variance is never less than 0, and baseline mean and variance stay finite (R1.6)
   - Baselines are unchanged when any learning guard in Requirement 2 applies (R2)
   - Z_Scores are finite or `null` (R3.10)
   - no Anomaly is flagged during Warm_Up unless it is a Fixed_Threshold_Breach (R3.4)
   - the Trend_Fitter recovers the slope and R² of an exact line within a relative tolerance of 1e-6 (R5.8)
   - R² lies in [0, 1] (R5.7)
   - `timeToLimitSeconds` is `null` or a finite number greater than or equal to 0 (R6.11)
   - Time_To_Limit does not increase when the latest RSS or the slope increases, holding the other value fixed (R6.12)
   - no Forecast_Warning starts from a Trend_Fit with R² below `FORECAST_MIN_R2` (R6.8)
   - Feature_Vector entries are finite and lie in [0, 1] (R7.6)
   - Cosine_Similarity is symmetric, lies in [0, 1], and equals 1 within 1e-9 for identical non-zero vectors (R8.1 to R8.3)
   - the selected Similar_Incident always has a Cosine_Similarity of at least `SIMILARITY_THRESHOLD` (R8.8)
   - serializing Cluster_Snapshots and Incidents to JSON and parsing back produces a value equal to the original (R10.8)
4. THE Engine SHALL include a property test that generates Poll sequences containing Blind_Polls, Unknown_Services and Open_Incidents, and asserts that the Baselines after the full sequence are equal to the Baselines obtained by replaying only the Polls for which no learning guard applies (R2.8).
5. THE Engine SHALL include a unit test for `loadEngineConfig` that asserts every default value listed in Requirement 11 Criterion 1 and asserts that each rejection case in Requirement 11 Criteria 3 to 8 causes startup to fail with a message naming the offending variable.

### Requirement 13: Boot and Module Wiring

**User Story:** As a developer, I want proof that the whole Engine still boots with the new layer, so that wiring mistakes that per-class tests miss are caught.

#### Acceptance Criteria

1. THE Engine SHALL include a Jest test that builds the full `AppModule` with the intelligence providers registered, calls `app.init()`, and passes only if `app.init()` resolves without throwing.
2. WHEN an implementation milestone ends, THE Engine SHALL have completed a real boot, meaning the build exits with code 0, the Engine process starts, and `GET /health` returns a success response within 30 seconds of process start.
3. IF the build fails, the Engine process exits before `GET /health` succeeds, or `GET /health` does not return a success response within 30 seconds of process start, THEN THE milestone SHALL be treated as not complete and the failure SHALL be reported with the build or startup error output.
4. WHEN the Engine starts with only the environment variables that were required before this feature, THE Engine SHALL start successfully and SHALL use the default value listed in Requirement 11 for each new variable.
5. WHEN `docker compose up` is executed, THE `haunting-engine` container SHALL report a healthy status within 30 seconds, and THE Engine SHALL emit a Cluster_Snapshot containing both the `anomalies` field and the `forecasts` field within 30 seconds of the container becoming healthy.
6. IF the `haunting-engine` container is not healthy, or no Cluster_Snapshot containing the `anomalies` and `forecasts` fields has been emitted, within the time limits in Criterion 5, THEN THE check SHALL be reported as failed.

### Requirement 14: Integration Test for Memory Leak Forecast Lead Time

**User Story:** As a hackathon judge, I want proof that the Engine warns about a memory leak before the service crashes, so that I can trust the forecast.

#### Acceptance Criteria

1. WHEN the integration test starts against the running stack, THE Engine test suite SHALL inject a memory leak into `payments` through the Chaos_Proxy and SHALL poll the Engine for the latest Cluster_Snapshot every 1 second until `payments` has Service_Status `down` or `INTEGRATION_LEAK_TIMEOUT_SECONDS` (default 300, positive integer) elapses, whichever comes first.
2. THE integration test SHALL be located in `haunting-engine/test/`.
3. WHEN the test first observes a Cluster_Snapshot whose `forecasts` field contains a Forecast_Warning for `payments`, THE test SHALL record the timestamp of that Cluster_Snapshot as the warning time.
4. WHEN the test first observes `payments` with Service_Status `down` or with RSS at or above Memory_Limit_Mb, THE test SHALL record the timestamp of that Cluster_Snapshot as the crash time.
5. WHEN both a warning time and a crash time have been recorded, THE test SHALL assert that the warning time is earlier than the crash time and SHALL compute the lead time as the crash time minus the warning time, in seconds.
6. WHEN the lead time is computed, THE test SHALL assert that the lead time is greater than 0 seconds and SHALL write the lead time in seconds to the test output.
7. WHEN the final checkpoint of the implementation is reached, THE design document SHALL record the measured lead time in seconds.
8. IF `payments` has not crashed when `INTEGRATION_LEAK_TIMEOUT_SECONDS` elapses, THEN THE test SHALL assert that a Forecast_Warning for `payments` was observed, SHALL write to the test output a message stating that no crash occurred, and SHALL NOT fail for the absence of a crash.
9. IF no Forecast_Warning for `payments` is observed before the crash time or before the timeout, THEN THE test SHALL fail with a message stating that no forecast warning was observed.
10. WHEN the test finishes, whether it passed, failed or timed out, THE test SHALL call `POST /api/chaos/reset-all` so that other tests start from a clean state.
11. IF the stack is not running, THEN THE test SHALL be skipped with a message stating that the stack is required, in the same way as the existing integration tests.

### Requirement 15: Assessment of the Known Open Issue

**User Story:** As a maintainer, I want to know whether the new layer helps with the missed or misattributed outage after a fast payments restart, so that I can decide what to build next with evidence.

#### Acceptance Criteria

1. THE design document SHALL contain a section titled "Assessment: known open issue" that states one conclusion for anomaly baselines and one conclusion for memory forecasting, each being exactly one of "reduces the issue", "does not reduce the issue" or "reduces the issue only in part, with the remaining gap named".
2. THE "Assessment: known open issue" section SHALL explain the mechanism behind each conclusion by referring to both behaviors recorded in the haunting-engine design: failed requests staying in the 15 s `RATE_WINDOW` after a fast payments restart, and attribution moving from payments to orders or gateway.
3. THE "Assessment: known open issue" section SHALL state, for each conclusion, whether it rests on analysis alone or on a measurement, and SHALL list by name every measurement that was considered and not performed (or state that none applies).
4. IF the assessment concludes that neither anomaly baselines nor memory forecasting reduces the issue, THEN THE design document SHALL state in the assessment section that neither reduces it and SHALL leave the issue listed as open under "Known open issues" in `roadmap.md`.
5. THE Engine SHALL NOT use Anomalies or Forecast_Warnings to change attribution or Incident lifecycle rules as part of this feature, regardless of the assessment result.
