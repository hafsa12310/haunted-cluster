# Requirements Document

## Introduction

The victim-app is a set of three NestJS microservices — Gateway, Orders, and Payments — that form a realistic call chain for The Haunted Cluster. Gateway receives external traffic and calls Orders; Orders calls Payments to complete a transaction. Every service exposes live Prometheus metrics so the haunting-engine can read them and generate the horror soundscape. Each service also contains a Chaos module with endpoints to inject controlled failure modes (latency, error rate, memory leak, process crash). All chaos settings expire automatically so a public demo always heals itself, and can also be reset at any time. A load-generator script runs alongside the services to produce steady baseline traffic through the full chain. The entire stack starts with a single `docker compose up` command.

## Glossary

- **Gateway**: The NestJS service that receives all inbound HTTP requests and forwards them to Orders.
- **Orders**: The NestJS service that handles order logic and calls Payments to process payment.
- **Payments**: The NestJS service that handles payment processing and is called by Orders.
- **Chaos_Module**: The NestJS feature module present in each service that exposes chaos-injection endpoints.
- **Load_Generator**: A standalone TypeScript script that sends continuous HTTP requests to Gateway.
- **Metrics_Endpoint**: The HTTP `GET /metrics` route on each service that returns Prometheus-formatted metrics.
- **Health_Endpoint**: The HTTP `GET /health` route on each service used for Docker healthchecks.
- **Excluded_Routes**: The routes `/metrics`, `/health`, and every route under `/chaos/`. These routes are never affected by chaos and are never counted in request metrics.
- **Request_Counter**: The prom-client Counter `http_requests_total` tracking completed inbound HTTP requests.
- **Latency_Histogram**: The prom-client Histogram `http_request_duration_seconds` tracking request duration in seconds.
- **Error_Counter**: The prom-client Counter `http_errors_total` tracking HTTP 5xx responses.
- **Heap_Gauge**: The prom-client Gauge `process_heap_used_bytes` tracking Node.js heap used in bytes.
- **RSS_Gauge**: The prom-client Gauge `process_rss_bytes` tracking the Node.js resident set size in bytes.
- **Chaos_State**: The in-memory object within the Chaos_Module that holds active chaos settings and their expiry times for a service.
- **Latency_Injection**: A Chaos_State setting that adds a configurable delay (in milliseconds) to every non-excluded request.
- **Error_Rate_Injection**: A Chaos_State setting that causes a configurable percentage (0–100) of non-excluded requests to return HTTP 500.
- **Memory_Leak_Simulation**: A Chaos_State setting that, on a timer, retains JavaScript objects in an in-memory array to grow heap and RSS usage.
- **Crash_Injection**: A Chaos_Module action that terminates the Node.js process with exit code 1.
- **Chaos_TTL**: The number of seconds after which any active chaos setting automatically resets, read from `CHAOS_TTL_SECONDS`.
- **Prometheus**: The metrics collection server that scrapes all three services' Metrics_Endpoints.

## Requirements

### Requirement 1: Service Call Chain

**User Story:** As an on-call engineer, I want Gateway, Orders, and Payments to form a live call chain, so that end-to-end latency and error propagation are visible in the metrics.

#### Acceptance Criteria

1. WHEN a `POST /order` request is sent to Gateway, THE Gateway SHALL forward the request to Orders and return the response from Orders to the caller.
2. WHEN Orders receives a request from Gateway, THE Orders SHALL call Payments and return the result to Gateway.
3. WHEN Payments receives a request from Orders, THE Payments SHALL return a successful payment response to Orders.
4. IF a downstream service cannot be reached, THEN THE calling service SHALL return HTTP 502 with a JSON body containing a `message` field describing the error.
5. IF a downstream service returns an HTTP 5xx status, THEN THE calling service SHALL return HTTP 502 with a JSON body containing a `message` field naming the failing downstream service.
6. IF a downstream service does not respond within `DOWNSTREAM_TIMEOUT_MS` milliseconds (default 5000), THEN THE calling service SHALL abort the call and return HTTP 504 with a JSON body containing a `message` field naming the slow downstream service.
7. THE Gateway SHALL read the Orders service URL from the `ORDERS_URL` environment variable.
8. THE Orders SHALL read the Payments service URL from the `PAYMENTS_URL` environment variable.

### Requirement 2: Prometheus Metrics Exposure

**User Story:** As the haunting-engine, I want each service to expose Prometheus metrics at `/metrics`, so that I can read real-time telemetry without any additional instrumentation.

#### Acceptance Criteria

