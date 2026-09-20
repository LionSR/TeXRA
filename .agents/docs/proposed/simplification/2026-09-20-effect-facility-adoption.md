# Effect facility adoption: the four families with zero uses

Date: 2026-09-20
Status: proposed
Baseline: `main` at `3378a967`. Parent survey:
[post-refactor architecture survey](../architecture/2026-09-20-post-refactor-architecture-survey.md).

## 1. Finding

Production code is Effect-shaped: 771 `Effect.gen`, 939 `Effect.fn`, 120
`Data.TaggedError` classes, zero `catchAll`, 245 `Stream.` sites, 193
scope and finalizer sites. It is Effect-naive on four families with zero
uses: `Config`, `Metric`, `Cache`, `PubSub` (and the Effect 4 transactional
primitives). Where those families are absent, hand-rolled equivalents live.

| Hand-rolled                                                                                                                                  | Where                                                                                                                                                   | Facility                                                                                        | Lines                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Three config providers and a debug-mode port                                                                                                 | `src/utils/config/configUtils.ts`, `src/platform/defaults/jsonConfigProvider.ts`, `memoryConfigProvider.ts`, `src/logger/logUtils.ts` `DebugModeConfig` | `Config` + `ConfigProvider`                                                                     | 150 to 250                                          |
| Second logging mechanism: 168 `createLog(` beside 77 `Effect.log*`; `logUtils.ts` declares it deletes itself with its last non-Effect caller | `src/logger/logUtils.ts` and 202 importers                                                                                                              | `Logger` + `Logger.layer` (already done in `effectDiagnostics.ts` and `webviewSessionLayer.ts`) | ~170 plus one mechanism                             |
| Three copies of jittered exponential backoff                                                                                                 | `src/utils/core/index.ts`, `src/tools/timeouts.ts`, `src/latex/arxivProcessor.ts`                                                                       | one shared `Schedule` in a host-neutral module                                                  | ~25 plus dedup; ruled real in the 2026-09-17 ledger |
| `AppSignals` as a Node `EventEmitter`                                                                                                        | `src/eventBus/AppSignals.ts`                                                                                                                            | `PubSub` with scoped subscribers                                                                | ~60; costed in the 2026-09-08 findings, not refuted |
| Two hand-rolled retry loops                                                                                                                  | `src/tools/delegation/workflowScriptAgentRunner.ts`, `packages/extension/src/settingsView/SettingsViewMessageHandler.ts`                                | `Effect.retry` + `Schedule.recurs`                                                              | ~20                                                 |
| About 200 signatures failing with `unknown` while the tagged errors exist; two sites re-derive a tag with `instanceof` then `Effect.die`     | `packages/llm/src/openaiResponses.ts`, `packages/desktop/src/main/desktopFileSelection.ts`, `SessionEvents.ts` `PublicationJob.run`                     | `catchTag`, typed channels                                                                      | ratchet, not deletion                               |
| Zero tracing, zero metrics                                                                                                                   | 4 `withSpan`, 0 `Metric`                                                                                                                                | `Effect.withSpan`, `Metric`                                                                     | adds code; belongs to the observability plane       |

## 2. Changes

1. Adopt `Config` across the three providers and the debug port. Settings
   reads become typed, defaulted and testable without a fake platform, which
   also moves suites from the kernel tier to the pure tier.
2. Finish `Logger`: enumerate the 168 `createLog` sites, convert, delete
   `logUtils.ts`. This is the first step of the still-unstarted
   [observability plane](../architecture/2026-09-09-observability-plane.md).
3. One `Schedule` for backoff in `src/utils/core`; the three copies go.
4. `AppSignals` onto `PubSub`.
5. A shrink-only baseline for `Effect.Effect<..., unknown, ...>` signatures,
   same mechanism as the effect-migration ratchet, plus a rule that
   `instanceof` followed by `Effect.die` must become `catchTag`.

## 3. Not re-proposed

`withPerKeyLane` onto `Semaphore` (Semaphore barges; the lane is FIFO and
offers a synchronous refuse), `ModelRetryGate` onto `Schedule` (a
cross-fiber circuit breaker; `Schedule` is per-fiber), the `SessionEvents`
inbox (already `Queue` and `SubscriptionRef`), `src/tools/timeouts.ts`
(already `Effect.timeoutOrElse` and `Schedule`). These are the first things
an autonomous agent will suggest; the refactorability-gates proposal makes
them machine-refused.

## 4. Acceptance

- `grep -r "Config\." src packages/*/src` is non-zero; the three providers
  are gone.
- `src/logger/logUtils.ts` does not exist.
- One `jitter` implementation in production.
- `src/eventBus/AppSignals.ts` imports no `node:events`.
- `config/ratchets/unknown-error-baseline.json` exists and shrinks.
