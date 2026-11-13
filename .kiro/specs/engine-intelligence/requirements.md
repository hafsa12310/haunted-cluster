# Requirements Document

## Introduction

The haunting-engine is rule-based today: it scores each service against fixed thresholds, attributes faults, tracks incidents and flags recurrence by exact Fingerprint match. The engine-intelligence feature adds a small learned layer on top of that pipeline, with three capabilities:

1. **Learned anomaly detection.** For each service and each of three signals (p95 latency, error ratio, RSS), the Engine learns what "normal" looks like with an exponentially weighted mean and variance, and flags a signal when its z-score is too high. Until a baseline has seen enough samples, the Engine falls back to the existing fixed thresholds. Baselines never learn from blind Polls, unknown services, open incidents, or samples that are themselves anomalous, so chaos is never learned as normal. To avoid flapping, a flag must persist for several consecutive Polls before it is reported (hysteresis), and clear for the same number of Polls before the report ends. If a signal stays anomalous for a long time with no open incident, the Engine concludes that the signal has a new normal and relearns that baseline from scratch. The one exception is the RSS signal of a service whose memory is being forecast as leaking: that baseline is not relearned while the leak is suspected, so a memory leak is never relearned as the new normal.
2. **Memory-exhaustion forecasting.** For each service the Engine fits a linear trend to recent RSS samples and estimates how many seconds remain until RSS reaches the container memory limit. It emits a warning before the limit is reached and clears it when memory stops rising or when RSS drops sharply (a restart, or leaked memory being freed).
3. **Incident similarity.** Each Incident is described as a numeric feature vector, and the Engine finds the most similar resolved Incident by cosine similarity. This sits alongside, and does not replace, the existing Fingerprint recurrence.

All new analysis logic is written as pure functions (no I/O, no timers, no shared state) and plugged into the existing `PollerService` per-Poll pipeline, which remains the only writer of engine state. New events and snapshot fields are defined once in `shared/` so the haunted-house frontend can consume them. Every new setting comes from environment variables with documented defaults.

The feature does not change how Health_Score, Service_Status, Breached_Kinds, Dread, attribution or the Incident lifecycle are computed. Anomalies, forecasts and similar incidents are additional information, not new inputs to those decisions.

The feature also assesses whether baselines or forecasting could reduce the known open issue recorded in `roadmap.md` and in the haunting-engine design (after a fast payments restart, failed requests stay in the rate window, so the Engine can miss the outage or blame orders or gateway). The assessment is a documentation deliverable of the design phase.

**Out of scope for this spec:** persisting baselines, forecasts or incident history across Engine restarts; training from external datasets or any non-in-process model; the haunted-house frontend and audio; the ghost narrator; changing the existing scoring, attribution or incident lifecycle rules; fixing the known open issue itself.

## Glossary

- **Engine**: The haunting-engine NestJS application.
- **Victim_App**: The NestJS monorepo in `victim-app/` (gateway, orders and payments services) that the Engine monitors.
- **Memory_Gauge**: The Victim_App `MetricsService` timer that refreshes the `process_heap_used_bytes` and `process_rss_bytes` gauges.
- **Poller**: The Engine's `PollerService`, the only component that changes Engine state.
- **Poll**: One cycle in which the Engine queries Prometheus, scores every service, updates incidents and emits events.
- **Blind_Poll**: A Poll in which Prometheus was unavailable, so `metricsAvailable` is false and every service is `unknown`.
- **Shared_Package**: The `shared/` types-only package (`@haunted-cluster/shared`).
- **Service_Chain**: The ordered list of monitored services read from `SERVICE_CHAIN`.
- **Known_Service**: A service listed in the Service_Chain.
- **Unknown_Service**: A service that is not a Known_Service, or a Known_Service whose Service_Status is `unknown` in the current Poll.
- **Down_Service**: A Known_Service that is not an Unknown_Service and has `up` equal to false in a non-blind Poll (for example during a crash or restart).
- **Open_Incident**: An Incident with status `open` whose Root_Service is the service in question.
- **Monitored_Signal**: One of `latencyP95Ms`, `errorRatio` or `rssMb`.
- **Fixed_Threshold_Breach**: A Monitored_Signal whose Badness for the matching kind (`latency`, `errors`, `memory`) is greater than `0.2`, as computed by the existing health scoring.
- **Baseline**: For one (service, Monitored_Signal) pair, the exponentially weighted mean, exponentially weighted variance and the count of samples learned so far.
- **Baseline_Sample**: A Monitored_Signal value that the Engine has used to update a Baseline.
- **Alpha**: The EWMA smoothing factor `ANOMALY_ALPHA`, in (0, 1].
- **Z_Score**: For a Monitored_Signal value `x` and a Baseline with mean `m` and standard deviation `s`, `(x − m) / max(s, floor)`, where `floor` is the configured minimum standard deviation for that signal.
- **Warm_Up**: The state of a Baseline whose Baseline_Sample count is below `ANOMALY_WARMUP_POLLS`.
- **Raw_Anomaly**: A Monitored_Signal flagged for a (service, signal) pair in a single Poll, either because its Z_Score is above `ANOMALY_Z_THRESHOLD` (learned detection) or, during Warm_Up, because it is a Fixed_Threshold_Breach. A Raw_Anomaly is the unconfirmed, per-Poll flag.
- **Confirmed_Anomaly**: A (service, signal) pair that has had a Raw_Anomaly in at least `ANOMALY_CONFIRM_POLLS` consecutive non-blind Polls and has not since had `ANOMALY_CONFIRM_POLLS` consecutive non-blind Polls without a Raw_Anomaly. Only Confirmed_Anomalies are reported in the Cluster_Snapshot and in `anomaly:*` events.
- **Anomalous_Streak**: For one (service, signal) pair, the number of consecutive evaluated non-blind Polls that ended with a Raw_Anomaly.
- **Clear_Streak**: For one (service, signal) pair, the number of consecutive evaluated non-blind Polls that ended without a Raw_Anomaly.
- **Anomaly_Reading**: The record of one Raw_Anomaly (and, when the pair is a Confirmed_Anomaly, the most recent such record for that pair): service, signal, value, baseline mean, baseline standard deviation, Z_Score (null during Warm_Up), and the detection method (`learned` or `fixed`).
- **Relearn_Reset**: The reset of one Baseline to a sample count of 0 under Requirement 4, which returns that Baseline to Warm_Up. A Relearn_Reset is performed only when the Anomalous_Streak has reached `ANOMALY_RELEARN_POLLS`, the service had no Open_Incident in the pre-Poll incident state, and, for the `rssMb` signal, the service has no Leak_Suspicion in the current Poll (Requirement 4, Criteria 8 and 14).
- **Memory_Limit_Mb**: The memory limit the forecast counts down to, `MEMORY_LIMIT_MB` (default 290, just below the measured OOM kill point of about 296 MB RSS for a 256 MiB container).
- **RSS_Window**: The last `FORECAST_WINDOW_POLLS` timestamped RSS samples of one service.
- **Trend_Fit**: A least-squares line through an RSS_Window with its slope (MB per second) and coefficient of determination R².
- **Time_To_Limit**: `(Memory_Limit_Mb − latest RSS) / slope`, in seconds, for a Trend_Fit with positive slope.
- **Memory_Forecast**: The per-Poll record for one service: slope, R², latest RSS, Time_To_Limit, and whether a forecast warning is active. A service has a Memory_Forecast only while it has a Trend_Fit or an active Forecast_Warning; a service with neither has no Memory_Forecast and no entry in the `forecasts` field.
- **Memory_Drop**: For one service in a Poll, either `up` equal to false, or an `rssMb` that is lower than the previous RSS sample of that service by more than `FORECAST_RESTART_DROP_MB`. A Memory_Drop can result from a restart or from leaked memory being freed.
- **Forecast_Warning**: The state of a Memory_Forecast in which Time_To_Limit is below `FORECAST_WARN_SECONDS` and the Trend_Fit quality is sufficient.
- **Leak_Suspicion**: The state of a Known_Service in a Poll in which, in the Memory_Forecast of that service as produced by the forecast step of that same Poll (after RSS_Window update, Memory_Drop handling, Trend_Fit and Forecaster), a Forecast_Warning is active or the Trend_Fit has a slope greater than `FORECAST_MIN_SLOPE_MB_PER_S`. A Forecast_Warning cleared in that Poll is not active, and a service without a Trend_Fit and without an active Forecast_Warning has no Leak_Suspicion. In a Blind_Poll no state is evaluated (see Requirement 4, Criterion 7).
- **Feature_Vector**: The numeric description of an Incident used for similarity matching.
- **Comparison_Vector**: The Feature_Vector of an Incident without its last entry (the duration entry). The Comparison_Vector is used when an Incident is matched at open time (Requirement 8, Criterion 6).
- **Cosine_Similarity**: The dot product of two Feature_Vectors divided by the product of their norms, defined as 0 when either norm is 0.
- **Similar_Incident**: The resolved Incident with the highest Cosine_Similarity to a given Incident, provided it is at least `SIMILARITY_THRESHOLD`.
- **Recurrence**: The existing Fingerprint-based record on an Incident (unchanged by this feature).
- **Intelligence_State**: The state held by the Engine between Polls: the Baselines; for each (service, signal) pair the Anomalous_Streak, the Clear_Streak, the Confirmed_Anomaly flag and the most recent Anomaly_Reading; the RSS_Windows; the active Forecast_Warnings; and the Memory_Forecasts of the last non-blind Poll.
- **Baseline_Updater**: The pure function that applies one Baseline_Sample to one Baseline.
- **Anomaly_Detector**: The pure function that turns Baselines and current signal values into Anomaly_Readings (Raw_Anomalies).
- **Anomaly_Tracker**: The pure function that applies the streak, confirmation and relearning rules to the Raw_Anomalies of one Poll, taking as inputs the previous streaks and flags, the pre-Poll Open_Incident state and the Memory_Forecasts of the same Poll (to determine Leak_Suspicion) and the state of each pair in the Poll (evaluated, belonging to an Unknown_Service or a Down_Service, or carrying an unusable value), and returns the new streaks, the Confirmed_Anomalies, the events to emit and the (service, signal) pairs whose Baseline is to be relearned.
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
9. WHEN the Baseline_Updater is asked to reset a Baseline, THE Baseline_Updater SHALL return a new Baseline with a sample count of 0, a mean of 0 and a variance of 0, so that the next Baseline_Sample is handled as the first sample under Criterion 3.

