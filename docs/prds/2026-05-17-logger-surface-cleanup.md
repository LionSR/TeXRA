---
created: 2026-05-17
updated: 2026-05-17
---

# PRD: Logger Surface Cleanup

## Status: Draft

## Context

This PRD is a continuation of
[`2026-02-21-logging-pipeline-refactor.md`](./2026-02-21-logging-pipeline-refactor.md). That
PRD's Phases 0–3 have shipped:

- Winston, `VSCodeTransport`, `LogChannelRegistry`, `StreamEventQueue`,
  `StreamTabsManager`, and the frontend `pendingLogUpdates` buffer are
  gone.
- `StreamLog`, `StreamLogStore`, and `WebviewBridge` (16 ms frame-capped
  IPC with `LOG_DELTA`) are in production.
- `AsyncLocalStorage.run()` replaced `enterWith()` for group scoping;
  several follow-ups hardened the edge cases.

Phase 4 of that PRD was a two-bullet "cleanup":

> 1. Remove `logUtils.ts` intermediate layer (inline into `AgentLogger`)
> 2. Remove `filterUtils.ts`

This PRD scopes Phase 4 against what's actually deletable. A first pass
overstated the opportunity by assuming `structuredLogger.ts` had no
external consumers — it does (the CLI). The honest scope is smaller.

## Problem

Three small modules carry their own weight in friction but very little
in value:

- `filterUtils.ts` (20 L) — one function (`getEmitFilter`), one
  production caller (`AgentLogger`).
- `logOptions.ts` (11 L) — two interfaces, three callers, with
  `LogUtilsOptions` _also_ defined separately in
  `platform/interfaces/log.ts` (different shape, same name).
- `structuredLogger.ts` (184 L) — three features (`MemorySink`,
  `swapSink()`, sync `group()`) exist only to satisfy their own test
  file. Their removal trims ~40 lines without touching any real caller.

Plus a small barrel cleanup:

- `src/logger/index.ts` re-exports `createStructuredLogger`, `Logger`,
  `LogFields`, `LogRecord`, `LogSink` — but `grep "from '@logger'"`
  finds no consumer (every importer uses the deep path
  `@logger/structuredLogger`). Dead re-exports.

Finally, every concrete `LogBackend` implementation ignores
`options.isAgent / groupId / messageType / data`. Those fields exist on
the `LogUtilsOptions` interface in `platform/interfaces/log.ts` but only
the test `RecordingLogBackend` ever reads them — and no test asserts on
them (`grep` confirms). The fields propagate type noise through ~10
call sites for no behavioral benefit.

None of this affects users. It affects the time-to-orient of a new
contributor opening `src/logger/`.

## Goals & Non-Goals

### Goals

- Inline `filterUtils.ts` into `AgentLogger`. Delete the file and its
  test.
- Inline `logOptions.ts` into its three callers (`AgentLogger`,
  `logUtils`, and the one extension settings file that imports
  `LogUtilsOptions`). Delete the file.
- Remove dead features from `structuredLogger.ts`: `MemorySink`,
  `swapSink()`, sync `group()`. Trim the matching test cases.
- Drop the dead barrel re-exports from `src/logger/index.ts`.
- Drop the dead `isAgent / groupId / messageType / data` fields from
  `LogBackend`'s options type. Rename or replace `LogUtilsOptions` in
  `platform/interfaces/log.ts` so the name no longer collides with the
  logger-side type.

### Non-Goals

- **Do not delete `structuredLogger.ts`.** The CLI's runtime host
  depends on its `LogSink`, `LogRecord`, `Logger`,
  `createStructuredLogger` surface
  (`packages/cli/src/runtime/runtimeHost.ts:5-32`,
  `packages/cli/src/runtime/logSinks.ts:5,68,80`). The earlier
  feasibility note's "fold into logUtils" plan would break the CLI.
- **Do not unify `@agent/core/logger` with `AgentLogger`/`logUtils`.**
  They serve different audiences (infrastructure diagnostics vs.
  user-visible transcript). Merging would push tool/latex/auth noise
  into the transcript.
- **No public-API changes.** Every method signature on `AgentLogger`,
  `logUtils`, `@agent/core/logger`, and `LogBackend.{debug,info,warn,error}`
  stays the same.
- **No work on `StreamLog`, `StreamLogStore`, `WebviewBridge`, or the
  CLI `subscribeStreamLog` cursor protocol.** Those are load-bearing and
  out of scope.
- **No scoped-logger refactor.** Deferred per the original PRD's
  "Future" section.

## Current State

