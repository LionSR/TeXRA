# One child-run concurrency budget

Status: implemented — landed (see #10640). Originally a design note / Wave-4 prerequisite
for item 4 of `2026-08-14-delegation-flow-substrate-consolidation.md`.
Date: 2026-08-15

## The resource being budgeted

One **live native child model conversation** — a child `executeAgent` /
`resumeToolUseFromResumeData` flow execution between launch and its
terminal/WAITING boundary. That is the unit that consumes provider rate
capacity. Explicitly _not_ budgeted:

- **Root runs.** The user launched each one deliberately; capping them turns
  an explicit user action into a silent queue. Roots stay uncapped.
- **Agent-CLI children** (claude/codex/bash). External processes on the
  user's own subscriptions — the same boundary the cost contract draws
  (`ChildRunPorts`): not TeXRA-billed, not TeXRA-gated.
- **Script governance.** The workflow engine's per-run semaphore
  (`concurrency`, default 4), its lifetime call cap, and `MAX_FANOUT` shape
  what a _script_ may request; they stay where they are. The budget gates
  what the _process_ may run at once. _Amended 2026-08-29: the semaphore now
  takes its value from the budget — see the amendment at the end._
- **Generic tool calls.** `ToolUseDispatchNode`'s `PQueue({ concurrency: 4 })`
  gates parallel-safe tool calls (`read_file`, `grep`); routing the budget
  through it would throttle file reads while leaving child lifetimes ungated
  — ruled out by the proposal.

## Scope ruling: per session, count-based (provider-key-aware deferred)

Provider rate limits are per API key, so per-provider-key is the _true_
resource — but the provider key resolves inside the model handler, after
launch assembly, and a pre-launch gate cannot read it today without moving
credential resolution forward (a B2-class change). Deferring that, the
ruling is:

- **One budget per `SessionHandle`** (the process/user boundary that already
  owns execution registries and follow-up queues). Two sessions never share
  a budget.
- **Count-based, default 16.** High enough that real concurrent-workflow
  usage (double-digit simultaneous detached runs is normal operating
  practice here) never queues, low enough to stop a runaway recursive
  fan-out from opening unbounded model conversations. v1 shipped this as a
  module constant; the user-facing core setting (Zod schema + native settings
  view wiring) landed as follow-up #10640 (see "Landed implementation" below).
  Per-provider-key partitioning is **rejected** (maintainer ruling,
  2026-08-15: overengineering). The per-session count budget is the final
  shape; do not re-propose provider-key partitioning.

## Single owner per physical execution

The nested sites the proposal lists (engine semaphore ⊃ in-band native
launch; child-run loop ⊃ `strategy.launch`) must not each acquire — at
concurrency 1 that deadlocks immediately. The rule:

> **The lease is acquired at exactly one boundary: where a native child's
> physical flow execution starts** — the child-run loop acquires around each
> turn it drives (`strategy.launch` / `strategy.runTurn`), and nothing
> above it (delegation tools, proposal flow, workflow engine) or below it
> (`executeAgent` itself, which also serves roots) touches the budget.

Why the loop and not `executeAgent`: `executeAgent` serves root runs (never
budgeted) and cannot tell a detached child turn from an in-band one without
widening its options — while the loop is already the single driver of every
detached native child turn, and the in-band path is the explicit second
caller. Two acquisition call sites, one budget, zero double-charging.

## Inheritance ruling

- **In-band children inherit the parent's slot (free).** An in-band child
  (`stopAfterCycle` delegation arm, workflow-script grandchild) runs while
  its parent is blocked awaiting it inside a tool call — the parent's model
  conversation is idle, so the physical concurrency is unchanged. Charging
  the child a second slot deadlocks nested delegation when parents occupy
  every slot while awaiting children (the proposal's named failure). The
  in-band path therefore does **not** acquire.
- **Detached children take a fresh slot.** The parent keeps running
  concurrently, so the physical concurrency genuinely grows by one.
- **A detached workflow-script run itself takes one slot for its own loop
  turn** (it is a live child run) and its grandchildren are in-band —
  covered by the rule above. A workflow child therefore costs one slot plus
  zero per grandchild: the engine's own semaphore remains the fan-out
  governor for scripts, and the process-level budget cannot be multiplied
  by nesting.

  _Consequence:_ a workflow-script run's grandchildren ride the workflow
  run's single slot even when the script's semaphore runs several of them
  concurrently. That is deliberate for v1 — the alternative (charging each
  grandchild) requires a reentrant lease passed through
  `workflowScriptAgentRunner` to avoid the nested deadlock, and the engine
  semaphore already bounds grandchild fan-out per run. Recorded as the
  known soft spot: the budget under-counts scripted fan-out by up to
  `engine.concurrency − 1` per workflow child — which, since the 2026-08-29
  amendment, is `budget − 1`.

- **WAITING releases.** A detached tool-use child that suspends WAITING
  holds no model conversation; its slot releases at the turn boundary (the
  loop acquires per turn, so this falls out of the acquisition site).

## Failure semantics

Acquisition queues (p-queue, per the house rule) rather than rejects: a
burst of `delegate_agent` calls launches children that start as slots free,
matching the workflow engine's existing behavior. No timeout at v1 — a
starving child is visible in the roster as a registered, unstarted
execution, and a queued launch aborts cleanly if its parent is cancelled
(the existing interrupt path already covers pre-launch cancellation).

## Non-goals

- No change to `ToolUseDispatchNode`'s queue/barrier split.
- No provider-key partitioning — ever (maintainer-rejected as
  overengineering; see the scope ruling above).
- No cap on root runs or agent-CLI children.
- No change to the lifetime call cap or fan-out caps. _(The engine-semaphore
  half of this ruling was amended 2026-08-29 — see below.)_

## Landed implementation

Issue #10640 lands the previously-cut user-facing setting:

- Canonical key: `texra.childRunConcurrencyBudget`.
- Default: `0` = auto — this machine's `os.availableParallelism()` clamped
  to 1–100, resolved host-side in `childRunBudget.ts` (amended 2026-08-29;
  was a fixed 16). Explicit values: 1–100 (integer). Validated by
  `ChildRunConcurrencyBudgetSchema`.
- Persistence: workspace-scoped `.texra/config.json` (the settings-view catalog
  row omits `configTarget`, so the write path uses the workspace target).
- Surface: the native VS Code/desktop settings view Multi-Agent tab and, since
  2026-08-29, the CLI `/config` panel (`cliConfig`).
- Runtime: `childRunBudgetFor` re-reads the configured value on every call and
  live re-pins the session queue to it, so the queue always tracks the
  configured value. Absent and invalid persisted values both resolve to auto.
- Provider-key partitioning remains rejected (maintainer ruling) — this
  implementation is per-session count-based only.

## Amendment (2026-08-29): one owner for the number

- The workflow engine's per-run semaphore no longer carries its own product
  value: `workflowScriptStrategy` passes `resolveChildRunConcurrencyBudget()`
  as `concurrency`, so the setting governs scripted fan-out as well as
  detached children. `DEFAULT_CONCURRENCY = 4` in `runWorkflowScript.ts` is
  the library fallback for callers that pass nothing (tests, SDK), not a
  product default. Before this, a workflow's `agent()` calls ran four at a
  time whatever the setting said, and nothing passed the budget through.
- The default became `0` = auto: `os.availableParallelism()` clamped to
  1–100, resolved host-side in `childRunBudget.ts` (`src/shared` stays
  `os`-free because the settings webview loads it). Model conversations are
  network bound, so the core count is a floor for useful parallelism, not a
  ceiling — the setting stays overridable up to 100. The number widget keeps
  working unchanged: `0` is a value in range and the description names its
  meaning, the same shape as `compactionThresholdPercent`'s `0 = disable`.
- Known soft spot, restated: grandchildren still ride the workflow child's one
  slot, so a workflow can now run up to `budget − 1` more conversations than
  the budget counts. Charging grandchildren needs the reentrant lease noted
  above and remains deferred.
