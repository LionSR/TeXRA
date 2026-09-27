# Effect facility adoption: the four families with zero uses

Date: 2026-09-20
Status: implemented — steps 2 to 5 are on main and step 1 was refused (`EFF-ADOPT-config-provider`); every §4 acceptance line holds. The `process.env` lane §2 step 1 split off is done too (§5).
Baseline: `main` at `3378a967`. Parent survey:
[post-refactor architecture survey](../../proposed/architecture/2026-09-20-post-refactor-architecture-survey.md).

## 1. Finding

Production code is Effect-shaped: 771 `Effect.gen`, 939 `Effect.fn`, 120
`Data.TaggedError` classes, zero `catchAll`, 245 `Stream.` sites, 193
scope and finalizer sites. It is Effect-naive on four families with zero
uses: `Config`, `Metric`, `Cache`, `PubSub` (and the Effect 4 transactional
primitives). Where those families are absent, hand-rolled equivalents live.

| Hand-rolled                                                                                                                                  | Where                                                                                                                                                   | Facility                                                                                        | Lines                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The read side of three config providers and a debug-mode port                                                                                | `src/utils/config/configUtils.ts`, `src/platform/defaults/jsonConfigProvider.ts`, `memoryConfigProvider.ts`, `src/logger/logUtils.ts` `DebugModeConfig` | `Config` + `ConfigProvider` for reads; the writable store stays                                 | 150 to 250                                                                                                                                                                                                                                                                                                  |
| Second logging mechanism: 168 `createLog(` beside 77 `Effect.log*`; `logUtils.ts` declares it deletes itself with its last non-Effect caller | `src/logger/logUtils.ts` and 202 importers                                                                                                              | `Logger` + `Logger.layer` (already done in `effectDiagnostics.ts` and `webviewSessionLayer.ts`) | ~170 plus one mechanism                                                                                                                                                                                                                                                                                     |
| Two spellings of one `[1, 2)` backoff `Schedule`                                                                                             | `src/tools/timeouts.ts` `transientBackoff`, `src/latex/arxivProcessor.ts` `downloadBackoff`                                                             | one shared `Schedule` in a host-neutral module for that contract                                | ~15; ruled real in the 2026-09-17 ledger. `jitteredExponentialBackoffMs` in `src/utils/core` is a different contract (symmetric ±20 % jitter with a cap, used by `ModelRetryGate` and GitHub polling) and is not folded; `timeouts.ts` documents why `Schedule.jittered` would cut the mean wait by a third |
| `AppSignals` as a Node `EventEmitter`                                                                                                        | `src/eventBus/AppSignals.ts`                                                                                                                            | `PubSub` with scoped subscribers                                                                | ~60; costed in the 2026-09-08 findings, not refuted                                                                                                                                                                                                                                                         |
| Two hand-rolled retry loops                                                                                                                  | `src/tools/delegation/workflowScriptAgentRunner.ts`, `packages/extension/src/settingsView/SettingsViewMessageHandler.ts`                                | `Effect.retry` + `Schedule.recurs`                                                              | ~20                                                                                                                                                                                                                                                                                                         |
| About 200 signatures failing with `unknown` while the tagged errors exist; two sites re-derive a tag with `instanceof` then `Effect.die`     | `packages/llm/src/openaiResponses.ts`, `packages/desktop/src/main/desktopFileSelection.ts`, `SessionEvents.ts` `PublicationJob.run`                     | `catchTag`, typed channels                                                                      | ratchet, not deletion                                                                                                                                                                                                                                                                                       |
| Zero tracing, zero metrics                                                                                                                   | 4 `withSpan`, 0 `Metric`                                                                                                                                | `Effect.withSpan`, `Metric`                                                                     | adds code; belongs to the observability plane                                                                                                                                                                                                                                                               |

## 2. Changes

1. ~~Adopt `Config` for the read side of the three providers and the debug
   port~~ — **refused by the 2026-09-21 design panel** (see §3 and
   `EFF-ADOPT-config-provider` in `config/ratchets/refuted-candidates.json`).
   What landed instead is the deletion the proposal was reaching for:
   `src/utils/config/configUtils.ts` is gone and its call sites read
   `config.get(...)` directly, with the path conventions on the
   `ConfigProvider.get` docblock, which also states why `get` stays
   synchronous by contract. The plain-TypeScript readers this step
   enumerated — `postProcessResponse`, `isGoalEnabled`,
   `selectAutoOpenFinalOutput`, `isTelemetryEnabledBySetting` — were correct
   about the code and wrong about the conclusion: each is a pure function of
   `(ConfigProvider, input)` already called inside an Effect program that
   holds the provider as data, so they are the end state, not a facade
   awaiting a boundary. Where `Config` does belong is the ~126 `process.env`
   reads in production — a string source, which is what `ConfigProvider`'s
   node model was built for; that is a separate lane.
2. Finish `Logger`: enumerate the 168 `createLog` sites and convert the
   ones inside Effect programs. `Effect.log*` emits only when its Effect
   runs, so the callers that are deliberately synchronous (the extension's
   process-event handlers, plain registry methods) keep a synchronous facade
   until each moves behind a real execution boundary; `logUtils.ts` deletes
   itself with its last such caller, as its own header says, not before.
   This is the first step of the still-unstarted
   [observability plane](../../proposed/architecture/2026-09-09-observability-plane.md).
   Landed in #13249 and #13274: `createLog` and `logUtils.ts` are gone.
   Calls inside a program use `Effect.log*` with `withLogChannel`. The
   synchronous publication points (process-event handlers, TUI host
   adapters, the trace emitter, pre-runtime and shutdown paths) call
   `writeLogLine` in `@logger/logSink`, which writes to the same host sink
   that the Effect logger layer feeds. That makes one mechanism with two
   entry points, not two loggers.