### Module inventory (verified)

| Module                                | Lines |                                    Production importers | Notes                                 |
| ------------------------------------- | ----: | ------------------------------------------------------: | ------------------------------------- |
| `src/logger/AgentLogger.ts`           |   606 |                                                      72 | Main facade                           |
| `src/logger/StreamLogStore.ts`        |   872 |                                             4 (+ tests) | Untouched here                        |
| `src/logger/StreamLog.ts`             |   151 |                                               via store | Untouched here                        |
| `src/logger/logUtils.ts`              |   183 |                                                      71 | Channel-keyed text logger + group ctx |
| `src/logger/structuredLogger.ts`      |   184 |       3 (`logUtils`, CLI `logSinks`, CLI `runtimeHost`) | Stays; trim dead features             |
| `src/logger/filterUtils.ts`           |    20 |                                       1 (`AgentLogger`) | Delete                                |
| `src/logger/logOptions.ts`            |    11 | 3 (`AgentLogger`, `logUtils`, `SettingsHandlerContext`) | Delete                                |
| `src/logger/index.ts`                 |    17 |                                0 barrel consumers found | Prune dead re-exports                 |
| `src/agent/core/logger.ts`            |    53 |                                                      27 | Out of scope                          |
| `src/platform/interfaces/log.ts`      |    17 |                                               type-only | Rename/inline `LogUtilsOptions`       |
| `src/platform/defaults/consoleLog.ts` |    26 |                     2 (`desktop`, `@agent/core/logger`) | Out of scope                          |

### What `structuredLogger.ts` actually exports vs. what's used

| Export                                         | External consumers               | Decision                               |
| ---------------------------------------------- | -------------------------------- | -------------------------------------- |
| `LogSink` interface                            | CLI logSinks + logUtils          | **Keep**                               |
| `LogRecord` interface                          | CLI logSinks + logUtils          | **Keep**                               |
| `Logger` interface                             | CLI runtimeHost + logUtils       | **Keep**                               |
| `LogFields` interface                          | (only internal + type re-export) | Keep (used by `Logger.debug/info/...`) |
| `createStructuredLogger(sink)`                 | CLI runtimeHost + logUtils       | **Keep**                               |
| `Logger.withGroup(label, fn)`                  | logUtils only                    | **Keep**                               |
| `Logger.activeGroupId()`                       | logUtils only                    | **Keep**                               |
| `Logger.child(fields)`                         | logUtils only                    | **Keep**                               |
| `Logger.group(label)` (sync, returns leave fn) | — none —                         | **Delete**                             |
| `Logger.swapSink(next)`                        | — none (only its own test) —     | **Delete**                             |
| `MemorySink` class                             | — none (only its own test) —     | **Delete**                             |

`grep` evidence: `swapSink` appears in `structuredLogger.ts` and
`structuredLogger.test.ts` only. `MemorySink` likewise. No production
caller of sync `.group(`.

### `LogUtilsOptions` collision

The name is defined twice with different shapes:

- `src/logger/logOptions.ts`:
  ```ts
  interface LogOptions {
    groupId?;
    messageType?;
    data?;
  }
  interface LogUtilsOptions extends LogOptions {
    isAgent?;
  }
  ```
- `src/platform/interfaces/log.ts`:
  ```ts
  interface LogUtilsOptions {
    isAgent?;
    data?;
    groupId?;
    messageType?: string;
  }
  ```

Subtle difference: the platform copy types `messageType` as plain
`string` while the logger copy types it as `MessageType` (the Zod enum).
Today no code triggers the divergence because no `LogBackend` impl reads
`messageType`.

### `LogBackend` options-field usage audit

| Impl                    | Path                                             | Reads `options.*`?               |
| ----------------------- | ------------------------------------------------ | -------------------------------- |
| `consoleLog`            | `src/platform/defaults/consoleLog.ts`            | No — ignores `options` entirely  |
| `cliPlatformLog`        | `packages/cli/src/runtime/initPlatform.ts:53-60` | No                               |
| `deferredAuthLog`       | `packages/cli/src/runtime/supabaseAuth.ts:55-66` | Passes through, doesn't read     |
| `RecordingLogBackend`   | `src/test/support/FakePlatform.ts:281-315`       | Records `options` for inspection |
| `@agent/core/logger.ts` | facade, not impl                                 | Forwards `options`               |

Asserting tests: `grep "options\." src/test/platform/FakePlatform.test.ts src/test-kernel/platform/FakePlatform.invariants.vitest.ts` returns nothing — no test asserts on the recorded options fields.