1. THE Gateway, Orders, and Payments SHALL each expose a `GET /metrics` endpoint that returns metrics in Prometheus text format.
2. WHEN a request to a non-excluded route completes, THE Request_Counter SHALL be incremented by one, labelled with `method`, `route`, and `status_code`.
3. WHEN a request to a non-excluded route completes, THE Latency_Histogram SHALL record the request duration in seconds, labelled with `method` and `route`.
4. WHEN a request to a non-excluded route returns an HTTP 5xx status, THE Error_Counter SHALL be incremented by one, labelled with `method`, `route`, and `status_code`.
5. THE `route` label SHALL contain the matched route pattern (for example `/order`), never the raw request URL.
6. THE Latency_Histogram SHALL use the buckets 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, and 10 seconds.
7. WHILE a service is running, THE Heap_Gauge and RSS_Gauge SHALL be updated from `process.memoryUsage()` at least once every 5 seconds.
8. EACH service SHALL set a `service` label on all of its metrics using prom-client default labels, with the values `gateway`, `orders`, and `payments` respectively.

### Requirement 3: Chaos Module — Latency Injection

**User Story:** As a demo operator, I want to inject configurable latency into any service, so that I can show the horror soundscape reacting to slow services.

#### Acceptance Criteria

1. WHEN a POST request is sent to `/chaos/latency` with a body `{ "ms": <number> }`, THE Chaos_Module SHALL update the Chaos_State to add `ms` milliseconds of delay to every subsequent non-excluded request.
2. WHILE Latency_Injection is active, THE service SHALL delay every non-excluded inbound request by the configured number of milliseconds before processing it.
3. THE Chaos_Module SHALL accept an integer `ms` value between 0 and 30000 inclusive.
4. IF a POST request to `/chaos/latency` contains a missing, non-integer, or out-of-range `ms` value, THEN THE Chaos_Module SHALL return HTTP 400 with a JSON body containing a `message` field describing the valid range.
5. THE `/chaos/latency` endpoint SHALL use a DTO validated with class-validator.

### Requirement 4: Chaos Module — Error Rate Injection

**User Story:** As a demo operator, I want to inject a configurable error rate into any service, so that I can show the horror soundscape reacting to failing services.

#### Acceptance Criteria

1. WHEN a POST request is sent to `/chaos/error-rate` with a body `{ "percentage": <number> }`, THE Chaos_Module SHALL update the Chaos_State so that approximately `percentage` percent of subsequent non-excluded requests return HTTP 500.
2. WHILE Error_Rate_Injection is active, THE service SHALL return HTTP 500 with a JSON body `{ "message": "chaos: injected error" }` for the configured proportion of non-excluded requests.
3. THE Chaos_Module SHALL accept a `percentage` value between 0 and 100 inclusive.
4. IF a POST request to `/chaos/error-rate` contains a missing, non-numeric, or out-of-range `percentage` value, THEN THE Chaos_Module SHALL return HTTP 400 with a JSON body containing a `message` field describing the valid range.
5. THE `/chaos/error-rate` endpoint SHALL use a DTO validated with class-validator.

### Requirement 5: Chaos Module — Memory Leak Simulation

**User Story:** As a demo operator, I want to simulate a memory leak in any service, so that I can show the horror soundscape reacting to growing memory usage within seconds.

#### Acceptance Criteria

1. WHEN a POST request is sent to `/chaos/memory-leak` with a body `{ "enabled": true }`, THE Chaos_Module SHALL enable Memory_Leak_Simulation.
2. WHILE Memory_Leak_Simulation is enabled, THE service SHALL, once per second, retain approximately `LEAK_MB_PER_SECOND` megabytes (default 5) of JavaScript objects or strings in an in-memory array, independent of request traffic.
3. THE retained data SHALL be allocated on the V8 heap (JavaScript objects or strings, not Buffers) so that it is visible in the Heap_Gauge.
4. WHEN a POST request is sent to `/chaos/memory-leak` with `{ "enabled": false }`, THE Chaos_Module SHALL stop the leak timer but SHALL NOT free the already-retained memory until a chaos reset or Chaos_TTL expiry.
5. THE `/chaos/memory-leak` endpoint SHALL use a DTO validated with class-validator.

### Requirement 6: Chaos Module — Process Crash

**User Story:** As a demo operator, I want to crash any service on demand, so that I can show the horror soundscape and Docker Compose restart behavior.

#### Acceptance Criteria

1. WHEN a POST request is sent to `/chaos/crash`, THE Chaos_Module SHALL return HTTP 202 with a JSON body `{ "message": "crashing" }`.
2. WHEN the `/chaos/crash` response has been sent, THE service SHALL call `process.exit(1)` after 100 milliseconds.

### Requirement 7: Chaos Module — Reset, Expiry, and State

**User Story:** As a demo operator, I want chaos to reset on demand and expire automatically, so that a public live demo always returns to normal even if a visitor leaves chaos running.

#### Acceptance Criteria

