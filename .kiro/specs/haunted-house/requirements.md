# Requirements Document

## Introduction

The haunted-house feature is the Next.js frontend of The Haunted Cluster. It connects to the haunting-engine over Socket.IO and turns the live cluster state into a haunted-house visual (one room per service), a generative Tone.js soundscape, an incidents panel, a ghost message area and "Possess it" chaos controls. Every visual and every sound maps to a real signal from the Engine, and every sound has a visual equivalent.

The frontend consumes only what the Engine already emits: `cluster:snapshot`, `incident:list`, `incident:opened`, `incident:updated`, `incident:resolved`, `chaos:triggered`, `anomaly:detected`, `anomaly:cleared`, `forecast:warning` and `forecast:cleared`, plus the REST endpoints `GET /api/snapshot` and `POST /api/chaos/*`. Every event and data type is imported from `@haunted-cluster/shared` (from `shared/dist`), never redefined.

Two honesty rules from `roadmap.md` shape the display. First, `timeToLimitSeconds` is an estimate and is shown as one. Second, after a fast restart the Engine can miss an outage or blame the wrong service, so the frontend presents a root service as the Engine's suspicion, never as a certainty.

This feature also makes one change in the haunting-engine: a per-client rate limit on the chaos proxy, because the chaos buttons will be public once deployed. The frontend shows a friendly message when the limit is hit.

**Out of scope for this spec:** the AI ghost narrator and any LLM call (spec `ghost-narrator`); deployment, demo video and write-up; persisting any state in the browser across page reloads; authentication; any change to Engine scoring, attribution, incident lifecycle or intelligence rules; chaos actions other than the five listed; new Socket.IO events.

## Glossary

- **Frontend**: The `haunted-house/` Next.js App Router application.
- **Engine**: The haunting-engine NestJS application.
- **Victim_App**: The gateway, orders and payments services that the Engine monitors.
- **Shared_Package**: The types-only `@haunted-cluster/shared` package, imported from `shared/dist`.
- **Engine_URL**: The base URL of the Engine, read by the Frontend from `NEXT_PUBLIC_ENGINE_URL`.
- **Chaos_Proxy**: The Engine's `/api/chaos/*` REST endpoints, the only way the Frontend triggers chaos.
- **Cluster_State**: The Frontend's in-memory view of the latest `ClusterSnapshot`, open and recent incidents, confirmed anomalies, active forecasts and recent chaos events.
- **Room**: The visual for one service in the Service_Chain, in Service_Chain order.
- **Room_Status**: A `ServiceStatus` value: `healthy`, `degraded`, `critical`, `down` or `unknown`.
- **Dread**: The `dread` value of the latest `ClusterSnapshot`, in [0, 1].
- **Connection_State**: One of `connecting`, `connected` or `lost_contact`.
- **Lost_Contact**: The Connection_State in which the Socket.IO connection is not established, after a first attempt has failed or an established connection has dropped.
- **Stale_Snapshot**: The last `ClusterSnapshot` received before Lost_Contact began.
- **Blind_Snapshot**: A `ClusterSnapshot` whose `metricsAvailable` is false.
- **Anomaly_Effect**: The visual effect on a Room for a confirmed `AnomalyReading`, per signal (`latencyP95Ms`, `errorRatio`, `rssMb`).
- **Forecast_Countdown**: The visible estimate of seconds until a service reaches its memory limit, derived from a `MemoryForecast` with `warning` true.
- **Incident_Panel**: The Frontend panel listing open and recent resolved incidents.
- **Recent_Incidents**: The most recent resolved incidents kept in Cluster_State, at most `RECENT_INCIDENTS_LIMIT` (10).
- **Suspected_Root**: The `rootService` of an Incident, presented as the Engine's suspicion.
- **Restart_Caveat**: A visible note that attribution may be wrong after a restart, shown on an Incident whose `kinds` include `down` or whose `affected` entries include `down`.
- **Ghost_Area**: The Frontend panel where the ghost's messages appear.
- **Ghost_Message**: One entry in the Ghost_Area, with a timestamp, a severity and a text built from an incident or forecast event.
- **Ghost_Message_Builder**: The pure function that turns an incident or forecast event into a Ghost_Message.
- **Soundscape**: The Tone.js audio output of the Frontend.
- **Audio_Mapping**: A pure function in `haunted-house/audio/` that maps Cluster_State values to Soundscape parameters, with no Tone.js import and no side effects.
- **Audio_Engine**: The code in `haunted-house/audio/` that applies Soundscape parameters to Tone.js nodes.
- **Audio_Layer**: One sound source in the Soundscape: `ambient`, `whispers`, `screams`, `heartbeat` or `silence`.
- **Audio_Visual_Cue**: The visual equivalent of one Audio_Layer, shown whenever that layer is audible.
- **User_Gesture**: A click, tap or key press by the user.
- **Mute_Control**: The control that silences and restores the Soundscape.
- **Possess_Controls**: The per-service buttons for latency, errors, memory leak, crash and reset.
- **Chaos_Preset**: The fixed parameters sent for each button: latency `{ ms: 1500 }`, errors `{ percentage: 50 }`, memory leak `{ enabled: true }`; crash and reset have no body.
- **Cooldown**: The short period after a Possess_Controls action during which that service's buttons are disabled, `CHAOS_COOLDOWN_MS` (default 3000).
- **Chaos_Rate_Limit**: The Engine's per-client limit on chaos actions: at most `CHAOS_RATE_LIMIT_MAX` (default 5) accepted requests per `CHAOS_RATE_LIMIT_WINDOW_SECONDS` (default 60) per client.
- **Client_Key**: The identity of a client for the Chaos_Rate_Limit. When `TRUST_PROXY` is `true`, it is the address reported by the first proxy hop (Express `trust proxy` set to 1); otherwise it is the direct connection address.
- **Trusted_Proxy_Hop**: The single reverse proxy whose reported client address the Engine trusts when `TRUST_PROXY` is `true`.
- **CORS_Origin**: The Engine's `CORS_ORIGIN` setting, the one browser origin allowed to call the Engine, default `http://localhost:3100`.
- **Haunted_Scene**: The drawn (inline SVG) picture of the house in which each Room is a part of the house.
- **Design_Tokens**: The named colour, typeface and spacing values of the visual identity, defined once for both the light and dark themes.
- **Heading_Font**: The self-hosted spooky typeface used for headings.
- **Body_Font**: The self-hosted readable typeface used for body text.
- **Frontend_Health_Route**: The Frontend's `GET /api/health` route.

