---
inclusion: always
---

# Roadmap: where the build is

## Done
- `victim-app` spec: all tasks complete (`.kiro/specs/victim-app/tasks.md`).
- `haunting-engine` spec: tasks 1–17 complete (`.kiro/specs/haunting-engine/tasks.md`),
  including Docker/compose, integration tests and final calibration.

## Next phase: `engine-intelligence` (ML layer for the haunting-engine)
- No spec exists yet. Create `.kiro/specs/engine-intelligence/` with
  requirements → design → tasks, and get each reviewed before writing code.
- Scope: learned anomaly baselines (EWMA + z-scores, fixed-threshold fallback during
  warm-up), memory-exhaustion forecasting, and similarity-based incident matching.
- All new logic is pure functions plugged into the existing PollerService pipeline
  (see structure.md). New events and snapshot fields go in `shared/`.

## Later phases (in order)
1. `haunted-house` (Next.js frontend): one room per service, a generative soundscape
   mapped to real metrics, chaos triggers in the UI, and display of the ghost's messages.
   - Consumes the engine's Socket.IO events; import event types from `shared/`, never
     redefine them.
   - Chaos triggers call the haunting-engine's chaos proxy only, never the victim-app's
     `/chaos/*` endpoints directly.
2. `ghost-narrator`: server-side LLM explanations of incidents, with caching, rate
   limiting and a fallback message when the API is unavailable. API keys never reach
   the browser.
3. Deployment, demo video, write-up.

## Known open issues to keep in mind
- After a fast payments restart, failed requests stay in the 15s rate window, so the
  engine can miss the outage or blame orders/gateway. Recorded in
  `.kiro/specs/haunting-engine/design.md`; deliberately left for now. The frontend
  should not present those attributions as certain.

## Keep this file current
When a phase finishes, move it to Done and write the next phase here.