### Requirement 2: Baseline Learning Guards

**User Story:** As an on-call engineer, I want baselines to ignore faults, so that chaos is never learned as normal.

#### Acceptance Criteria

1. IF a Poll is a Blind_Poll, THEN THE Engine SHALL leave every Baseline, including its mean, variance and sample count, unchanged in that Poll.
2. IF a service is an Unknown_Service in a Poll, THEN THE Engine SHALL leave every Baseline of that service, including its mean, variance and sample count, unchanged in that Poll.
3. WHILE a service has an Open_Incident, THE Engine SHALL leave every Baseline of that service, including its mean, variance and sample count, unchanged in every Poll.
4. IF a Monitored_Signal value is `null` or not finite, THEN THE Engine SHALL leave the Baseline for that signal unchanged in that Poll and SHALL leave the Baselines of the service's other Monitored_Signals subject only to the guards that apply to them.
5. IF a service has `up` equal to false in a Poll, THEN THE Engine SHALL leave every Baseline of that service unchanged in that Poll.
6. IF a Monitored_Signal is flagged as a Raw_Anomaly in a Poll, THEN THE Engine SHALL leave the Baseline for that signal unchanged in that Poll, whether the Raw_Anomaly was detected by method `learned` or `fixed`. This guard SHALL use the raw (unconfirmed) flag of the current Poll, so that the first Raw_Anomaly of a pair is never learned while it is still waiting for confirmation under Requirement 4.
7. WHEN the Engine evaluates the Open_Incident guard in Criterion 3 for a Poll, THE Engine SHALL use the Incident state held before that Poll's incident tracking step, so that an Incident opened or resolved in the current Poll does not change the guard result for that Poll.
8. WHEN none of the guards in Criteria 1 to 6 applies to a (service, Monitored_Signal) pair in a Poll, THE Engine SHALL apply the signal value of that Poll as exactly one Baseline_Sample to that Baseline.
9. IF a guard in Criteria 1 to 5 applies, THEN THE Engine SHALL NOT apply a Baseline_Sample to the guarded Baseline and SHALL NOT reset the Baseline, so that the sample count after the Poll equals the sample count before it. IF the guard in Criterion 6 applies, THEN THE Engine SHALL NOT apply a Baseline_Sample to the guarded Baseline and SHALL reset it only through a Relearn_Reset under Requirement 4, Criterion 8, which for the `rssMb` signal is itself subject to the Leak_Suspicion rule of Requirement 4, Criterion 14.

### Requirement 3: Raw Anomaly Detection

**User Story:** As an on-call engineer, I want a signal flagged when it is statistically unusual for that service, so that I hear trouble early. This requirement covers the per-Poll raw flag only; confirmation is covered by Requirement 4.

#### Acceptance Criteria