Therefore `isAgent / groupId / messageType / data` on `LogBackend`'s
options type are dead weight at runtime _and_ in tests. Drop them.

## Proposed End State

```
AgentLogger
  ├── shouldEmit() / LogOptions  (inlined from filterUtils + logOptions)
  ├── logUtils.debug/info/warn/error      ← channel-keyed text path
  │     └── createStructuredLogger / withGroup / activeGroupId
  │           ← still in structuredLogger.ts (slimmer)
  └── StreamLogStore.append / update      ← unchanged

@agent/core/logger
  └── platform.log: LogBackend  (debug/info/warn/error only — no dead options)

CLI runtimeHost (separate consumer)
  └── createStructuredLogger(NdjsonStdoutSink | StderrTextSink)
        ← unchanged
```

## Migration Phases

Small enough to land in one PR. Phasing is review ergonomics.

### Phase 4a — inline + dedup (low risk, ~30 LOC removed)

| Action                                                                                                                                                            | Files                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Inline `getEmitFilter` into `AgentLogger.ts` as a private function.                                                                                               | `AgentLogger.ts`            |
| Delete `filterUtils.ts` and `filterUtils.test.ts`.                                                                                                                | (deletions)                 |
| Inline `LogOptions` into `AgentLogger.ts`.                                                                                                                        | `AgentLogger.ts`            |
| Inline `LogUtilsOptions` (logger-side) into `logUtils.ts`.                                                                                                        | `logUtils.ts`               |
| Update `packages/extension/src/settingsView/handlers/SettingsHandlerContext.ts:7` to import `LogUtilsOptions` from `@logger/logUtils` (the surviving definition). | `SettingsHandlerContext.ts` |
| Delete `logOptions.ts`.                                                                                                                                           | (deletion)                  |
| Drop dead barrel re-exports from `src/logger/index.ts`: `createStructuredLogger`, `Logger`, `LogFields`, `LogRecord`, `LogSink`.                                  | `index.ts`                  |

**Risk:** trivial. No external API changes. `SettingsHandlerContext.ts`
still gets the same type, just from a different module.

### Phase 4b — slim `structuredLogger.ts` (low risk, ~40 LOC removed)

| Action                                                                                                                                                                                                               | Files                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Delete `MemorySink` class.                                                                                                                                                                                           | `structuredLogger.ts`      |
| Delete `swapSink(next)` method and its `LogSink.flush?/close?` callers. (Keep `LogSink` interface; `flush?` is fine.)                                                                                                | `structuredLogger.ts`      |
| Delete sync `Logger.group(label)` method and its `enterGroup`/`flushOnPop` plumbing.                                                                                                                                 | `structuredLogger.ts`      |
| Trim `structuredLogger.test.ts` to cover only `withGroup` / `activeGroupId` / `child` / `createStructuredLogger`. The "swapSink flushes", "manual group inside async", and "out-of-order closers" cases become dead. | `structuredLogger.test.ts` |

**Risk:** low. No production caller of any of the three deleted
features. The trimmed test still covers the four behaviors
(`logUtils` + CLI) actually depend on.

### Phase 4c — `LogBackend` options-shape cleanup (low risk, ~10 LOC removed)

| Action                                                                                                                                                                                                                                                                                                                                                                       | Files                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Replace `LogUtilsOptions` in `src/platform/interfaces/log.ts` with a `LogBackendOptions` type containing only what real impls might use. Concretely: drop the type entirely and make `LogBackend.{debug,info,warn,error}` take `(channel: string, message: string)` only.                                                                                                    | `platform/interfaces/log.ts`                                                                  |
| Remove the unused `options` param from every `LogBackend` impl: `consoleLog`, `cliPlatformLog`, `deferredAuthLog`, `RecordingLogBackend`.                                                                                                                                                                                                                                    | `consoleLog.ts`, `cli/initPlatform.ts`, `cli/supabaseAuth.ts`, `test/support/FakePlatform.ts` |
| Update `@agent/core/logger.ts` to drop the `options` param from its facade functions.                                                                                                                                                                                                                                                                                        | `agent/core/logger.ts`                                                                        |
| Update the ~27 importer call sites that pass a `LogUtilsOptions`. (Spot check: most pass `{ data: ... }`. The `data` field was never logged by any impl — only recorded by `RecordingLogBackend`. If a caller's diagnostic intent was "include this object in the log line," the call site is already broken — surface that as a follow-up rather than re-adding the field.) | callers                                                                                       |

**Risk:** medium. Touches ~27 importer call sites. Each is a
mechanical drop of the second argument. Type checker will surface every
miss. If a caller turns out to depend on the `data` field being logged
somewhere, surface it as a follow-up — that would mean the original
PRD's "infrastructure log is for diagnostics only" contract was
already informally broken.

**Alternative for 4c:** keep the options type but rename it to
`LogBackendOptions` and explicitly include only what's used (today:
nothing). This avoids touching callers but leaves the dead-args
problem. Recommend the full cleanup unless we discover hidden usage.