## Requirements

### Requirement 1: Engine Connection and Lost Contact

**User Story:** As an on-call engineer, I want the house to connect to the Engine on its own and to tell me when it cannot, so that I never mistake a silent screen for a healthy cluster.

#### Acceptance Criteria

1. THE Frontend SHALL read the Engine_URL from `NEXT_PUBLIC_ENGINE_URL` and SHALL use it for both the Socket.IO connection and every REST call.
2. IF `NEXT_PUBLIC_ENGINE_URL` is not set or is an empty string at build time, THEN THE Frontend SHALL fail the build with a message naming the variable and SHALL produce no build output.
3. WHEN the Frontend page loads, THE Frontend SHALL open a Socket.IO connection to the Engine_URL, typed with `ServerToClientEvents` and `ClientToServerEvents` from the Shared_Package, and SHALL set the Connection_State to `connecting` within 100 milliseconds of page load.
4. WHEN the Socket.IO connection is established, THE Frontend SHALL set the Connection_State to `connected` within 100 milliseconds of the connection event.
5. IF the Socket.IO connection fails or drops, THEN THE Frontend SHALL set the Connection_State to `lost_contact` within 1 second of detecting the failure and SHALL retry indefinitely, with the delay between attempts starting at 1 second and not exceeding 10 seconds.
6. WHEN the Socket.IO connection is re-established after Lost_Contact, THE Frontend SHALL set the Connection_State to `connected`, SHALL remove the "lost contact" banner, and SHALL replace the Cluster_State (discarding the Stale_Snapshot) with the data received from the Engine on connection, so that the snapshot comes from `cluster:snapshot` and the open incidents are replaced by the received `incident:list`, and SHALL keep the Recent_Incidents unchanged, because resolved incidents cannot be refetched over Socket.IO.
7. WHILE the Connection_State is `lost_contact`, THE Frontend SHALL display a "lost contact" banner and SHALL render every Room as `unknown` regardless of the Stale_Snapshot values.
8. WHILE the Connection_State is `lost_contact`, THE Frontend SHALL disable every control in the Possess_Controls, SHALL stop all Audio_Layers except a single low constant tone that signals lost contact, and SHALL show an Audio_Visual_Cue that is active for as long as the tone plays.
9. WHEN the Frontend page loads and the Engine is reachable, THE Frontend SHALL request `GET /api/snapshot` exactly once.
10. IF the `GET /api/snapshot` request returns a 503 response, THEN THE Frontend SHALL treat it as "no poll has completed yet", SHALL show no error indication, and SHALL keep the Cluster_State empty until the first `cluster:snapshot` event arrives.
11. IF a received event payload is missing a field required by its Shared_Package type, THEN THE Frontend SHALL ignore that payload, log one console warning naming the event, and keep the previous Cluster_State unchanged.

### Requirement 2: The House and Room Status

**User Story:** As an on-call engineer, I want one room per service that shows its live status, so that I see which part of the house is troubled at a glance.

#### Acceptance Criteria

1. WHEN a `cluster:snapshot` event is received, THE Frontend SHALL render exactly one Room for each entry in `ClusterSnapshot.services`, in the order of that list (upstream first), each labelled with the service name.
2. THE Frontend SHALL derive the Room set and service names from the snapshot and SHALL NOT hardcode `gateway`, `orders` or `payments`.
3. WHEN a `cluster:snapshot` event is received, THE Frontend SHALL update every Room to the `status` of the matching `ServiceHealth` within 100 milliseconds of receipt, and within one animation frame of the state update.
4. WHILE a Room's status is `healthy`, `degraded`, `critical`, `down` or `unknown`, THE Frontend SHALL render that Room with a visual treatment distinct from each of the other four statuses and SHALL show the status as visible text, so that status does not depend on colour alone.
5. WHILE a Room's status is `down`, THE Frontend SHALL render the Room dark, with no animation, and with its status text visible.
6. WHILE a Room's status is `unknown`, THE Frontend SHALL render the Room with a fog treatment that differs from the `healthy` treatment, so that an unknown Room never looks like a `healthy` Room.
7. WHEN a Room is shown, THE Frontend SHALL display the service's `score` (0 to 100), `latencyP95Ms` in milliseconds, `errorRatio` as a percentage, `rssMb` in megabytes and `requestRate` in requests per second from `signals`, and SHALL display a dash for any value that is null or undefined.
8. WHILE the latest snapshot is a Blind_Snapshot, THE Frontend SHALL render every Room as `unknown` and SHALL display a "the ghost cannot see" notice.
9. WHILE no snapshot has been received, THE Frontend SHALL render the house with zero Rooms and a "waiting for the first poll" message.
10. WHEN the Dread value changes, THE Frontend SHALL set the atmosphere of the whole house (darkness, flicker and fog intensity, each on a 0 to 1 scale) as a monotonically non-decreasing function of Dread, so that a higher Dread never produces a lower value for any of the three than a lower Dread.
11. WHILE the user's system setting prefers reduced motion, THE Frontend SHALL replace flicker and shake animations with static visual changes that convey the same status or Dread level and SHALL show no animation faster than 1 change per second.
12. IF a `cluster:snapshot` event contains a `ServiceHealth` with a status outside `healthy`, `degraded`, `critical`, `down` and `unknown`, THEN THE Frontend SHALL render that Room as `unknown` and SHALL keep all other Rooms unchanged.

### Requirement 3: Anomaly and Forecast Visuals

**User Story:** As an on-call engineer, I want learned anomalies and memory forecasts to show on the right room, so that I see trouble before a fixed threshold is crossed.

#### Acceptance Criteria