1. WHEN a Poll runs and a Monitored_Signal value is finite for a Known_Service that is neither an Unknown_Service nor a Down_Service, THE Anomaly_Detector SHALL compute the Z_Score of that value against the Baseline of that service and signal as it was before the current Poll's Baseline_Sample is applied.
2. WHILE a Baseline is not in Warm_Up (its Baseline_Sample count is at least `ANOMALY_WARMUP_POLLS`), WHEN the Z_Score of a value is greater than `ANOMALY_Z_THRESHOLD`, THE Anomaly_Detector SHALL flag a Raw_Anomaly with detection method `learned`, and the Anomaly_Reading SHALL carry the finite Z_Score.
3. WHILE a Baseline is in Warm_Up, WHEN a Monitored_Signal is a Fixed_Threshold_Breach, THE Anomaly_Detector SHALL flag a Raw_Anomaly with detection method `fixed` and a Z_Score of `null`.
4. WHILE a Baseline is in Warm_Up, THE Anomaly_Detector SHALL flag a Monitored_Signal only when it is a Fixed_Threshold_Breach.
5. IF a Monitored_Signal value is less than or equal to the Baseline mean, THEN THE Anomaly_Detector SHALL NOT flag a Raw_Anomaly for that signal, because a latency, error ratio or memory value at or below normal is not a fault.
6. THE Anomaly_Detector SHALL compute the Z_Score with a standard deviation of at least `ANOMALY_MIN_STDDEV_LATENCY_MS` for `latencyP95Ms`, `ANOMALY_MIN_STDDEV_ERROR_RATIO` for `errorRatio` and `ANOMALY_MIN_STDDEV_RSS_MB` for `rssMb`, so that a Baseline with zero variance never produces an infinite or undefined Z_Score.
7. IF a Monitored_Signal value is `null` or not finite, THEN THE Anomaly_Detector SHALL NOT flag a Raw_Anomaly for that signal and SHALL return no Anomaly_Reading for it.
8. IF a Poll is a Blind_Poll, THEN THE Anomaly_Detector SHALL return an empty list of Anomaly_Readings. An empty list from a Blind_Poll SHALL NOT be treated by the Anomaly_Tracker as a Poll without Raw_Anomalies (see Requirement 4, Criterion 7).
9. IF a service is an Unknown_Service or a Down_Service in a Poll, THEN THE Anomaly_Detector SHALL return no Anomaly_Readings for that service in that Poll. This empty result SHALL be handled by the Anomaly_Tracker under Requirement 4, Criterion 10 (Unknown_Service) or Criterion 11 (Down_Service).
10. FOR ALL Baselines and values, THE Anomaly_Detector SHALL return a Z_Score that is either a finite number or `null`, and never `NaN`, `Infinity` or `-Infinity`.
11. WHEN the Anomaly_Detector is called twice with the same Baselines, values and configuration, THE Anomaly_Detector SHALL return identical Anomaly_Readings both times, and SHALL leave the input Baselines unchanged.
12. WHILE a Baseline is not in Warm_Up, IF the Z_Score of a value is less than or equal to `ANOMALY_Z_THRESHOLD`, THEN THE Anomaly_Detector SHALL NOT flag a Raw_Anomaly for that signal, even when the value is a Fixed_Threshold_Breach.

### Requirement 4: Anomaly Confirmation, Reporting and Relearning

**User Story:** As the haunted-house frontend, I want to be told only about anomalies that persist, and to know when they stop, so that sound and visuals follow real behavior and do not flicker on a single noisy Poll.

#### Acceptance Criteria

