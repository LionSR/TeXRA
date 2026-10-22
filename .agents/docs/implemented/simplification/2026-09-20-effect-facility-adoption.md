# Effect facility adoption: which facility replaces what

Date: 2026-09-20
Status: implemented. Steps 2 to 5 below are on main; step 1 was refused
(`EFF-ADOPT-config-provider`). The `process.env` lane step 1 split off is done
too (§5).

## 1. Finding

In 2026-09 the production code was Effect-shaped but used four Effect
families not at all (`Config`, `Metric`, `Cache`, `PubSub`), and hand-rolled
equivalents stood where they were absent. This note records which facility
took over from which hand-rolled mechanism, and which candidates were refused.

| Hand-rolled (before)                                  | Facility now                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Read side of the config providers (`configUtils.ts`)  | Deleted; callers read `config.get(...)` directly. Not `Config` (refused, §3).                                            |
| Second logging mechanism (`createLog`, `logUtils.ts`) | `Effect.log*` with `withLogChannel` (`@logger/effectLog`); synchronous call sites use `writeLogLine` (`@logger/logSink`) |
| Two spellings of one `[1, 2)` backoff                 | One `randomizedExponentialBackoff` `Schedule` (`packages/harness/src/utils/core/backoffSchedule.ts`)                     |
| `AppSignals` as a Node `EventEmitter`                 | `PubSub` with scoped subscribers (`packages/harness/src/eventBus/AppSignals.ts`)                                         |
| `Effect` signatures failing with `unknown`            | Typed channels; the rule is absolute (`src/test-kernel/architecture/unknownErrorChannelRatchet.vitest.ts`)               |
| Direct `process.env` reads in Effect programs         | Effect `Config` through `envVar` / `envFlag` (`packages/harness/src/utils/system/envFlags.ts`), §5                       |

Tracing and metrics (`Effect.withSpan`, `Metric`) add code rather than
replace any; they belong to the observability plane, not here.

## 2. Changes

1. ~~Adopt `Config` for the read side of the config providers~~ — refused
   (§3, `EFF-ADOPT-config-provider`). What landed instead is the deletion the
   proposal was reaching for: `configUtils.ts` is gone and its call sites read
   `config.get(...)` directly, with the path conventions on the
   `ConfigProvider.get` docblock (`packages/harness/src/platform/interfaces.ts`),
   which also states why `get` stays synchronous. Readers that are pure
   functions of `(ConfigProvider, input)`, already called inside an Effect
   program that holds the provider as data, are the end state, not a facade
   awaiting a boundary.
2. One logging mechanism with two entry points. Calls inside a program use
   `Effect.log*` with `withLogChannel`. The synchronous publication points
   (process-event handlers, TUI host adapters, the trace emitter, pre-runtime
   and shutdown paths) call `writeLogLine` in `@logger/logSink`, which writes
   to the same host sink that the Effect logger layer feeds.
3. One `[1, 2)` backoff `Schedule`, `randomizedExponentialBackoff`, used by
   `packages/harness/src/tools/timeouts.ts` and
   `packages/texra/src/latex/arxivProcessor.ts`. The ±20 % capped helper
   `jitteredExponentialBackoffMs` (`packages/harness/src/utils/core/index.ts`,
   used by `ModelRetryGate` and GitHub polling) is a different contract and
   stays: `Schedule.jittered` over the `[1, 2)` contract would cut its mean
   wait by a third.
4. `AppSignals` runs on `PubSub`. Each subscriber drains its own subscription
   on its own fiber, so a listener failure no longer propagates to the
   emitter's caller; the module header states the delivery contract.
5. No production `Effect.Effect<..., unknown, ...>` or
   `Effect.fn.Return<..., unknown, ...>`. The shrink-only baseline reached
   zero and was replaced by the hardcoded rule in
   `unknownErrorChannelRatchet.vitest.ts`. `catchTag` applies where the
   failure is already a tagged member of the channel; an untagged value from a
   foreign or synchronous API is narrowed with `catchIf` or typed at the
   boundary (`ensureError`), not `catchTag`.