1. WHEN a `ClusterSnapshot` is received, THE Frontend SHALL show exactly one Anomaly_Effect on the Room of each `AnomalyReading` in `anomalies`, visually distinct for each signal, with a label containing the signal name, the value and the `method`, within 500 ms of receipt.
2. WHEN an `anomaly:detected` event is received, THE Frontend SHALL show the Anomaly_Effect for that service and signal within 500 ms of receipt, without waiting for the next snapshot.
3. WHEN an `anomaly:cleared` event is received, THE Frontend SHALL remove the Anomaly_Effect for that service and signal within 500 ms of receipt, and SHALL leave the Anomaly_Effects of other signals and services unchanged.
4. WHEN a `ClusterSnapshot` is received, THE Frontend SHALL show an Anomaly_Effect only for the readings in its `anomalies` field, and SHALL remove every Anomaly_Effect that has no matching reading in that field.
5. WHEN a `MemoryForecast` with `warning` true and a non-null `timeToLimitSeconds` greater than 0 is received in a `ClusterSnapshot` or a `forecast:warning` event, THE Frontend SHALL show a Forecast_Countdown on the Room of that service with the text "<service> dies in ~<N> s", where N is `timeToLimitSeconds` rounded to the nearest multiple of 5 seconds, with a minimum displayed N of 5.
6. WHEN a new `ClusterSnapshot` is received while a Forecast_Countdown is active for a service, THE Frontend SHALL update that Forecast_Countdown to the `timeToLimitSeconds` of that snapshot's forecast for the service, applying the rounding of criterion 5.
7. THE Frontend SHALL include the "~" sign and the word "estimate" or the abbreviation "est." in the visible text of every Forecast_Countdown.
8. WHEN a received `MemoryForecast` has `warning` true and `timeToLimitSeconds` equal to 0, THE Frontend SHALL show the text "<service> is about to die (est.)" on the Room of that service instead of a number.
9. WHEN a `forecast:cleared` event is received, THE Frontend SHALL remove the Forecast_Countdown for that service within 500 ms of receipt, and SHALL show the `reason` value (`stopped-rising` or `memory-dropped`) as text in the Ghost_Area.
10. WHEN a `ClusterSnapshot` contains a `MemoryForecast` with `warning` false, or a `warning` true forecast with a null `timeToLimitSeconds`, THE Frontend SHALL show no Forecast_Countdown for that service.
11. WHEN the Connection_State becomes `lost_contact`, THE Frontend SHALL remove every Anomaly_Effect and every Forecast_Countdown within 500 ms.
12. THE Frontend SHALL expose, for each displayed Anomaly_Effect and Forecast_Countdown, a non-empty text alternative readable by assistive technology that states the service, and the signal and value (for an Anomaly_Effect) or the estimated seconds to limit (for a Forecast_Countdown).

### Requirement 4: Incidents Panel

**User Story:** As an on-call engineer, I want to see current and recent incidents with their cause, reach and history, so that I can decide what to look at first.

#### Acceptance Criteria

1. WHEN an `incident:list` event is received, THE Frontend SHALL replace the open incidents in Cluster_State with the received list, so that incidents absent from the received list are no longer shown as open.
2. WHEN an `incident:opened` or `incident:updated` event is received, THE Frontend SHALL add the incident to the open incidents in Cluster_State if no open incident has the same `id`, or replace the open incident with the same `id` otherwise.
3. WHEN an `incident:resolved` event is received, THE Frontend SHALL remove the incident with the same `id` from the open incidents, add it to the start of the Recent_Incidents, and discard the oldest entries so that Recent_Incidents contains at most `RECENT_INCIDENTS_LIMIT` entries.
4. WHEN an `incident:resolved` event is received for an `id` already present in the Recent_Incidents, THE Frontend SHALL keep exactly one entry for that `id` in the Recent_Incidents.
5. THE Incident_Panel SHALL list open incidents first, then Recent_Incidents, each group ordered newest first.
6. WHILE both the open incidents and the Recent_Incidents are empty, THE Incident_Panel SHALL show a "no incidents" message.
7. WHEN an incident is shown, THE Incident_Panel SHALL display its Suspected_Root, each `affected` service with its `kinds`, the incident `kinds`, its status, and its duration.
8. WHILE an incident is open, THE Incident_Panel SHALL display its duration as the time elapsed since `openedAt`, updated at least once every 1 second.
9. WHEN an incident is resolved, THE Incident_Panel SHALL display `durationMs` converted to seconds, rounded to 1 decimal place, with the unit "s".
10. WHERE an incident has a non-null `recurrence`, THE Incident_Panel SHALL display that the incident has happened before, together with the `count` and the `lastResolvedAt` time.
11. WHERE an incident has a non-null `similar`, THE Incident_Panel SHALL display the similar past incident with its `fingerprint`, its `durationSeconds` and its `similarity` as a percentage rounded to the nearest whole number.
12. THE Incident_Panel SHALL label the root service as "suspected root" and SHALL NOT use wording that states the root service as a fact.
13. WHERE an incident satisfies the Restart_Caveat condition, THE Incident_Panel SHALL display the Restart_Caveat text "attribution may be wrong after a restart" next to that incident.
14. WHERE an incident has non-empty `relatedChaos`, THE Incident_Panel SHALL display that chaos was triggered shortly before the incident, with the action and service of the newest entry in `relatedChaos`.
15. WHEN the Connection_State becomes `lost_contact`, THE Incident_Panel SHALL keep showing the last known open incidents and Recent_Incidents, mark each as possibly out of date, and stop updating the duration of open incidents.
16. WHEN the Connection_State leaves `lost_contact`, THE Incident_Panel SHALL replace the open incidents with the `incident:list` received on connection, SHALL keep the Recent_Incidents, and SHALL remove the possibly-out-of-date marking from all incidents shown.
17. WHILE an incident is displayed in the Incident_Panel, THE Frontend SHALL highlight the Room of its Suspected_Root, and SHALL remove the highlight within 1 second after the incident is no longer displayed.

### Requirement 5: Ghost Area

**User Story:** As an on-call engineer, I want a place where the ghost speaks about what is happening, so that the house already feels narrated before the AI narrator exists.

#### Acceptance Criteria

