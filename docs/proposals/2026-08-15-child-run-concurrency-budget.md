# One child-run concurrency budget

Status: design note (Wave-4 prerequisite for item 4 of
`2026-08-14-delegation-flow-substrate-consolidation.md`)
Date: 2026-08-15

## The resource being budgeted

One **live native child model conversation** — a child `executeAgent` /
`resumeToolUseFromResumeData` flow execution between launch and its
terminal/WAITING boundary. That is the unit that consumes provider rate
capacity. Explicitly *not* budgeted:

- **Root runs.** The user launched each one deliberately; capping them turns
  an explicit user action into a silent queue. Roots stay uncapped.
- **Agent-CLI children** (claude/codex/bash). External processes on the
  user's own subscriptions — the same boundary the cost contract draws
  (`ChildRunPorts`): not TeXRA-billed, not TeXRA-gated.
- **Script governance.** The workflow engine's per-run semaphore
  (`concurrency`, default 4), its lifetime call cap, and `MAX_FANOUT` shape
  what a *script* may request; they stay where they are. The budget gates
  what the *process* may run at once.
- **Generic tool calls.** `ToolUseDispatchNode`'s `PQueue({ concurrency: 4 })`
  gates parallel-safe tool calls (`read_file`, `grep`); routing the budget
  through it would throttle file reads while leaving child lifetimes ungated
  — ruled out by the proposal.

## Scope ruling: per session, count-based (provider-key-aware deferred)

Provider rate limits are per API key, so per-provider-key is the *true*
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
  fan-out from opening unbounded model conversations. v1 ships this as a
  module constant; the user-facing core setting (Zod schema + native
  settings view wiring) is recorded follow-up, not part of this change.
  Per-provider-key partitioning is likewise a recorded refinement: when
  credential resolution is exposed pre-launch, the single session budget
  becomes `max(perKeyBudgets)` without moving the acquisition site.

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

  *Consequence:* a workflow-script run's grandchildren ride the workflow
  run's single slot even when the script's semaphore runs several of them
  concurrently. That is deliberate for v1 — the alternative (charging each
  grandchild) requires a reentrant lease passed through
  `workflowScriptAgentRunner` to avoid the nested deadlock, and the engine
  semaphore already bounds grandchild fan-out per run. Recorded as the
  known soft spot: the budget under-counts scripted fan-out by up to
  `engine.concurrency − 1` per workflow child.

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
- No provider-key partitioning in this change (recorded refinement above).
- No cap on root runs or agent-CLI children.
- No change to engine semaphore, lifetime call cap, or fan-out caps.