## 3. Not re-proposed

`withPerKeyLane` onto `Semaphore` (Semaphore barges; the lane is FIFO and
offers a synchronous refuse), `ModelRetryGate` onto `Schedule` (a
cross-fiber circuit breaker; `Schedule` is per-fiber), the `SessionEvents`
inbox (already `Queue` and `SubscriptionRef`), and
`packages/harness/src/tools/timeouts.ts` (already `Effect.timeoutOrElse` and
`Schedule`). These are the first things an autonomous agent will suggest;
`config/ratchets/refuted-candidates.json` makes them machine-refused.

The platform config providers onto an Effect `ConfigProvider` (design panel,
2026-09-21): refused. Wrapping the platform port's own `get` in an Effect
`ConfigProvider` buys nothing: the read stays synchronous and answers for the
workspace the caller was handed, and naming each row a second time as
`Config.Boolean`/`Config.Int` beside the Zod catalog row that owns it is a dual
schema system with a `ConfigError` where `Settings.get`'s validation already
stands. Settings stay synchronous by ruling: `ConfigProvider.get`
(`packages/harness/src/platform/interfaces.ts`) and `JsonConfigProvider.get`
(`packages/harness/src/platform/defaults/jsonConfigProvider.ts`) keep their
signatures. Effect `Config` is for `process.env` reads (§5).

## 4. Acceptance

- `configUtils.ts` does not exist; `ConfigProvider.get` keeps its synchronous
  signature (pinned by `EFF-ADOPT-config-provider`).
- `logUtils.ts` does not exist.
- One implementation per documented backoff contract: the shared `[1, 2)`
  `Schedule` and the ±20 % capped helper; no third spelling.
- `packages/harness/src/eventBus/AppSignals.ts` imports no `node:events`.
- No production error channel is spelled `unknown`
  (`unknownErrorChannelRatchet.vitest.ts`).

## 5. The `process.env` lane

`packages/harness/src/utils/system/envFlags.ts` owns it. Effect programs read
the environment through Effect `Config`, served by the `ConfigProvider` that
`processLayer` installs (`nodePlatform`'s `ConfigProvider.fromEnvRecord` over
the project's `.env` and the live `process.env`); `envVar` and `envFlag` read
through it. Tests provide a record instead of mutating the process.

The reads left in production code fall into four groups, and none of them
belongs in `Config`:

- **Whole-environment enumeration for a child process.** `inheritedEnv`,
  the git environment, the MCP server environment, the desktop PTY's
  `ptyEnvironment` and `withExtendedPath` copy or filter every variable.
  `Config` reads named leaves; it cannot list the environment. The Claude
  agent's OAuth check reads the record `buildClaudeAgentEnv` hands the
  subprocess, so that it agrees with what Claude Code sees.
- **Build constants.** esbuild's `define` inlines the four `TEXRA_CLI_*`
  validation-model switches in `validationModel.ts` at bundle time, so a
  runtime provider never sees them.
- **Reads before the runtime exists, or deliberately synchronous code.** The
  desktop `userData` override (`app.setPath` runs before `ready`), the dev
  renderer URL that `packages/desktop/scripts/dev.mjs` sets for window creation, the CLI
  ambient state and colour detection, `platformPaths` (resolved synchronously
  at startup), the ruled-synchronous PTY host (`RT-desktop-pty-host-effect`),
  and the `packages/llm` constructors that refuse `*_CUSTOM_HEADERS`.
- **Writes.** The extension's startup `PATH` extension mutates the process
  environment on purpose, so that child processes inherit it.

The pager keeps its own `PAGER` read. `PAGER=` (empty) disables paging, and
`envVar` reads empty and unset alike, so moving it to `Config` would lose the
signal that `git` and `man` users rely on.