1. THE Anomaly_Tracker SHALL keep, for each (service, signal) pair, an Anomalous_Streak, a Clear_Streak, a Confirmed_Anomaly flag and the most recent Anomaly_Reading of that pair, all starting at 0, false and `null` when the Engine starts.
2. WHEN a (service, signal) pair is evaluated in a non-blind Poll (the service is a Known_Service that is neither an Unknown_Service nor a Down_Service and the signal value is finite) and has a Raw_Anomaly, THE Anomaly_Tracker SHALL increase the Anomalous_Streak of that pair by 1, set its Clear_Streak to 0 and store the Anomaly_Reading of that Poll as the most recent Anomaly_Reading of the pair.
3. WHEN a (service, signal) pair is evaluated in a non-blind Poll and has no Raw_Anomaly, THE Anomaly_Tracker SHALL increase the Clear_Streak of that pair by 1 and set its Anomalous_Streak to 0.
4. WHEN the Anomalous_Streak of a pair reaches `ANOMALY_CONFIRM_POLLS` and the pair is not a Confirmed_Anomaly, THE Engine SHALL mark the pair as a Confirmed_Anomaly and emit exactly one `anomaly:detected` event carrying the Anomaly_Reading of that Poll. With `ANOMALY_CONFIRM_POLLS` equal to 1 this happens in the first Poll with a Raw_Anomaly.
5. WHEN the Clear_Streak of a pair reaches `ANOMALY_CONFIRM_POLLS` and the pair is a Confirmed_Anomaly, THE Engine SHALL clear the Confirmed_Anomaly flag and emit exactly one `anomaly:cleared` event carrying the service name and the signal.
6. WHILE a (service, signal) pair is a Confirmed_Anomaly, THE Engine SHALL emit no further `anomaly:detected` event for that pair, and WHILE a pair is not a Confirmed_Anomaly, THE Engine SHALL emit no `anomaly:cleared` event for that pair. A Raw_Anomaly that is not followed by `ANOMALY_CONFIRM_POLLS` consecutive evaluated Raw_Anomalies SHALL produce no event.
7. IF a Poll is a Blind_Poll, THEN THE Engine SHALL leave every Anomalous_Streak, every Clear_Streak, every Confirmed_Anomaly flag and every most recent Anomaly_Reading unchanged, SHALL emit no `anomaly:detected` and no `anomaly:cleared` event, and SHALL count the Blind_Poll neither as a Poll with a Raw_Anomaly nor as a Poll without one.
8. WHEN a (service, signal) pair is evaluated in a non-blind Poll, its Anomalous_Streak (including the current Poll) is at least `ANOMALY_RELEARN_POLLS`, and the service had no Open_Incident in the incident state held before that Poll's incident tracking step (the same state as in Requirement 2, Criterion 7), and the pair is not suppressed under Criterion 14, THE Engine SHALL perform a Relearn_Reset of the Baseline of that pair at the end of that Poll, after the Raw_Anomaly of that Poll has been evaluated.
9. WHEN the Engine performs a Relearn_Reset of a pair, THE Anomaly_Tracker SHALL set the Anomalous_Streak and the Clear_Streak of that pair to 0, SHALL leave the Confirmed_Anomaly flag and the most recent Anomaly_Reading of that pair unchanged, and SHALL emit no event for the reset itself. From the next Poll on, the Baseline is in Warm_Up, so the Raw_Anomaly of that pair follows the Warm_Up fixed-threshold rules of Requirement 3, and the Confirmed_Anomaly flag then changes only through Criteria 4 and 5.
10. IF a service is an Unknown_Service in a non-blind Poll, THEN THE Anomaly_Tracker SHALL set the Anomalous_Streak and the Clear_Streak of every signal of that service to 0 and clear the Confirmed_Anomaly flag and the most recent Anomaly_Reading of every signal of that service, and THE Engine SHALL emit one `anomaly:cleared` event for each such pair that was a Confirmed_Anomaly before the Poll, immediately and without waiting for `ANOMALY_CONFIRM_POLLS` Polls. A pair that was not a Confirmed_Anomaly produces no event.
11. IF a service is a Down_Service in a non-blind Poll, THEN THE Anomaly_Tracker SHALL set the Anomalous_Streak and the Clear_Streak of every signal of that service to 0 and clear the Confirmed_Anomaly flag and the most recent Anomaly_Reading of every signal of that service, and THE Engine SHALL emit one `anomaly:cleared` event for each such pair that was a Confirmed_Anomaly before the Poll, immediately and without waiting for `ANOMALY_CONFIRM_POLLS` Polls, exactly as for an Unknown_Service under Criterion 10. A pair that was not a Confirmed_Anomaly produces no event, and the clearing applies even when a signal value of the Down_Service is finite. THE Engine SHALL leave the Baselines of a Down_Service unchanged (Requirement 2, Criterion 5) and SHALL perform no Relearn_Reset for it.
12. IF a Monitored_Signal value of a Known_Service that is neither an Unknown_Service nor a Down_Service is `null` or not finite in a non-blind Poll, THEN THE Anomaly_Tracker SHALL leave the streaks, the Confirmed_Anomaly flag and the most recent Anomaly_Reading of that pair unchanged in that Poll and THE Engine SHALL emit no event for that pair.
13. WHILE an Open_Incident exists for a service, THE Engine SHALL perform no Relearn_Reset for any signal of that service, and THE Anomaly_Tracker SHALL continue to update the streaks of that service under Criteria 2 and 3, so that a Relearn_Reset can occur in the first Poll after the Open_Incident has ended in which the Anomalous_Streak is at least `ANOMALY_RELEARN_POLLS`.
14. WHILE a Known_Service has Leak_Suspicion in a non-blind Poll, THE Engine SHALL perform no Relearn_Reset of the Baseline of the pair (that service, `rssMb`) in that Poll, even when Criterion 8 would otherwise require it, so that a memory leak is never relearned as the new normal. Leak_Suspicion SHALL be evaluated on the Memory_Forecast produced by the forecast step of the same Poll, not on the forecast state of the previous Poll (see Requirement 9, Criterion 9).
15. WHILE the Relearn_Reset of a pair is suppressed under Criterion 14, THE Anomaly_Tracker SHALL continue to update the Anomalous_Streak and the Clear_Streak of that pair under Criteria 2 and 3 and SHALL NOT cap or reset the Anomalous_Streak, so that a Relearn_Reset occurs in the first non-blind Poll in which Leak_Suspicion has ended, no Open_Incident existed in the pre-Poll incident state and the Anomalous_Streak is at least `ANOMALY_RELEARN_POLLS`.
16. THE Engine SHALL apply the suppression of Criterion 14 only to the `rssMb` signal, so that the Relearn_Reset of `latencyP95Ms` and `errorRatio` of the same service, and of every signal of every other service, depends only on Criterion 8 and Criterion 13.
17. WHEN a Poll completes and is not a Blind_Poll, THE Engine SHALL include in the Cluster_Snapshot of that Poll an `anomalies` field containing the most recent Anomaly_Reading of every Confirmed_Anomaly, ordered by Service_Chain order and then by signal order `latencyP95Ms`, `errorRatio`, `rssMb`, and containing an empty list when the Poll has no Confirmed_Anomaly. A pair that is a Raw_Anomaly but not yet a Confirmed_Anomaly SHALL NOT appear in the `anomalies` field. A Down_Service and an Unknown_Service have no Confirmed_Anomaly after the Poll (Criteria 10 and 11) and therefore no entry in the `anomalies` field.
18. IF a Poll is a Blind_Poll, THEN THE Engine SHALL include in the Cluster_Snapshot of that Poll an `anomalies` field equal to the `anomalies` field of the last non-blind Poll, unchanged, or an empty list when no non-blind Poll has occurred since startup.
19. THE Engine SHALL NOT change any Health_Score, Service_Status, Breached_Kind, Dread value, attribution or Incident because of a Raw_Anomaly or a Confirmed_Anomaly.

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
6. WHEN a Memory_Drop is detected for a service, THE Forecaster SHALL clear the Forecast_Warning of that service, if one is active, with the clearing reason `memory-dropped`, and SHALL empty its RSS_Window. The reason `memory-dropped` SHALL be used both when `up` is false and when `rssMb` falls by more than `FORECAST_RESTART_DROP_MB`, because a large RSS drop can come from a restart or from leaked memory being freed. WHEN `up` is true and `rssMb` is finite in that Poll, THE Engine SHALL then start the emptied RSS_Window with the sample of that Poll.
7. WHEN a Forecast_Warning is cleared, THE Engine SHALL emit exactly one `forecast:cleared` event carrying the service name and the clearing reason (`stopped-rising` or `memory-dropped`).
8. IF a Trend_Fit has R² below `FORECAST_MIN_R2` and the service has no active Forecast_Warning, THEN THE Forecaster SHALL NOT start a Forecast_Warning from that Trend_Fit.
9. IF no Trend_Fit exists for a service and no Forecast_Warning is active for that service, THEN THE Forecaster SHALL report no Memory_Forecast for that service, so that the `forecasts` field of the Cluster_Snapshot has no entry for it (Criterion 13).
10. IF a Poll is a Blind_Poll, THEN THE Engine SHALL keep every active Forecast_Warning unchanged, emit no `forecast:warning` or `forecast:cleared` event in that Poll, and include in the Cluster_Snapshot of that Poll a `forecasts` field equal to the `forecasts` field of the last non-blind Poll, unchanged, or an empty list when no non-blind Poll has occurred since startup.
11. THE Forecaster SHALL return a `timeToLimitSeconds` that is either `null` or a finite number greater than or equal to 0.
12. FOR ALL RSS_Windows with a positive slope, THE Forecaster SHALL return a Time_To_Limit that does not increase when the latest RSS increases with the slope held fixed, and does not increase when the slope increases with the latest RSS held fixed (monotonicity).
13. WHEN a Poll is not a Blind_Poll, THE Engine SHALL include in the Cluster_Snapshot a `forecasts` field containing one Memory_Forecast for each Known_Service that has a Trend_Fit or an active Forecast_Warning, in Service_Chain order, and no entry for any Known_Service that has neither (Criterion 9). The `forecasts` field of a Blind_Poll is defined in Criterion 10.

### Requirement 7: Incident Feature Vectors

**User Story:** As a developer, I want each incident turned into a fixed-length numeric vector, so that incidents can be compared mathematically.

#### Acceptance Criteria

