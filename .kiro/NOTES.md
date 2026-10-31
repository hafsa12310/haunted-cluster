# Kiro Dev Journal — The Haunted Cluster

## Format
Date | Kiro feature | What happened | Good/Bad | Why it matters

## Entries
- 2026-10-31 | Steering | Wrote product, tech, structure docs. Kiro correctly described my stack when asked. | Good | Saves me repeating conventions in every prompt.
- 2026-10-31 | Specs (requirements) | Reviewed Kiro's first requirements draft and found real problems: chaos would have applied to /metrics and /chaos/reset, the memory leak used Buffers (invisible to heapUsed) and was far too slow to see, and downstream 5xx errors didn't propagate. Rewrote the requirements before any code existed. | Mixed | Kiro's draft looked complete but had demo-breaking bugs; reviewing the spec caught them at zero cost.
- 2026-10-31 | Specs (design) | Three design review rounds. Caught that NestJS middleware runs before interceptors (injected chaos would be invisible to metrics), that reading status in finalize() records 502/504 as 200, and that 'finish' misses aborted requests (switched to 'close' + 499). | Good | These bugs would only have shown up after building everything with vibe coding; spec review found them on paper.
- 2026-10-31 | Specs (tasks) | Refined tasks.md: made all tests required, moved the exception filter and health controller into shared libs, added Jest path-alias config, ValidationPipe in every app, and integration tests. | Good | The task list is the build plan; fixing it up front prevents duplicated code and a failing first checkpoint.
- 2026-10-31 | Agent hooks | Created a hook that runs `jest --findRelatedTests` on the saved file (with --passWithNoTests) whenever a .ts file in apps/ or libs/ is saved. | Good | Instant feedback on every save instead of discovering several failures at once at a checkpoint.
- 2026-10-31 | Scaffolding | Kiro's tsconfig used baseUrl, which is deprecated in TypeScript 6. Removed it and made the path aliases relative (./libs/...). | Bad → fixed | Showed the value of reviewing generated config rather than accepting it blindly.