### Phase 4d — verify and ship

- `npm run typecheck`
- `npm run lint`
- vitest: `src/test-kernel/logger/`, `src/test-kernel/agent/`,
  `src/test/logger/`, `src/test/platform/`
- Manual smoke: launch desktop, run one agent, verify webview
  transcript + VS Code OutputChannel + group nesting unchanged.

## Estimated impact

| Item                                | Before | After |                                     Delta |
| ----------------------------------- | -----: | ----: | ----------------------------------------: |
| `AgentLogger.ts`                    |    606 |  ~615 |                                        +9 |
| `logUtils.ts`                       |    183 |  ~188 |                                        +5 |
| `structuredLogger.ts`               |    184 |  ~140 |                                       −44 |
| `filterUtils.ts`                    |     20 |     0 |                                       −20 |
| `logOptions.ts`                     |     11 |     0 |                                       −11 |
| `logger/index.ts`                   |     17 |   ~10 |                                        −7 |
| `platform/interfaces/log.ts`        |     17 |   ~10 |                                        −7 |
| Test changes (4 files)              |      — |     — | ~−180 (delete cases for removed features) |
| Per-caller `options` arg drops (4c) |      — |     — |                small per-line cleanup ×27 |
| **Net source**                      |        |       |                                  **~−75** |
| **Net incl. tests**                 |        |       |                                 **~−250** |

Realistic, not aspirational. Smaller than the earlier note's "−500"
because `structuredLogger.ts` stays.

## Open Questions

1. **Should Phase 4c (drop dead `LogBackend` options) ship with 4a/4b
   or as a separate PR?** It's the riskiest of the three because it
   touches ~27 callers. Easy to split if review prefers.

2. **Should `LogBackend` keep an `initialize(channel, isAgent)` method?**
   Only `RecordingLogBackend` records it; `consoleLog` and `cliPlatformLog`
   are no-ops. The `isAgent` flag is also dead in every real impl.
   Likely safe to drop, but out of scope here.

3. **Should we collapse `cli/runtimeHost`'s use of `createStructuredLogger`
   to just calling `.error()` on its sink directly?** The CLI uses only
   one method (`logger.error(...)`) — the whole `Logger` ceremony is
   overkill for that one call site. Would let us delete `child()` /
   `withGroup` from `structuredLogger` too. Tempting but out of scope.

4. **Rename `@agent/core/logger.ts` → `@platform/log` or
   `@logger/infraLog`?** It's not "agent core" — it's a process-wide
   infra logger. Renaming would make the System A / System B split
   obvious at import time. Out of scope; flag for later.

## Success Criteria

1. `npm run typecheck` passes.
2. All vitest suites pass (after the planned test trims).
3. No call site of `AgentLogger`, `logUtils`, or `@agent/core/logger`
   needs a behavior change. Phase 4c may drop a second argument from
   `@agent/core/logger` callers; no logic change.
4. Three source files removed: `filterUtils.ts`, `logOptions.ts`,
   `filterUtils.test.ts`.
5. `git diff --stat src/logger/ src/platform/` shows net deletion ≥60
   lines (4a+4b), or ≥80 lines if 4c ships in the same PR.
6. Manual smoke: identical transcript and OutputChannel output for a
   representative agent run.

## What this PRD does _not_ claim

- It does not promise the logger becomes "Claude Code-simple." TeXRA
  has multi-stream concurrency, history browsing, in-place streaming
  updates, and an IPC boundary. Those are real and require
  `StreamLogStore` (~870 lines of largely justified bookkeeping).
- It does not propose unifying Systems A and B (transcript vs.
  infrastructure loggers). They serve different audiences. Conflating
  them would push `tools/*` infra noise into the user-visible
  transcript.
- It does not propose deleting `structuredLogger.ts`. The CLI's
  runtime host depends on its surface. The earlier feasibility note
  got this wrong; this PRD does not.
- It does not relitigate the original PRD. Phases 0–3 of
  `2026-02-21-logging-pipeline-refactor.md` shipped and work. This is a focused
  cleanup of the layer that PRD waved at in two bullets.
