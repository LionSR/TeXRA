# One child-run concurrency budget

Status: implemented

## The resource being budgeted

One **live native child model conversation**: a native child run's turn,
driven by `childRunLoop` (`packages/harness/src/agent/runtime/childRunLoop.ts`)
between launch and its settled or waiting boundary. That is the unit that
consumes provider rate capacity. Explicitly _not_ budgeted:

- **Root runs.** The user launched each one deliberately; capping them turns
  an explicit user action into a silent queue. Roots stay uncapped.
- **Agent-CLI children** (claude/codex/bash). External processes on the
  user's own subscriptions: not TeXRA-billed, not TeXRA-gated. A process
  child's loop never acquires (`childRun !== undefined`).
- **Generic tool calls.** The tool-use dispatch runs parallel-safe calls
  (`read_file`, `grep`) up to `MAX_PARALLEL_TOOL_CALLS`
  (`runtime/loop/toolUseDispatch.ts`); routing the budget through it would
  throttle file reads while leaving child lifetimes ungated.

## Scope: per session, count-based

- **One budget per session**, held by the session's runs
  (`RunRegistry.childRunBudget`, `runtime/runRegistry.ts`). Two sessions
  never share a budget.
- **Count-based.** Provider rate limits are per API key, but the key
  resolves after launch assembly. Per-provider-key partitioning is
  **rejected** (maintainer ruling, 2026-08-15: overengineering). The
  per-session count budget is the final shape; do not re-propose
  provider-key partitioning.

## Single acquisition boundary

Nested sites must not each acquire: at a budget of 1 that deadlocks
immediately. The rule:

> **The budget is acquired at exactly one boundary: the child-run loop,
> around each native turn it drives.** Nothing above it (the `agent` tool,
> scripts) or below it (`executeAgent`, which also serves roots) touches the
> session's semaphore.

`executeAgent` serves root runs and cannot tell a detached child turn from
an in-band one; the loop is already the single driver of every child turn.
A launch says whether its loop is `budgeted` (`detachedChildRun.ts`).

## Inheritance

- **In-band children inherit the parent's slot (free).** An awaited `agent`
  call runs its child while the parent is blocked inside the tool call
  (`inBandSubagentRun.ts`, `budgeted: false`), so physical concurrency is
  unchanged. Charging the child a second slot deadlocks nested delegation
  when parents occupy every slot while awaiting children.
- **Detached children take a fresh slot.** A background `agent` call
  (`subagentRun.ts`), a background script (`codemode/backgroundScript.ts`)
  and a resumed child (`resumeRun.ts`) launch `budgeted: true`: the parent
  keeps running, so physical concurrency grows by one.
- **A script's awaited `agent()` calls** run beside each other under a
  per-script semaphore sized to the same configured budget
  (`launchChildAgent`, `tools/delegation/AgentTool.ts`, the script-shared
  `agent:budget`). Each call holds one permit for its whole duration, so the
  calls start in the order the script issued them and at most the budget run
  at once. The children themselves are in-band and ride the script run's
  slot. Known soft spot: a script can run up to `budget − 1` more
  conversations than the session's semaphore counts. Charging them needs a
  reentrant permit and stays deferred.
- **Waiting releases.** A child that suspends waiting holds no model
  conversation; the loop acquires per turn (`loop.budget.withPermit(turn)`),
  so its slot frees at the turn boundary.

## Failure semantics

Acquisition queues rather than rejects: a burst of background `agent` calls
launches children that start as slots free. There is no timeout. A starving
child is visible as a registered, unstarted run, and a queued launch ends
cleanly if its parent is cancelled.

## The setting

- Key `texra.childRunConcurrencyBudget` (`CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY`),
  bounds and copy in `CHILD_RUN_CONCURRENCY_BUDGET_SETTING`
  (`packages/harness/src/shared/schemas/coreSettings.ts`), catalog row
  `childRunConcurrencyBudget` in `shared/state/stateSettings.ts`, shown in the
  settings view's Agents tab and the CLI `/config` panel.
- `0` (the default) means auto: `os.availableParallelism()` clamped to
  1–100. Explicit values are integers 1–100. Model conversations are network
  bound, so the core count is a floor for useful parallelism, not a ceiling.
- `resolveChildRunConcurrencyBudget` (`runtime/childRunBudget.ts`) is the one
  host-side owner of the number; `packages/harness/src/shared` stays free of
  `node:os` because the settings webview loads it. The child-run loop and the
  `agent` tool's per-script semaphore both read it there.
- `RunRegistry.childRunBudget(permits)` makes the semaphore on first call and
  resizes it on every later one, so a settings change takes effect at the
  next child launch.