1. WHEN a POST request is sent to `/chaos/reset`, THE Chaos_Module SHALL set Latency_Injection to 0 ms, set Error_Rate_Injection to 0%, stop the leak timer, and free the leak array.
2. WHEN a POST request is sent to `/chaos/reset`, THE Chaos_Module SHALL return HTTP 200 with a JSON body `{ "message": "chaos reset" }`.
3. THE `/chaos/reset` endpoint SHALL not require a request body.
4. WHEN any chaos setting is activated, THE Chaos_Module SHALL schedule that setting to reset automatically after Chaos_TTL seconds (read from `CHAOS_TTL_SECONDS`, default 120). Setting it again SHALL restart its expiry timer.
5. WHEN a GET request is sent to `/chaos/state`, THE Chaos_Module SHALL return HTTP 200 with a JSON body containing the current latency (ms), error rate (percentage), whether the memory leak is enabled, the approximate retained leak size in megabytes, and the expiry time (ISO 8601) of each active setting.
6. THE Excluded_Routes SHALL never be delayed, failed, or otherwise affected by any chaos setting.

### Requirement 8: Health Endpoint

**User Story:** As a developer, I want each service to expose a health endpoint, so that Docker can tell when a service is ready.

#### Acceptance Criteria

1. THE Gateway, Orders, and Payments SHALL each expose a `GET /health` endpoint that returns HTTP 200 with a JSON body `{ "status": "ok", "service": "<service name>" }`.
2. THE `/health` endpoint SHALL NOT call any downstream service.

### Requirement 9: Load Generator

**User Story:** As a demo operator, I want a load-generator script to send steady traffic to Gateway, so that there is always baseline telemetry visible in Prometheus and the soundscape.

#### Acceptance Criteria

1. THE Load_Generator SHALL send HTTP `POST /order` requests to Gateway continuously in a loop.
2. THE Load_Generator SHALL read the Gateway URL from the `GATEWAY_URL` environment variable, defaulting to `http://localhost:3000`.
3. THE Load_Generator SHALL read the request interval in milliseconds from the `LOAD_INTERVAL_MS` environment variable, defaulting to 500 ms.
4. THE Load_Generator SHALL abort any request that takes longer than 10 seconds so the loop never hangs.
5. WHEN a request fails, THE Load_Generator SHALL log the error to stdout and continue the loop without exiting.
6. THE Load_Generator SHALL log each request's HTTP status code and response time to stdout.

### Requirement 10: Docker Compose Orchestration

**User Story:** As a developer, I want the entire stack to start with one command, so that judges can run a live demo without any manual setup.

#### Acceptance Criteria

1. THE docker-compose.yml SHALL define services for gateway, orders, payments, prometheus, and load-generator.
2. WHEN `docker compose up` is executed, THE stack SHALL start all five services and Prometheus SHALL begin scraping the three application services within 30 seconds.
3. THE Gateway, Orders, Payments, and Prometheus containers SHALL expose ports 3000, 3001, 3002, and 9090 on the host respectively.
4. THE docker-compose.yml SHALL configure the `unless-stopped` restart policy for gateway, orders, payments, and load-generator, so that a crashed service restarts automatically.
5. THE gateway, orders, and payments containers SHALL each have a memory limit of 256 MB, so that a sustained memory leak eventually causes the container to be killed and restarted.
6. THE gateway, orders, and payments containers SHALL each define a Docker healthcheck that calls their `/health` endpoint.
7. THE docker-compose.yml SHALL set `GATEWAY_URL=http://gateway:3000` for the load-generator, `ORDERS_URL=http://orders:3001` for gateway, and `PAYMENTS_URL=http://payments:3002` for orders.
8. THE docker-compose.yml SHALL pass all inter-service URLs and configuration as environment variables, with no hardcoded values in application code.
9. THE repository SHALL contain a `.env.example` file listing every environment variable used across all services and the load generator, with placeholder or default values.

### Requirement 11: Configuration and Environment

**User Story:** As a developer, I want all service configuration to come from environment variables, so that the stack is portable and secrets are never committed.

#### Acceptance Criteria

1. THE Gateway, Orders, and Payments SHALL read their HTTP listen port from the optional `PORT` environment variable, defaulting to 3000, 3001, and 3002 respectively.
2. THE optional variables `DOWNSTREAM_TIMEOUT_MS`, `CHAOS_TTL_SECONDS`, `LEAK_MB_PER_SECOND`, `GATEWAY_URL`, and `LOAD_INTERVAL_MS` SHALL fall back to their documented defaults when absent.
3. THE variables `ORDERS_URL` (Gateway) and `PAYMENTS_URL` (Orders) SHALL be required.
4. IF a required environment variable is absent at startup, THEN THE service SHALL log a descriptive error message naming the variable and exit with a non-zero code.