1. WHEN the Feature_Extractor is given an Incident, THE Feature_Extractor SHALL return a Feature_Vector whose length is `2 × N + 4 + 3 + 1`, where `N` is the number of Known_Services in the Service_Chain, and whose entries are in this order: (a) `N` entries one-hot encoding the Root_Service in Service_Chain order (1 at the index of the Root_Service, 0 elsewhere), (b) `N` entries holding 1 for each Known_Service that is an Affected_Service and 0 otherwise, in Service_Chain order, (c) 4 entries holding 1 or 0 for the Signal_Kinds `latency`, `errors`, `memory` and `down`, in that order, where 1 means the Incident has that kind, (d) 3 entries holding the peak latency, peak error ratio and peak RSS, in that order, each normalized per Criterion 2, and (e) 1 entry holding the duration normalized per Criterion 3.
2. THE Feature_Extractor SHALL normalize peak latency as peak latency divided by `LATENCY_CRITICAL_MS`, peak error ratio as peak error ratio divided by `ERROR_RATIO_CRITICAL`, and peak RSS as peak RSS divided by `MEMORY_LIMIT_MB`, clamping each result to the range [0, 1] and using 0 for a peak that is `null`.
3. THE Feature_Extractor SHALL normalize duration as the Incident duration in seconds divided by `SIMILARITY_DURATION_CAP_SECONDS` (default 300), clamped to the range [0, 1].
4. WHILE an Incident is open, THE Feature_Extractor SHALL compute the Incident duration as the elapsed time in seconds between the time the Incident opened and the current Poll time supplied as an argument, so that the duration of an Incident at the Poll in which it opens is 0. The duration entry of the Feature_Vector carries no weight when an Incident is matched at open time, because the comparison then uses the Comparison_Vector (Requirement 8, Criterion 6), and carries the same weight as every other entry when an Incident is matched at resolve time (Requirement 8, Criterion 11).
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
6. WHEN an Incident opens, THE Engine SHALL compare the Comparison_Vector of the opened Incident with the Comparison_Vectors of all resolved Incidents in the incident history, so that the duration of the opened Incident (0 at open time) does not lower the Cosine_Similarity to long resolved Incidents, and SHALL set the similar-incident field of the opened Incident to the Similar_Incident record, or to `null` under Criterion 10.
7. THE Similarity_Matcher SHALL select the resolved Incident with the highest Cosine_Similarity, and, WHEN two or more resolved Incidents have the same highest Cosine_Similarity, SHALL select the one with the latest resolution time.
8. THE Engine SHALL consider an Incident a Similar_Incident only when its Cosine_Similarity is greater than or equal to `SIMILARITY_THRESHOLD`, and SHALL compare the unrounded value with the threshold.
9. WHEN the Engine attaches a Similar_Incident to an Incident, THE Engine SHALL set the similar-incident field to a record containing the matched Incident's id, its Fingerprint, its resolution time, its duration in seconds, and its Cosine_Similarity rounded to 3 decimal places.
10. IF no resolved Incident has a Cosine_Similarity greater than or equal to `SIMILARITY_THRESHOLD`, or the incident history contains no resolved Incident, THEN THE Engine SHALL set the similar-incident field of the Incident to `null`.
11. WHEN an Incident resolves, THE Engine SHALL recompute the similar-incident field of that Incident from its full final Feature_Vector (including the duration entry) against the full Feature_Vectors of all other resolved Incidents (excluding the resolving Incident itself), and SHALL include the recomputed field in the `incident:resolved` event.
12. THE Engine SHALL keep the existing Recurrence field and its Fingerprint-based computation unchanged, so that an Incident can carry a Recurrence, a Similar_Incident, both or neither.
13. THE Engine SHALL NOT change the Feature_Vector, Fingerprint, status or any other field of any resolved Incident in the incident history when computing a similar-incident field.
14. IF the Similarity_Matcher or Feature_Extractor throws an unexpected error while computing the similar-incident field, THEN THE Engine SHALL set that field to `null`, log the error with its stack, and still open or resolve the Incident and emit its event.

### Requirement 9: Pure Functions and Pipeline Integration

**User Story:** As a developer, I want all new analysis written as pure functions that plug into the existing Poll pipeline, so that whole Poll sequences can be replayed in tests and the architecture stays consistent.

#### Acceptance Criteria

1. THE Engine SHALL implement the Baseline_Updater, Anomaly_Detector, Anomaly_Tracker, Trend_Fitter, Forecaster, Feature_Extractor and Similarity_Matcher as pure functions that perform no I/O, start no timers, read no clock and hold no shared state.
2. THE Engine SHALL give each pure function the time, configuration and previous Intelligence_State it needs as arguments, and SHALL have each function return a new Intelligence_State without changing its arguments, so that every argument is deeply equal before and after the call. The Anomaly_Tracker receives the Memory_Forecasts of the current Poll as an argument.
3. THE Poller SHALL be the only component that stores the Intelligence_State.
4. WHEN a Poll runs, THE Poller SHALL run the intelligence steps inside the existing per-Poll pipeline after health scoring and incident tracking and before the Cluster_Snapshot is stored and emitted.
5. THE Engine SHALL place the new code under `haunting-engine/src/intelligence/`, organized into the folders `anomaly`, `forecast` and `similarity`, with each `*.spec.ts` test file in the same folder as the file it tests.
6. IF an intelligence step throws an unexpected error, THEN THE Poller SHALL log the error with its stack trace, keep the Intelligence_State that it held before that Poll, and still store and emit the Cluster_Snapshot in the same Poll with every pre-existing field unchanged, with `anomalies` and `forecasts` equal to the Confirmed_Anomaly readings and the Memory_Forecasts held in the retained Intelligence_State (empty arrays when that state holds none), and no `anomaly:*` or `forecast:*` event emitted for that Poll. The Cluster_Snapshot therefore carries the same anomalies and forecasts as in a Blind_Poll, consistent with the retained state and with the absence of events.
7. THE Engine SHALL keep every existing event, REST route and Cluster_Snapshot field with its current name, type and meaning, so that existing consumers keep working.
8. FOR ALL Poll sequences, THE Engine SHALL produce an Intelligence_State and a list of emitted `anomaly:*` and `forecast:*` events that depend only on the input sequence, the Poll timestamps carried in that sequence and the configuration, and not on wall-clock time, so that replaying the same sequence twice gives deeply equal results.
9. WHEN a Poll is not a Blind_Poll, THE Poller SHALL run the forecast step (RSS_Window update, Memory_Drop handling, Trend_Fitter and Forecaster) before the anomaly tracking step, and SHALL pass the resulting Memory_Forecasts of that Poll to the Anomaly_Tracker, so that the Relearn_Reset decision of Requirement 4, Criterion 14 uses the Forecast_Warning and Trend_Fit as held after the current Poll's forecast step. The forecast step does not read any anomaly state, so this ordering introduces no circular dependency.

### Requirement 10: Shared Types

**User Story:** As the haunted-house frontend, I want anomaly, forecast and similarity data typed in one shared place, so that I consume them without redefining anything.

#### Acceptance Criteria

1. THE Shared_Package SHALL define the types `MonitoredSignal`, `AnomalyReading`, `MemoryForecast`, `ForecastClearReason` and `SimilarIncident`.
2. THE Shared_Package SHALL define `MonitoredSignal` as the union of `latencyP95Ms`, `errorRatio` and `rssMb`, and `ForecastClearReason` as the union of `stopped-rising` and `memory-dropped`.
3. THE Shared_Package SHALL add an `anomalies: AnomalyReading[]` field (listing Confirmed_Anomalies only) and a `forecasts: MemoryForecast[]` field to `ClusterSnapshot`.
4. THE Shared_Package SHALL add a `similar: SimilarIncident | null` field to `Incident`.
5. THE Shared_Package SHALL add the events `anomaly:detected`, `anomaly:cleared`, `forecast:warning` and `forecast:cleared` to `ServerToClientEvents`, each with a payload type defined in the Shared_Package. The payloads SHALL be: an `AnomalyReading` for `anomaly:detected` (emitted only for a Confirmed_Anomaly); the service name and `MonitoredSignal` for `anomaly:cleared`; a `MemoryForecast` for `forecast:warning`; and the service name and `ForecastClearReason` for `forecast:cleared`.
6. THE Engine SHALL import every new type that it sends to the frontend from the Shared_Package and SHALL NOT redeclare any of them.
7. THE Shared_Package SHALL continue to contain only type declarations and SHALL compile to declaration files only, with zero emitted `.js` files in its build output.
8. FOR ALL Cluster_Snapshots and Incidents that the Engine produces, serializing to JSON and parsing back SHALL produce a value deeply equal to the original (round-trip property), which requires that no new field contains `NaN`, `Infinity` or `undefined`. A value that is absent SHALL be represented as `null`.
9. WHEN a frontend client connects, THE Engine SHALL send it the latest Cluster_Snapshot, which already carries the current anomalies and forecasts, so that a late joiner sees active warnings without waiting for a new event.
10. IF no Cluster_Snapshot has been stored yet when a frontend client connects, THEN THE Engine SHALL send no Cluster_Snapshot to that client and SHALL send the first Cluster_Snapshot to it when the first Poll completes.