1. THE Frontend SHALL render a Ghost_Area that lists Ghost_Messages newest first and keeps at most `GHOST_MESSAGE_LIMIT` (50) messages.
2. WHEN a Ghost_Message is added and the Ghost_Area already holds `GHOST_MESSAGE_LIMIT` (50) messages, THE Frontend SHALL remove the oldest message so that the Ghost_Area holds exactly 50 messages.
3. WHEN an `incident:opened` event is received, THE Ghost_Message_Builder SHALL produce a Ghost_Message that names the Suspected_Root, lists every incident kind and every affected service from the event payload, and contains at least one suspicion word from the set "suspect", "seems", "may", "might", "possibly", so that the attribution is not presented as certain.
4. WHEN an `incident:resolved` event is received, THE Ghost_Message_Builder SHALL produce a Ghost_Message that names the Suspected_Root and states the incident duration in whole seconds, taken from the event payload.
5. WHEN an `incident:opened` event carries a non-null `recurrence` or a non-null `similar`, THE Ghost_Message_Builder SHALL include text stating that the pattern has been seen before.
6. WHEN an `incident:opened` event carries a non-null `similar`, THE Ghost_Message_Builder SHALL include the `similarity` value as a whole-number percentage from 0 to 100 in the Ghost_Message.
7. WHEN a `forecast:warning` event is received, THE Ghost_Message_Builder SHALL produce a Ghost_Message that states the service, the estimated seconds to the memory limit prefixed with the "~" sign, and the word "estimate".
8. WHEN a `forecast:cleared` event is received, THE Ghost_Message_Builder SHALL produce a Ghost_Message that names the service and states the `reason` from the event payload.
9. WHEN an `anomaly:detected` event is received, THE Ghost_Message_Builder SHALL produce a Ghost_Message that names the service, the signal and the detected value from the event payload.
10. THE Ghost_Message_Builder SHALL build every number in a Ghost_Message from the event payload, so that no message contains a numeric value absent from the event that caused it, other than values derived by rounding or percentage conversion of payload values.
11. THE Ghost_Message_Builder SHALL return an identical Ghost_Message when called twice with the same event and timestamp, and SHALL NOT change its input.
12. WHEN a Ghost_Message is added, THE Frontend SHALL announce it to assistive technology through a live region with `aria-live` set to "polite".
13. THE Ghost_Area SHALL be structured so that a later narrator can add messages through the same message list, without changing the layout of the Ghost_Area.
14. WHEN a `chaos:triggered` event is received, THE Ghost_Message_Builder SHALL produce a Ghost_Message that names the service and the action from the event payload, so that a visitor sees the cause of the haunting.
15. IF an event is received whose payload lacks a field required to build its Ghost_Message, THEN THE Ghost_Message_Builder SHALL NOT add a Ghost_Message for that event, and THE Frontend SHALL keep the existing Ghost_Messages unchanged and continue processing later events.

### Requirement 6: Generative Soundscape

**User Story:** As an engineer who cannot watch dashboards all day, I want to hear the health of the cluster, so that I notice problems early without looking.

#### Acceptance Criteria

1. UNTIL the user performs a User_Gesture on the "enable sound" control, THE Frontend SHALL NOT create or start any Tone.js audio context, and the number of Tone.js audio contexts created SHALL be 0.
2. WHEN the user performs a User_Gesture on the "enable sound" control, THE Audio_Engine SHALL start the Tone.js audio context and begin the Soundscape within 1000 ms.
3. WHILE the Soundscape has not been enabled, THE Frontend SHALL display the "enable sound" control and a text indicator that sound is off.
4. WHEN the user activates the Mute_Control, THE Frontend SHALL silence every Audio_Layer (output level 0) within 300 ms, and WHEN the user activates it again, THE Frontend SHALL restore every Audio_Layer to its mapped level within 300 ms. THE Mute_Control SHALL be focusable and operable with the Enter and Space keys.
5. WHILE the Soundscape is muted, THE Frontend SHALL display a muted indicator that is visible and exposed to assistive technology as text.
6. THE Audio_Mapping SHALL map Dread in [0, 1] to the ambient layer intensity in [0, 1], such that for any two Dread values a ≤ b the ambient intensity for a is less than or equal to that for b.
7. THE Audio_Mapping SHALL map the highest `badness.latency` among services whose status is neither `unknown` nor `down` to the whispers layer level in [0, 1], such that a higher latency badness never produces a lower level. IF no service has a status other than `unknown` or `down`, THEN THE Audio_Mapping SHALL return a whispers level of 0.
8. THE Audio_Mapping SHALL map the highest `badness.errors` among all services to the screams layer level in [0, 1], such that a higher badness never produces a lower level. IF the service list is empty, THEN THE Audio_Mapping SHALL return a screams level of 0.
9. WHILE any service has an active Forecast_Countdown or a memory `badness` above 0, THE Audio_Mapping SHALL derive the heartbeat rate from the highest memory `badness`, or from the shortest `timeToLimitSeconds` for an active forecast, such that a higher memory badness or a shorter time to limit never produces a slower heartbeat. WHILE no service meets that condition, THE Audio_Mapping SHALL return a heartbeat level of 0.
10. THE Audio_Mapping SHALL keep the heartbeat rate within `HEARTBEAT_MIN_BPM` (40) and `HEARTBEAT_MAX_BPM` (180) inclusive whenever the heartbeat level is above 0.
11. WHEN a service changes to the status `down`, THE Audio_Mapping SHALL request a silence of all Audio_Layers for `SILENCE_MS` (1500 ms), after which the layers SHALL resume at their mapped levels. IF another service changes to `down` during a silence, THEN THE Audio_Mapping SHALL restart the 1500 ms silence rather than extend it cumulatively.
12. WHEN the Connection_State is `lost_contact`, THE Audio_Mapping SHALL return a lost-contact tone level above 0 and levels of 0 for ambient, whispers, screams and heartbeat.
13. WHEN the latest snapshot is a Blind_Snapshot, THE Audio_Mapping SHALL return levels of 0 for whispers, screams and heartbeat and SHALL set the ambient layer to a fixed uncertain level that is a constant in (0, 1) and independent of Dread.
14. FOR ALL valid Cluster_State inputs, THE Audio_Mapping SHALL return level values in [0, 1] and a heartbeat rate that are finite numbers, and SHALL never return `NaN`, `Infinity` or `-Infinity`.
15. WHEN the Audio_Mapping is called twice with deeply equal input, THE Audio_Mapping SHALL return deeply equal output both times and SHALL NOT mutate its input (a deep-frozen input SHALL not cause an error).
16. THE Audio_Mapping SHALL be implemented as pure functions in `haunted-house/audio/` with no import of Tone.js, and THE Audio_Engine SHALL be the only module that imports Tone.js.
17. WHEN the Audio_Engine changes a layer level, THE Audio_Engine SHALL ramp the change over a duration of at least 100 ms and SHALL NOT apply any step change in gain.
18. IF the Tone.js audio context fails to start, THEN THE Frontend SHALL display a text message that sound is unavailable, SHALL keep the "enable sound" control available for retry, and SHALL keep every visual feature working.
19. WHILE the page is hidden, THE Audio_Engine SHALL keep the Soundscape levels consistent with the latest Cluster_State, and WHEN the page becomes visible again, THE Audio_Engine SHALL NOT play any sound event (including the `SILENCE_MS` silence) that was triggered while the page was hidden.

