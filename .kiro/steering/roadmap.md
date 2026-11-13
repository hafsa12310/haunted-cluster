---
inclusion: always
---

# Roadmap: where the build is

## Done
- `victim-app` spec: all tasks complete (`.kiro/specs/victim-app/tasks.md`).
- `haunting-engine` spec: tasks 1–17 complete (`.kiro/specs/haunting-engine/tasks.md`),
  including Docker/compose, integration tests and final calibration.

- `engine-intelligence` spec: all tasks complete (`.kiro/specs/engine-intelligence/tasks.md`).
  Learned anomaly baselines (EWMA + z-scores, fixed-threshold fallback during warm-up),
  memory-exhaustion forecasting and similarity-based incident matching are plugged into
  the PollerService pipeline. The measured memory-leak lead time is about 78 s against
  the 10 s minimum (`INTEGRATION_MIN_LEAD_SECONDS`). Payments is now genuinely
  OOM-killed in compose via `mem_limit` = `memswap_limit`.

## Next phase: `haunted-house` (Next.js frontend)
- No spec exists yet. Create `.kiro/specs/haunted-house/` with
  requirements → design → tasks, and get each reviewed before writing code.
- Scope: one room per service, a generative soundscape mapped to real metrics, chaos
  triggers in the UI, and display of the ghost's messages. Also add a per-client rate limit on the haunting-engine chaos proxy (for example @nestjs/throttler) because the chaos buttons will be public once deployed.
- Consumes the engine's Socket.IO events; import event types from `shared/`, never
  redefine them. This includes the engine-intelligence events and snapshot fields.
- Chaos triggers call the haunting-engine's chaos proxy only, never the victim-app's
  `/chaos/*` endpoints directly.

## Later phases (in order)
1. `ghost-narrator`: server-side LLM explanations of incidents, with caching, rate
   limiting and a fallback message when the API is unavailable. API keys never reach
   the browser.
2. Deployment, demo video, write-up.

## Known open issues to keep in mind
- After a fast payments restart, failed requests stay in the 15s rate window, so the
  engine can miss the outage or blame orders/gateway. Recorded in
  `.kiro/specs/haunting-engine/design.md`; deliberately left for now. The frontend
  should not present those attributions as certain.
- `MEMORY_LIMIT_MB` is now 290, calibrated to the real kill at RSS of about 296 MB
  (256m containers). The countdown ends about 3 s before the crash. The frontend
  should still treat `timeToLimit` as an estimate. Measured lead time is 66 s
  (was 78 s with the limit at 256). Gateway, orders and payments all have
  `memswap_limit` = `mem_limit` and a 240 s chaos TTL.

## Keep this file current
When a phase finishes, move it to Done and write the next phase here.