### Requirement 11: Configuration

**User Story:** As a developer, I want every new setting configurable through environment variables with safe defaults, so that thresholds can be tuned for the demo without code changes.

#### Acceptance Criteria

1. WHEN `loadEngineConfig` runs and a variable listed in this criterion is unset or an empty string, THE Engine SHALL use the default given here: `ANOMALY_ALPHA` (0.1), `ANOMALY_Z_THRESHOLD` (3), `ANOMALY_WARMUP_POLLS` (30), `ANOMALY_CONFIRM_POLLS` (2), `ANOMALY_RELEARN_POLLS` (30), `ANOMALY_MIN_STDDEV_LATENCY_MS` (5), `ANOMALY_MIN_STDDEV_ERROR_RATIO` (0.005), `ANOMALY_MIN_STDDEV_RSS_MB` (2), `MEMORY_LIMIT_MB` (290), `FORECAST_WINDOW_POLLS` (15), `FORECAST_MIN_SAMPLES` (5), `FORECAST_MIN_R2` (0.8), `FORECAST_MIN_SLOPE_MB_PER_S` (0.05), `FORECAST_WARN_SECONDS` (60), `FORECAST_RESTART_DROP_MB` (20), `SIMILARITY_THRESHOLD` (0.85) and `SIMILARITY_DURATION_CAP_SECONDS` (300).
2. WHEN `loadEngineConfig` runs and a variable listed in Criterion 1 is set to a valid value, THE Engine SHALL use that value instead of the default.
3. IF `ANOMALY_ALPHA` is not a finite number in the range (0, 1], THEN THE Engine SHALL exit at startup with a non-zero exit code and an error message naming `ANOMALY_ALPHA`.
4. IF `FORECAST_MIN_R2` or `SIMILARITY_THRESHOLD` is not a finite number in the range [0, 1], THEN THE Engine SHALL exit at startup with a non-zero exit code and an error message naming the offending variable.
5. IF `ANOMALY_WARMUP_POLLS`, `ANOMALY_CONFIRM_POLLS`, `ANOMALY_RELEARN_POLLS`, `FORECAST_WINDOW_POLLS`, `FORECAST_MIN_SAMPLES` or `SIMILARITY_DURATION_CAP_SECONDS` is not a positive integer (a whole number of at least 1), THEN THE Engine SHALL exit at startup with a non-zero exit code and an error message naming the offending variable.
6. IF `ANOMALY_Z_THRESHOLD`, any `ANOMALY_MIN_STDDEV_*` value, `MEMORY_LIMIT_MB`, `FORECAST_MIN_SLOPE_MB_PER_S`, `FORECAST_WARN_SECONDS` or `FORECAST_RESTART_DROP_MB` is not a finite number greater than 0, THEN THE Engine SHALL exit at startup with a non-zero exit code and an error message naming the offending variable.
7. IF `FORECAST_MIN_SAMPLES` is greater than `FORECAST_WINDOW_POLLS`, THEN THE Engine SHALL exit at startup with a non-zero exit code and an error message naming `FORECAST_MIN_SAMPLES`.
8. IF `MEMORY_LIMIT_MB` is not greater than `MEMORY_CRITICAL_MB`, THEN THE Engine SHALL exit at startup with a non-zero exit code and an error message naming `MEMORY_LIMIT_MB`.
9. IF `ANOMALY_RELEARN_POLLS` is less than `ANOMALY_CONFIRM_POLLS`, THEN THE Engine SHALL exit at startup with a non-zero exit code and an error message naming `ANOMALY_RELEARN_POLLS`, because a baseline must not be relearned before an anomaly can be confirmed.
10. IF more than one validation rule in Criteria 3 to 9 is violated, THEN THE Engine SHALL exit at startup with an error message naming every offending variable.
11. THE Engine SHALL list every variable from Criterion 1 in `haunting-engine/.env.example` with its default and a one-line description, and SHALL also list `INTEGRATION_LEAK_TIMEOUT_SECONDS` (300) and `INTEGRATION_MIN_LEAD_SECONDS` (10), which are read by the integration test of Requirement 14 and not by `loadEngineConfig`.
12. THE Engine SHALL pass every variable from Criterion 1 through the `haunting-engine` service in `docker-compose.yml` using the form `${NAME:-default}` with the same default as `.env.example` and Criterion 1. The two `INTEGRATION_*` variables are test-only and SHALL NOT be passed through `docker-compose.yml`.
13. THE Engine SHALL contain no hardcoded value for any setting listed in Criterion 1 outside the configuration module.
14. THE Engine SHALL leave `LEAK_MB_PER_SECOND` and `MEMORY_GAUGE_INTERVAL_MS` out of `loadEngineConfig`, because they are victim-app settings defined in Requirement 15.

### Requirement 12: Property-Based Testing

**User Story:** As a developer, I want the core learning logic covered by property tests, so that edge cases in the math are found before a demo does.

#### Acceptance Criteria