3. One `[1, 2)` backoff `Schedule` in a host-neutral module, replacing the
   two spellings in `tools/timeouts.ts` and `latex/arxivProcessor.ts`. The
   ±20 % capped helper in `src/utils/core` is a separate contract and stays.
4. `AppSignals` onto `PubSub`, after enumerating its synchronous `emit()`
   callers at host edges (extension registration, settings handlers), where
   listener failures propagate to the caller today. The conversion needs an
   injected boundary at those sites and a stated delivery and error order;
   a direct swap would detach subscribers and change both.
5. A shrink-only baseline for `Effect.Effect<..., unknown, ...>` signatures,
   same mechanism as the effect-migration ratchet. `catchTag` applies where
   the failure is already a tagged member of the typed channel; the
   `instanceof` sites in `openaiResponses.ts` and `desktopFileSelection.ts`
   narrow untagged values thrown by foreign or synchronous APIs and keep a
   deliberate defect branch, so they take `catchIf` or typed construction at
   the boundary, not `catchTag`.

## 3. Not re-proposed

`withPerKeyLane` onto `Semaphore` (Semaphore barges; the lane is FIFO and
offers a synchronous refuse), `ModelRetryGate` onto `Schedule` (a
cross-fiber circuit breaker; `Schedule` is per-fiber), the `SessionEvents`
inbox (already `Queue` and `SubscriptionRef`), `src/tools/timeouts.ts`
(already `Effect.timeoutOrElse` and `Schedule`). These are the first things
an autonomous agent will suggest; the refactorability-gates proposal makes
them machine-refused.

The platform config providers onto an Effect `ConfigProvider` (design panel,
2026-09-21): refused, and the step-1 branch that adopted it reverted. Wrapping
the platform port's own `get` in an Effect `ConfigProvider` buys nothing, the
read stays synchronous and answers for the workspace the caller was handed,
and naming each row a second time as `Config.Boolean`/`Config.Int` beside the
Zod catalog row that owns it is a dual schema system with a `ConfigError`
where `readSettingFrom`'s validation already stands. Settings stay
synchronous by ruling: `ConfigProvider.get` (`src/platform/interfaces.ts`)
and `JsonConfigProvider.get` keep their signatures. Effect `Config` is for
`process.env` reads, a separate lane.

## 4. Acceptance

- `src/utils/config/configUtils.ts` does not exist and no `readConfig(` call
  remains; `ConfigProvider.get` keeps its synchronous signature (pinned by
  `EFF-ADOPT-config-provider`), and Effect `Config` adoption is scoped to
  `process.env` reads as a separate lane.
- `src/logger/logUtils.ts` does not exist.
- One implementation per documented backoff contract: one shared `[1, 2)`
  `Schedule` and the ±20 % capped helper in `src/utils/core`; no third
  spelling.
- `src/eventBus/AppSignals.ts` imports no `node:events`.
- No production `Effect.Effect<..., unknown, ...>` or
  `Effect.fn.Return<..., unknown, ...>` remains: the shrink-only
  `unknown-error-baseline.json` reached zero and was retired for the
  hardcoded rule in `unknownErrorChannelRatchet.vitest.ts`.

## 5. The `process.env` lane

`src/utils/system/envFlags.ts` owns it: `processEnvConfigLayer` serves Effect
`Config` from the live `process.env`, and `envVar` / `envFlag` read through it.
The composition roots and the CLI's pre-runtime run install the layer. Tests
provide a record instead of mutating the process. The last two
programs that read a named variable straight from the process now use
`envVar` as well: the WSL check in the CLI's `launchBrowser` and the
`CLAUDE_CODE_OAUTH_TOKEN` check in the plugin availability report.

The reads left in production code fall into four groups, and none of them
belongs in `Config`:

- **Whole-environment enumeration for a child process.** `inheritedEnv`,
  `gitEnv`, the MCP `serverEnv`, the desktop PTY's `ptyEnvironment` and
  `withExtendedPath` copy or filter every variable. `Config` reads named
  leaves; it cannot list the environment. The Claude agent's OAuth check
  reads the record `buildClaudeAgentEnv` hands the subprocess, so that it
  agrees with what Claude Code sees.
- **Build constants.** esbuild's `define` inlines the four `TEXRA_CLI_*`
  validation-model switches in `validationModel.ts` at bundle time, so a
  runtime provider never sees them.
- **Reads before the runtime exists, or deliberately synchronous code.**
  These are the desktop `userData` override (`app.setPath` runs before
  `ready`), the dev renderer URL that `scripts/dev.mjs` sets for window
  creation, the CLI ambient state and colour detection, `platformPaths`
  (resolved synchronously at startup), the ruled-synchronous PTY host
  (`RT-desktop-pty-host-effect`), and the `packages/llm` constructors that
  refuse `*_CUSTOM_HEADERS`.
- **Writes.** The extension's startup `PATH` extension mutates the process
  environment on purpose, so that child processes inherit it.

The pager keeps its own `PAGER` read. `PAGER=` (empty) disables paging, and
`envVar` reads empty and unset alike, so moving it to `Config` would lose the
signal that `git` and `man` users rely on.