### Requirement 7: Visual Equivalents of Sound

**User Story:** As a user who cannot hear, or who has the sound off, I want every sound to have a visible counterpart, so that I get the same information.

#### Acceptance Criteria

1. WHILE the ambient layer level is above 0, THE Frontend SHALL show an Audio_Visual_Cue for ambient intensity whose displayed intensity changes monotonically with the ambient level, such that a level change of 0.05 or more (on the 0 to 1 scale) produces a visibly different cue state, and the cue is updated within 250 ms of the Audio_Mapping output changing.
2. WHILE the whispers level is above 0, THE Frontend SHALL show an Audio_Visual_Cue for whispers on the Room with the highest `badness.latency` among services whose status is neither `unknown` nor `down`, and IF two or more Rooms have equal highest latency badness, THEN THE Frontend SHALL show the cue on the first of those Rooms in the fixed Room order used by the Audio_Mapping.
3. WHILE the screams level is above 0, THE Frontend SHALL show an Audio_Visual_Cue for screams on the Room with the highest error badness, and IF two or more Rooms have equal highest error badness, THEN THE Frontend SHALL show the cue on the first of those Rooms in the fixed Room order used by the Audio_Mapping.
4. WHILE the heartbeat is audible, THE Frontend SHALL show a pulsing Audio_Visual_Cue whose pulse rate equals the heartbeat rate from the Audio_Mapping output, within a tolerance of 5%.
5. WHEN the sudden silence of Requirement 6, Criterion 11 begins, THE Frontend SHALL show a visible "silence" cue, and THE Frontend SHALL remove the cue when the silence ends, so that the cue duration equals the silence duration within 250 ms.
6. WHILE the Soundscape is disabled or muted, THE Frontend SHALL continue to show every Audio_Visual_Cue defined in Criteria 1 to 5 using the same rules as when the Soundscape is enabled.
7. THE Frontend SHALL compute each Audio_Visual_Cue from the same Audio_Mapping output instance that drives the Audio_Engine, so that for any Audio_Mapping output the cue state and the sound state are derived from identical values.
8. IF the Audio_Mapping output is unavailable or the engine connection is lost, THEN THE Frontend SHALL hide all Audio_Visual_Cues except a visible indicator that sound data is unavailable.
9. WHILE the user's system setting prefers reduced motion, THE Frontend SHALL show the heartbeat cue as a static indicator with no animation and with the heartbeat rate displayed as text in beats per minute.

### Requirement 8: Possess Controls

**User Story:** As a judge or visitor, I want to break a service from the page with no setup, so that I can watch the house react.

#### Acceptance Criteria

1. THE Frontend SHALL render, for each Room, Possess_Controls with exactly five buttons: latency, errors, memory leak, crash and reset.
2. WHEN the user activates the latency, errors or memory leak button of a service while the Connection_State is `connected` and that service is not in Cooldown, THE Frontend SHALL send `POST <Engine_URL>/api/chaos/<service>/latency`, `/error-rate` or `/memory-leak` respectively, with the matching Chaos_Preset as JSON body.
3. WHEN the user activates the crash or reset button of a service while the Connection_State is `connected` and that service is not in Cooldown, THE Frontend SHALL send `POST <Engine_URL>/api/chaos/<service>/crash` or `/reset` respectively, without a body.
4. THE Frontend SHALL send every chaos request to the Chaos_Proxy and SHALL NOT contain any URL or configuration for the Victim_App `/chaos/*` endpoints.
5. WHEN a chaos request is sent, THE Frontend SHALL disable all five buttons of that service from the moment of sending until the Cooldown has elapsed or the request has completed, whichever is later, and SHALL show an in-progress indicator on that Room's controls until the request completes.
6. WHEN a chaos request returns a 2xx status, THE Frontend SHALL show a success result containing the service name and the action name, and SHALL end the in-progress indicator.
7. IF a chaos request returns a 4xx status other than 429, THEN THE Frontend SHALL show a failure result containing the `message` of the response body, joined with ", " when `message` is a list, and SHALL end the in-progress indicator.
8. IF a chaos request returns 429, THEN THE Frontend SHALL show the rate-limit message of Requirement 10 and SHALL end the in-progress indicator.
9. IF a chaos request returns 502 or 504, THEN THE Frontend SHALL show a failure result stating that the service could not be reached or timed out, and SHALL end the in-progress indicator.
10. IF a chaos request fails without a response (network error or timeout), THEN THE Frontend SHALL show a failure result stating that the Engine could not be reached, and SHALL end the in-progress indicator.
11. IF a chaos request receives no response within `CHAOS_REQUEST_TIMEOUT_MS` (5000 ms), THEN THE Frontend SHALL abort the request and treat it as a failure without a response.
12. WHEN an action result is shown, THE Frontend SHALL display it next to the Room's controls for `RESULT_VISIBLE_MS` (6000 ms), SHALL then remove it, and SHALL announce it to assistive technology through a polite live region.
13. WHEN a `chaos:triggered` event is received, THE Frontend SHALL show a visual mark on the Room of that service naming the action, whether the event came from this client or from another visitor.
14. WHEN the user activates the "reset all" control while the Connection_State is `connected`, THE Frontend SHALL send `POST <Engine_URL>/api/chaos/reset-all` without a body and, when the response arrives, SHALL show for each service in the latest snapshot whether its reset succeeded or failed.
15. IF the "reset all" request fails without a response or returns a non-2xx status, THEN THE Frontend SHALL show a failure result stating that the reset did not complete, naming no service as reset successfully.
16. WHILE the Connection_State is not `connected`, THE Frontend SHALL disable every control in the Possess_Controls, including the "reset all" control.
17. THE Frontend SHALL label each Possess_Controls button, and the "reset all" control, with visible text, so that each is identifiable without an icon.

### Requirement 9: Chaos Rate Limit in the Engine

**User Story:** As the owner of a public demo, I want each visitor limited to a few chaos actions per minute, so that one visitor cannot keep the demo broken for everyone else.

#### Acceptance Criteria