1. THE Engine SHALL include a fast-check property test file for each of the Baseline_Updater, Anomaly_Detector, Anomaly_Tracker, Trend_Fitter, Forecaster, Feature_Extractor and Similarity_Matcher, placed next to the file it tests, and each property test SHALL run at least 100 iterations.
2. THE Engine SHALL tag every property test with a comment of the form `// Feature: engine-intelligence, Property <N>: <text>`, where `<N>` is a positive integer that is unique across all property tests of this feature and `<text>` is a non-empty statement of the property.
3. THE Engine SHALL include one property test for each of the following properties, and each test SHALL fail when the stated property is violated:
   - baseline variance is never less than 0, and baseline mean and variance stay finite (R1.6)
   - Baselines are unchanged when any learning guard in Requirement 2 applies, where the Raw_Anomaly guard (R2.6) is evaluated on the raw, unconfirmed flag of the current Poll and not on the Confirmed_Anomaly state (R2)
   - Z_Scores are finite or `null` (R3.10)
   - no Raw_Anomaly is flagged during Warm_Up unless it is a Fixed_Threshold_Breach (R3.4)
   - `anomaly:detected` is emitted for a pair only in the Poll in which its Anomalous_Streak first reaches `ANOMALY_CONFIRM_POLLS`, and `anomaly:cleared` only in the Poll in which its Clear_Streak first reaches `ANOMALY_CONFIRM_POLLS` while it is a Confirmed_Anomaly; a run of fewer than `ANOMALY_CONFIRM_POLLS` Raw_Anomalies or non-anomalous Polls produces no event (R4.2 to R4.6)
   - Blind_Polls leave every streak, Confirmed_Anomaly flag and Intelligence_State forecast field unchanged, and the `anomalies` and `forecasts` fields of a Blind_Poll Cluster_Snapshot equal those of the last non-blind Poll (R4.7, R4.18, R6.10)
   - a Relearn_Reset happens for a pair in exactly the first non-blind Poll in which its Anomalous_Streak is at least `ANOMALY_RELEARN_POLLS`, no Open_Incident existed in the pre-Poll incident state and, for the `rssMb` signal, the service has no Leak_Suspicion; after the reset the Baseline sample count is 0, both streaks are 0 and the Confirmed_Anomaly flag is unchanged; no Relearn_Reset happens in any Poll while an Open_Incident exists for the service (R4.8, R4.9, R4.13)
   - for generated Poll sequences, no Relearn_Reset of an `rssMb` Baseline occurs in any Poll in which the service has an active Forecast_Warning or a Trend_Fit with a slope greater than `FORECAST_MIN_SLOPE_MB_PER_S` in the Memory_Forecast of that same Poll, alongside the Open_Incident case above; during the suppression the Anomalous_Streak keeps counting, the Relearn_Reset occurs in the first eligible Poll after Leak_Suspicion ends, and Relearn_Resets of `latencyP95Ms` and `errorRatio` Baselines are not affected (R4.14 to R4.16)
   - an Unknown_Service or a Down_Service clears every anomaly pair of that service in the same Poll (both streaks 0, Confirmed_Anomaly false, most recent Anomaly_Reading `null`, one `anomaly:cleared` event for each pair that was confirmed and none for any other pair, and no entry in `anomalies`), while a `null` or non-finite signal value of any other service leaves its pair unchanged and emits no event (R4.10 to R4.12)
   - the Trend_Fitter recovers the slope and R² of an exact line within a relative tolerance of 1e-6 (R5.8)
   - R² lies in [0, 1] (R5.7)
   - `timeToLimitSeconds` is `null` or a finite number greater than or equal to 0 (R6.11)
   - Time_To_Limit does not increase when the latest RSS or the slope increases, holding the other value fixed (R6.12)
   - no Forecast_Warning starts from a Trend_Fit with R² below `FORECAST_MIN_R2` (R6.8)
   - a Forecast_Warning is cleared with the reason `memory-dropped` whenever a Memory_Drop occurs (with `up` false or with an RSS fall above `FORECAST_RESTART_DROP_MB`) and with the reason `stopped-rising` whenever the slope falls to `FORECAST_MIN_SLOPE_MB_PER_S` or below without a Memory_Drop (R6.5, R6.6)
   - matching at open time is unaffected by the duration entries of the compared Incidents (R8.6)
   - Feature_Vector entries are finite and lie in [0, 1] (R7.6)
   - Cosine_Similarity is symmetric, lies in [0, 1], and equals 1 within 1e-9 for identical non-zero vectors (R8.1 to R8.3)
   - the selected Similar_Incident always has a Cosine_Similarity of at least `SIMILARITY_THRESHOLD` (R8.8)
   - serializing Cluster_Snapshots and Incidents to JSON and parsing back produces a value equal to the original (R10.8)
4. THE Engine SHALL include a property test that generates Poll sequences containing Blind_Polls, Unknown_Services and Open_Incidents, and asserts that the Baselines after the full sequence are equal to the Baselines obtained by replaying only the Polls for which no learning guard applies (R2.8).
5. THE Engine SHALL include a unit test for `loadEngineConfig` that asserts every default value listed in Requirement 11 Criterion 1 (including `ANOMALY_CONFIRM_POLLS` 2, `ANOMALY_RELEARN_POLLS` 30, `FORECAST_WINDOW_POLLS` 15 and `FORECAST_MIN_SAMPLES` 5) and asserts that each rejection case in Requirement 11 Criteria 3 to 9 causes startup to fail with a message naming the offending variable, including the case `ANOMALY_RELEARN_POLLS` less than `ANOMALY_CONFIRM_POLLS`.
6. THE Victim_App SHALL include unit tests for the `MEMORY_GAUGE_INTERVAL_MS` handling of Requirement 15 that assert the default of 1000, a valid override, and the rejection of each invalid value class named in Requirement 15, Criterion 5.

### Requirement 13: Boot and Module Wiring

**User Story:** As a developer, I want proof that the whole Engine still boots with the new layer, so that wiring mistakes that per-class tests miss are caught.

#### Acceptance Criteria

1. THE Engine SHALL include a Jest test, an extension of the existing `app.module.spec.ts`, that builds the real `AppModule` (no new Nest providers are added by this feature), calls `app.init()`, and passes only if `app.init()` resolves without throwing and the first stored Cluster_Snapshot has both an `anomalies` field and a `forecasts` field.
2. WHEN an implementation milestone ends, THE Engine SHALL have completed a real boot, meaning the build exits with code 0, the Engine process starts, and `GET /health` returns a success response within 30 seconds of process start.
3. IF the build fails, the Engine process exits before `GET /health` succeeds, or `GET /health` does not return a success response within 30 seconds of process start, THEN THE milestone SHALL be treated as not complete and the failure SHALL be reported with the build or startup error output.
4. WHEN the Engine starts with only the environment variables that were required before this feature, THE Engine SHALL start successfully and SHALL use the default value listed in Requirement 11 for each new variable.
5. WHEN `docker compose up` is executed, THE `haunting-engine` container SHALL report a healthy status within 30 seconds, and THE Engine SHALL emit a Cluster_Snapshot containing both the `anomalies` field and the `forecasts` field within 30 seconds of the container becoming healthy.
6. IF the `haunting-engine` container is not healthy, or no Cluster_Snapshot containing the `anomalies` and `forecasts` fields has been emitted, within the time limits in Criterion 5, THEN THE check SHALL be reported as failed.

### Requirement 14: Integration Test for Memory Leak Forecast Lead Time

**User Story:** As a hackathon judge, I want proof that the Engine warns about a memory leak before the service crashes, so that I can trust the forecast.

#### Acceptance Criteria