1. THE Engine SHALL apply the Chaos_Rate_Limit to every `POST /api/chaos/*` endpoint, counting all of them together in one shared counter per Client_Key.
2. WHEN a Client_Key has made `CHAOS_RATE_LIMIT_MAX` accepted chaos requests within the last `CHAOS_RATE_LIMIT_WINDOW_SECONDS` seconds, THE Engine SHALL answer the next chaos request from that Client_Key with status 429 and a body `{ message }`, without forwarding it to a Victim_App service and without recording a chaos event for it.
3. WHEN the Engine answers with 429, THE Engine SHALL include a `Retry-After` header whose value is a whole number of seconds, rounded up, between 1 and `CHAOS_RATE_LIMIT_WINDOW_SECONDS`, equal to the time until the oldest counted request leaves the window.
4. THE Engine SHALL NOT apply the Chaos_Rate_Limit to `GET /api/chaos/:service/state`, `GET /api/snapshot`, `GET /health` or the Socket.IO connection.
5. WHILE a Client_Key is limited, THE Engine SHALL accept chaos requests from other Client_Keys that are below their own limit, with the same behavior as when no Client_Key is limited.
6. WHEN `POST /api/chaos/reset-all` is accepted, THE Engine SHALL count it as exactly one request toward the limit, regardless of how many Victim_App services it resets.
7. THE Engine SHALL read `CHAOS_RATE_LIMIT_MAX`, `CHAOS_RATE_LIMIT_WINDOW_SECONDS` and `TRUST_PROXY` from environment variables with defaults of 5, 60 and `false`, and SHALL list all three in `haunting-engine/.env.example` and pass them through `docker-compose.yml`.
8. IF `CHAOS_RATE_LIMIT_MAX` or `CHAOS_RATE_LIMIT_WINDOW_SECONDS` is set to a value that is not a positive integer (for example 0, a negative number, a decimal or non-numeric text), THEN THE Engine SHALL refuse to start, exit with a non-zero exit code, and log a message naming the invalid variable.
9. WHERE `TRUST_PROXY` is set to `true`, THE Engine SHALL trust exactly one Trusted_Proxy_Hop (Express `trust proxy` set to 1) and SHALL take the Client_Key from the address that proxy reports, so that a client-supplied `X-Forwarded-For` header cannot change the Client_Key.
10. WHILE `TRUST_PROXY` is not set to `true`, THE Engine SHALL take the Client_Key from the direct connection address and SHALL ignore every forwarded header sent by the client.
11. THE Engine SHALL leave Chaos_Proxy validation, forwarding, status mapping and chaos event recording unchanged for requests below the limit.
12. IF a chaos request fails validation with status 400, THEN THE Engine SHALL answer with 400 and SHALL NOT count that request toward the limit.
13. FOR ALL sequences of N chaos requests from one Client_Key within one window, THE Engine SHALL accept exactly `min(N, CHAOS_RATE_LIMIT_MAX)` of them and answer the remaining `N - min(N, CHAOS_RATE_LIMIT_MAX)` with 429.

### Requirement 10: Friendly Rate-Limit Message

**User Story:** As a visitor, I want a clear message when I am going too fast, so that I know to wait and not that the demo is broken.

#### Acceptance Criteria

1. WHEN a chaos request returns status 429 with a valid `Retry-After` header, THE Frontend SHALL show a message within 200 ms stating that the ghost needs rest and naming the wait as a whole number of seconds equal to the header value.
2. IF a chaos request returns status 429 and the `Retry-After` header is absent, non-numeric, not an integer, less than 1, or greater than 3600, THEN THE Frontend SHALL show the ghost-needs-rest message without a number of seconds and SHALL keep every Possess_Controls button disabled for a default wait of 10 seconds.
3. WHEN a 429 response is received, THE Frontend SHALL disable every Possess_Controls button for all services within 200 ms, until the wait has elapsed.
4. WHILE the Possess_Controls buttons are disabled because of a 429 response and the wait is a known number of seconds, THE Frontend SHALL display the remaining seconds, updated once per second, counting down to 0.
5. WHEN the wait has elapsed, THE Frontend SHALL remove the rate-limit message and SHALL re-enable each Possess_Controls button that is not disabled for another reason, within 200 ms.
6. IF a further 429 response is received while a wait is already active, THEN THE Frontend SHALL restart the wait using the newest valid `Retry-After` value, or the 10-second default if the value is not valid.
7. THE Frontend SHALL NOT retry a rate-limited chaos request automatically.

### Requirement 11: Responsive and Theme-Aware Layout

**User Story:** As a visitor on any device, I want the house to be usable on a phone or a wide screen, in a light or dark setting, so that I can try the demo anywhere.

#### Acceptance Criteria

1. THE Frontend SHALL lay out the Rooms, Incident_Panel, Ghost_Area and Possess_Controls with no horizontal scrolling (document scroll width not greater than viewport width) at every viewport width from 320 px to 1920 px inclusive.
2. WHILE the viewport width is below 768 px, THE Frontend SHALL stack the Rooms, Incident_Panel, Ghost_Area and Possess_Controls in a single column, with each element spanning the full content width.
3. WHILE the viewport width is 768 px or more, THE Frontend SHALL show the Rooms side by side in a single row in Service_Chain order when all Rooms fit in the row, and SHALL wrap the Rooms into a grid of rows, still in Service_Chain order, when they do not fit, with no clipped text and no clipped buttons, and with the Incident_Panel and Ghost_Area beside or below the Rooms.
4. WHILE the system colour scheme preference is `dark`, THE Frontend SHALL apply the dark theme, and WHILE the preference is `light`, THE Frontend SHALL apply the light theme.
5. WHEN the system colour scheme preference changes while the page is open, THE Frontend SHALL switch to the matching theme within 500 ms without a page reload and without losing the current Room_Status, Incident_Panel or Ghost_Area content.
6. THE Frontend SHALL give text a contrast ratio of at least 4.5:1 against its background in both themes at every Room_Status.
7. THE Frontend SHALL make every interactive control reachable and operable using the keyboard alone, and SHALL show a visible focus indicator with a contrast ratio of at least 3:1 against adjacent colours on the focused control.
8. THE Frontend SHALL give every interactive control a non-empty accessible name that describes its purpose.
9. WHEN the service list contains between 1 and 8 services inclusive, THE Frontend SHALL render every service as a Room with no overlapping Rooms, no clipped text and no horizontal scrolling at viewport widths from 320 px to 1920 px.
10. IF the service list contains more than 8 services, THEN THE Frontend SHALL render the first 8 services in Service_Chain order, laid out under the wrapping rules of Criterion 3, and omit the remainder without layout breakage.

### Requirement 12: Visual Identity

**User Story:** As a visitor, I want the house to look like one coherent haunted place, so that the demo feels memorable while every status stays readable.

#### Acceptance Criteria

1. THE Frontend SHALL render the Rooms inside one Haunted_Scene drawn as inline SVG, in which each Room is a distinct part of the house, in Service_Chain order, and SHALL NOT present the Rooms as a plain grid of cards.
2. THE design document SHALL contain a section that lists the Haunted_Scene structure (the SVG groups, one per Room, and the shared elements such as roof, ground and fog), the Heading_Font, the Body_Font and every Design_Token.
3. THE Frontend SHALL use the Heading_Font for headings and the Body_Font for body text, and SHALL load both from files served by the Frontend itself, with zero font requests to any other origin at runtime.
4. IF the Heading_Font or the Body_Font fails to load, THEN THE Frontend SHALL render the affected text in a fallback font stack that ends in a generic family and SHALL keep all text readable and unclipped.
5. THE Frontend SHALL define the Design_Tokens once, with a light-theme value and a dark-theme value for each token, and SHALL cover with them the five Room_Statuses, the three Anomaly_Effect signals (`latencyP95Ms`, `errorRatio`, `rssMb`) and the five Audio_Layers' Audio_Visual_Cues.
6. THE Frontend SHALL take every colour used in the Haunted_Scene, the Rooms and the Audio_Visual_Cues from the Design_Tokens, with zero hardcoded colour values outside the token definitions.
7. THE Frontend SHALL have a test that computes the contrast ratio of every text token against its background token in both themes, for every Room_Status, and fails when any ratio is below 4.5:1.
8. THE Frontend SHALL have a test that computes the contrast ratio of the focus-indicator token against each adjacent background token in both themes and fails when any ratio is below 3:1.
9. THE Frontend SHALL convey each Room_Status through visible text and a shape or pattern difference in the Haunted_Scene in addition to colour, so that no status depends on colour alone.
10. WHILE the user's system setting prefers reduced motion, THE Frontend SHALL show the Haunted_Scene with no animation faster than 1 change per second, under the same rules as Requirement 2, Criterion 11.
11. THE Haunted_Scene SHALL keep the layout rules of Requirement 11, including no horizontal scrolling from 320 px to 1920 px, no clipped text and no clipped buttons.

### Requirement 13: Shared Types and Structure

**User Story:** As a maintainer, I want the frontend to share one definition of every event, so that the Engine and the Frontend cannot drift apart.

#### Acceptance Criteria

1. THE Frontend SHALL import every event, snapshot, incident, anomaly, forecast and chaos type from `@haunted-cluster/shared`, resolved to `shared/dist`, and SHALL NOT declare any interface or type alias in `haunted-house/` that duplicates the name or shape of a type exported by `@haunted-cluster/shared`.
2. THE Frontend SHALL NOT contain any import path in `haunted-house/` source or test files that resolves to `shared/src`, and a static check SHALL fail the build with a non-zero exit code if one is found.
3. WHEN the Frontend build or test command is run, THE Frontend SHALL build the Shared_Package first, and IF the Shared_Package build fails, THEN THE Frontend SHALL stop with a non-zero exit code without starting its own build or tests.
4. THE Frontend SHALL be written in TypeScript with strict mode enabled, and THE Frontend SHALL contain zero uses of `any` that lack an adjacent code comment stating the justification.
5. THE Frontend SHALL place all React components in `haunted-house/components/` and all audio code in `haunted-house/audio/`, and THE Frontend SHALL contain zero React components, JSX and React hook imports in files under `haunted-house/audio/`.
6. THE Frontend SHALL contain zero class components, meaning zero classes that extend `React.Component` or `React.PureComponent`, and SHALL implement every component as a function component.
7. THE Frontend SHALL contain no secret values, no API keys and no LLM calls in files under `haunted-house/` or in browser-bundled code, because the narrator runs server-side in a later spec.
8. IF the Frontend is built and `shared/dist` is missing or does not contain the declaration files for the imported types, THEN THE Frontend SHALL fail the build with a non-zero exit code and an error message identifying the missing Shared_Package output.
9. THE Frontend SHALL pin Next.js to the latest 14.2.x patch release (14.2.35 at the time of writing) with React 18, because the app is public and later patches contain security fixes.

### Requirement 14: Configuration, Docker and Boot

**User Story:** As a developer, I want one command to start the whole stack including the house, so that I can run and demo it without setup.

#### Acceptance Criteria