1. WHEN the integration test starts against the running stack, THE Engine test suite SHALL inject a memory leak into `payments` through the Chaos_Proxy and SHALL poll the Engine for the latest Cluster_Snapshot every 1 second until the crash time has been recorded under Criterion 4 or `INTEGRATION_LEAK_TIMEOUT_SECONDS` (default 300, positive integer) elapses, whichever comes first.
2. THE integration test SHALL be located in `haunting-engine/test/`.
3. WHEN the test first observes a Cluster_Snapshot whose `forecasts` field contains a Forecast_Warning for `payments`, THE test SHALL record the timestamp of that Cluster_Snapshot as the warning time.
4. WHEN the test first observes `payments` with Service_Status `down`, or with RSS more than `FORECAST_RESTART_DROP_MB` (default 20 MB) below the maximum `payments` RSS seen by the test in this run (a real restart), THE test SHALL record the timestamp of that Cluster_Snapshot as the crash time.
5. WHEN both a warning time and a crash time have been recorded, THE test SHALL assert that the warning time is earlier than the crash time and SHALL compute the lead time as the crash time minus the warning time, in seconds.
6. WHEN the lead time is computed, THE test SHALL assert that the lead time is greater than or equal to `INTEGRATION_MIN_LEAD_SECONDS` seconds (default 10, positive integer) and SHALL write the lead time in seconds and the value of `INTEGRATION_MIN_LEAD_SECONDS` to the test output.
7. WHEN the final checkpoint of the implementation is reached, THE design document SHALL record the measured lead time in seconds and the `INTEGRATION_MIN_LEAD_SECONDS` value that it was compared with.
8. IF `payments` has not crashed when `INTEGRATION_LEAK_TIMEOUT_SECONDS` elapses, THEN THE test SHALL assert that a Forecast_Warning for `payments` was observed, SHALL write to the test output a message stating that no crash occurred, SHALL skip the lead time assertions of Criteria 5, 6 and 10 because no crash time exists, and SHALL NOT fail for the absence of a crash.
9. IF no Forecast_Warning for `payments` is observed before the crash time or before the timeout, THEN THE test SHALL fail with a message stating that no forecast warning was observed.
10. IF the computed lead time is less than `INTEGRATION_MIN_LEAD_SECONDS`, THEN THE test SHALL fail with a message stating the measured lead time, the warning time, the crash time and the value of `INTEGRATION_MIN_LEAD_SECONDS`.
11. IF `INTEGRATION_LEAK_TIMEOUT_SECONDS` or `INTEGRATION_MIN_LEAD_SECONDS` is set to a value that is not a positive integer, THEN THE test SHALL fail before injecting any chaos, with a message naming the offending variable.
12. WHEN the test finishes, whether it passed, failed or timed out (except under Criterion 13, where no chaos was injected), THE test SHALL call `POST /api/chaos/reset-all` so that other tests start from a clean state.
13. IF the stack is not running, THEN THE test SHALL log a message stating that the stack is required and SHALL return from each test without injecting chaos, because Jest 29 has no runtime skip.

### Requirement 15: Victim-App Configuration for the Leak Demo

**User Story:** As a hackathon judge, I want the memory leak in the demo to grow at a rate the Engine can fit within a few Polls, and the memory gauge to refresh often enough to show it, so that the forecast warning appears and has a measurable lead time before the crash.

#### Acceptance Criteria

1. THE `docker-compose.yml` SHALL set `LEAK_MB_PER_SECOND` for each of the `gateway`, `orders` and `payments` services using the form `${LEAK_MB_PER_SECOND:-2}`, replacing the current fixed value of 5.
2. THE `victim-app/.env.example` SHALL list `LEAK_MB_PER_SECOND=2` with a one-line description, and THE Victim_App SHALL keep reading `LEAK_MB_PER_SECOND` from the environment in the same way as today, so that a value set in the environment still takes precedence.
3. WHEN the Victim_App starts and `MEMORY_GAUGE_INTERVAL_MS` is unset or an empty string, THE Memory_Gauge SHALL refresh the `process_heap_used_bytes` and `process_rss_bytes` gauges every 1000 milliseconds.
4. WHEN the Victim_App starts and `MEMORY_GAUGE_INTERVAL_MS` is set to a positive integer (a whole number of at least 1), THE Memory_Gauge SHALL refresh the gauges at that interval in milliseconds.
5. IF `MEMORY_GAUGE_INTERVAL_MS` is set to a value that is not a positive integer (zero, a negative number, a fractional number, a non-numeric string, `NaN` or `Infinity`), THEN THE Victim_App SHALL log an error naming `MEMORY_GAUGE_INTERVAL_MS` and exit with code 1 before it starts listening, using a validation function in `libs/common` that sits beside `validateRequiredEnv` and is called from each app's `main.ts`.
6. THE Memory_Gauge SHALL read `MEMORY_GAUGE_INTERVAL_MS` from the environment at startup and SHALL NOT hardcode the interval.
7. THE `docker-compose.yml` SHALL pass `MEMORY_GAUGE_INTERVAL_MS` to each of the `gateway`, `orders` and `payments` services using the form `${MEMORY_GAUGE_INTERVAL_MS:-1000}`, and THE `victim-app/.env.example` SHALL list `MEMORY_GAUGE_INTERVAL_MS=1000` with a one-line description.
8. THE Victim_App SHALL keep the initial gauge refresh at startup, the metric names, labels and values, the `/metrics` and `/health` routes, the chaos behavior (including `CHAOS_TTL_SECONDS`, the leak rate set by `LEAK_MB_PER_SECOND`, the retained-unit count reported by the chaos state, and the enabling, disabling, reset and TTL expiry of the leak) and the healthcheck settings of `docker-compose.yml` unchanged. The `mem_limit` stays 256m for every service. The calibration pass added `memswap_limit` equal to `mem_limit` and a `CHAOS_TTL_SECONDS` default of 240 (`<SERVICE>_CHAOS_TTL_SECONDS`) to gateway and orders, matching payments, so a memory leak on any service ends in a real OOM kill. The only memory-leak behavior that changes is the memory allocated per leak unit under Criterion 10. The default gauge interval of 1000 ms, which replaces the fixed 5000 ms of the earlier Victim_App implementation, and the allocation of Criterion 10 are the only intended behavior changes; the existing Victim_App tests that assert a 5000 ms interval SHALL be updated to the default of 1000 ms.
9. THE Victim_App SHALL keep its code default for `LEAK_MB_PER_SECOND` unchanged when the variable is unset, so that only the Docker Compose and `.env.example` demo values change.
10. WHEN the memory leak is enabled, THE Victim_App SHALL allocate each leak unit as real, touched memory that adds at least 1 MiB (1,048,576 bytes) of resident set size per unit, using `Buffer.alloc` with a fill value, so that `process_rss_bytes` rises with the leak.

### Requirement 16: Assessment of the Known Open Issue

**User Story:** As a maintainer, I want to know whether the new layer helps with the missed or misattributed outage after a fast payments restart, so that I can decide what to build next with evidence.

#### Acceptance Criteria

1. THE design document SHALL contain a section titled "Assessment: known open issue" that states one conclusion for anomaly baselines and one conclusion for memory forecasting, each being exactly one of "reduces the issue", "does not reduce the issue" or "reduces the issue only in part, with the remaining gap named".
2. THE "Assessment: known open issue" section SHALL explain the mechanism behind each conclusion by referring to both behaviors recorded in the haunting-engine design: failed requests staying in the 15 s `RATE_WINDOW` after a fast payments restart, and attribution moving from payments to orders or gateway.
3. THE "Assessment: known open issue" section SHALL state, for each conclusion, whether it rests on analysis alone or on a measurement, and SHALL list by name every measurement that was considered and not performed (or state that none applies).
4. IF the assessment concludes that neither anomaly baselines nor memory forecasting reduces the issue, THEN THE design document SHALL state in the assessment section that neither reduces it and SHALL leave the issue listed as open under "Known open issues" in `roadmap.md`.
5. THE Engine SHALL NOT use Anomalies or Forecast_Warnings to change attribution or Incident lifecycle rules as part of this feature, regardless of the assessment result.