1. THE Frontend SHALL listen for HTTP requests on port 3100 and SHALL answer requests to its root route on that port once started.
2. THE Frontend SHALL provide `haunted-house/.env.example` listing `NEXT_PUBLIC_ENGINE_URL` with the documented value `http://localhost:4000`, and SHALL list every other environment variable the Frontend reads in that file, each with a documented value and a one-line description.
3. THE Frontend SHALL provide a Dockerfile that builds the Shared_Package and the Frontend and starts the Next.js production server on port 3100.
4. THE docker-compose.yml SHALL define a `haunted-house` service that builds from the Frontend Dockerfile, publishes port 3100, passes `NEXT_PUBLIC_ENGINE_URL` as a build argument with the default `http://localhost:4000`, depends on the `haunting-engine` service, and has a healthcheck against the Frontend_Health_Route that runs every 10 seconds, times out after 5 seconds and retries 5 times before the service is marked unhealthy.
5. WHEN `GET /api/health` is requested, THE Frontend_Health_Route SHALL answer 200 with `{ "status": "ok", "service": "haunted-house" }` within 500 ms, without contacting the Engine, including while the Engine is unreachable.
6. WHEN `docker compose up` is run from the repository root, THE docker-compose.yml SHALL start every service, including the `haunted-house` service, with no other step, and the `haunted-house` service SHALL report healthy within 120 seconds of the build completing.
7. THE Frontend SHALL read every tunable named in this document (`RECENT_INCIDENTS_LIMIT`, `GHOST_MESSAGE_LIMIT`, `CHAOS_COOLDOWN_MS`, `CHAOS_REQUEST_TIMEOUT_MS`, `RESULT_VISIBLE_MS`, `SILENCE_MS`, `HEARTBEAT_MIN_BPM`, `HEARTBEAT_MAX_BPM`) from one constants module with the defaults stated in this document, and SHALL take the Engine_URL from the environment only, with no hardcoded fallback host in any other module.
8. THE Engine SHALL read its CORS_Origin from the environment variable `CORS_ORIGIN` with the default `http://localhost:3100`, SHALL accept cross-origin chaos POST requests, including the preflight request, from that origin, and SHALL expose the `Retry-After` header to browser scripts so that the Frontend can read it on a rate-limited response.
9. IF `NEXT_PUBLIC_ENGINE_URL` is missing or is not a valid absolute http or https URL when the Frontend is built or started, THEN THE Frontend SHALL fail the build or start with an error message naming `NEXT_PUBLIC_ENGINE_URL`, and SHALL NOT serve any page.
10. THE Frontend SHALL treat `NEXT_PUBLIC_ENGINE_URL` as fixed at build time (inlined into the browser bundle), so that a deployed image SHALL be built with the public Engine URL and changing the Engine_URL SHALL require a rebuild of the Frontend image.
11. THE Engine SHALL accept the public Frontend URL through `CORS_ORIGIN`, and THE docker-compose.yml SHALL pass `CORS_ORIGIN` to the `haunting-engine` service with the default `http://localhost:3100`.
12. THE `haunted-house/.env.example` SHALL document with a comment that `NEXT_PUBLIC_ENGINE_URL` is fixed at build time, and THE `haunting-engine/.env.example` SHALL document with a comment that `CORS_ORIGIN` must be set to the public Frontend URL when deployed.
13. THE docker-compose.yml SHALL document with a comment, at the `NEXT_PUBLIC_ENGINE_URL` build argument, that changing it requires rebuilding the `haunted-house` image, and SHALL document with a comment, at the `CORS_ORIGIN` environment entry, that it must match the public Frontend URL.
14. WHERE `TRUST_PROXY` is `true` behind a Cloudflare Tunnel on the live deployment, THE deployment SHALL be verified once by checking that a request from a known client is limited by that client's own address and that two different clients do not share a Client_Key.

### Requirement 15: Testing and Real Boot

**User Story:** As a maintainer, I want tests and a real boot at each milestone, so that a green test run means the house actually runs.

#### Acceptance Criteria

1. THE Frontend SHALL have Jest unit tests that each pass for: the Cluster_State reducer, the Ghost_Message_Builder, the chaos client, the Forecast_Countdown formatting and the connection state handling.
2. THE Frontend SHALL have a Jest unit test of the chaos client in which a 429 response carrying a `Retry-After` header yields a rate-limited result containing the `Retry-After` value in seconds, and a 429 response without a `Retry-After` header yields a rate-limited result using a documented default wait.
3. THE Frontend SHALL have fast-check property tests, each run with at least 100 iterations and tagged with a `// Feature: haunted-house, Property <N>: <text>` comment, covering: Audio_Mapping outputs (every value finite and in [0, 1], heartbeat within its configured bounds); Audio_Mapping monotonicity (non-decreasing in Dread, latency badness, error badness and memory badness); Audio_Mapping determinism (same input gives equal output) and input immutability (a deep-frozen input does not throw and is unchanged); the Cluster_State reducer (a resolved incident leaves the open list and enters Recent_Incidents, whose length never exceeds its configured limit; applying the same snapshot twice gives a state equal to applying it once); the Ghost_Message_Builder (every number in the message appears in the payload, and the same payload gives the same message); the atmosphere function (non-decreasing in Dread); and the Forecast_Countdown rounding.
4. THE Engine SHALL have Jest tests for the Chaos_Rate_Limit, including a fast-check property test, run with at least 100 iterations and tagged `// Feature: haunted-house, Property <N>: <text>`, asserting that for N requests from one Client_Key in one window, exactly `min(N, CHAOS_RATE_LIMIT_MAX)` are accepted and the rest are rejected.
5. THE Engine SHALL have a test that builds the full `AppModule` with the rate limit in place and calls `app.init()` without throwing.
6. THE Engine SHALL have a test in which the request exceeding `CHAOS_RATE_LIMIT_MAX` receives a 429 response with a `Retry-After` header whose value is a positive integer number of seconds no greater than the window length.
7. THE Frontend SHALL have a test that renders the full page component tree with a fake Socket.IO source and checks that (a) a snapshot with exactly one `down` service shows that service's Room as dark and the other Rooms as not dark, and (b) a Blind_Snapshot shows every Room as unknown.
8. WHEN the Frontend milestone is complete, THE Frontend SHALL be verified by a real boot: build with exit code 0, start the production server, then `GET /api/health` and the home page each answer 200 within 10 seconds of the server reporting ready, and `npm audit --omit=dev` run in `haunted-house/` reports no high or critical findings.
9. WHEN the Engine rate-limit milestone is complete, THE Engine SHALL be verified by a real boot: build with exit code 0, start, `GET /health` answers 200, then sending `CHAOS_RATE_LIMIT_MAX` + 1 chaos requests from one Client_Key within one window yields a 429 with a `Retry-After` header on the last request.
10. WHEN the full stack milestone is complete, THE stack SHALL be verified by `docker compose up`, where within 120 seconds all services are running, `GET /api/health` on port 3100 answers 200, and the page receives at least one `cluster:snapshot` from the Engine.
11. THE Engine SHALL have tests showing that a spoofed `X-Forwarded-For` header does not bypass the Chaos_Rate_Limit: (a) with `TRUST_PROXY` unset, N requests from one direct address that each carry a different `X-Forwarded-For` value are counted against one Client_Key and the request beyond `CHAOS_RATE_LIMIT_MAX` receives 429; and (b) with `TRUST_PROXY=true` behind one Trusted_Proxy_Hop, requests whose client-supplied `X-Forwarded-For` values differ but whose address reported by the proxy is the same are counted against one Client_Key and the request beyond `CHAOS_RATE_LIMIT_MAX` receives 429.
12. WHEN the Frontend milestone is complete, THE Frontend SHALL be verified by a manual sound check performed in Chrome, Firefox and Safari, in which the tester enables sound after a User_Gesture, activates the Mute_Control, and hears each Audio_Layer.
13. IF any test, build or boot check in criteria 1 to 12 fails, THEN THE milestone SHALL be treated as not complete and SHALL NOT be marked done in `tasks.md` until the check passes.
