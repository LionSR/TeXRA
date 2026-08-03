# Workflow script async execution: detach the run from the orchestrator turn

> **Historical snapshot (not authoritative).** This file preserves the
> local-before-pull state of the proposal. Refer to the
> [canonical proposal](./2026-07-17-workflow-script-async-execution.md) for
> the current, authoritative version.

Status: audit + proposal → scoped to issues #8712 (core), #8713 (CLI cleanup)
Date: 2026-07-17
Prereqs shipped: durable named checkpoints (#8666/#8651), CLI progress projection (#8672), teachable contract + run log (#8681)

## Framing: this is a convergence, not a new mode

The constraint is to make the system _simpler_. Detaching the run does that
by **removing a dual system**: `delegate_workflow_script` is today the one
delegation tool that bypasses `startChildRunLoop` and delivers synchronously.
Folding it into the existing async path means one delivery mechanism (the
follow-up queue) for all three delegation tools, and lets us **delete** the
synchronous special-casing (inline cost settlement, run-log-in-tool-result,
parent-stage trace projection) and, in a follow-up, the bespoke #8672 CLI
tool-row projection. It is a **full replacement, no sync/async flag** —
keeping both modes would be the exact dual-system trap the constraint forbids;
safe because the tool ships in no default agent YAML. Net elements must trend
down.

## Problem

`delegate_workflow_script` runs **synchronously inside the orchestrator's
tool-call turn**. The parent turn blocks for the whole run — up to the
10-minute wall clock (`meta.timeoutMs`, capped at 60 min) — and the model
gets exactly one thing back: the final tool result. While the run is in
flight the orchestrator cannot do anything else, and the human cannot steer
it beyond a whole-run interrupt.

Claude Code's `Workflow` tool uses the opposite model: the tool returns a
task ID immediately, the run executes as a background task, results arrive as
a `<task-notification>`, and a `/workflows` detail view offers **per-agent
kill / skip / retry** while the run continues. The one capability TeXRA
structurally cannot match today is that mid-run human control, and it is
absent precisely _because_ the run is synchronous.

Note this was a deliberate choice, not an oversight: the sync model was kept
to keep the follow-up-queue / wake machinery (and its self-stall race
history, #7289 / #8093) out of the deterministic engine. This document
audits what reversing that choice actually costs, now that the async
delegation path and the CLI progress projection both exist.

## What "same execution mode" means (and does not)

Even in Claude Code the _script_ still runs to completion in one continuous
engine loop; `agent()` calls resolve synchronously **within the run**. What
is asynchronous is the **run relative to the parent turn**. So this proposal
does **not** touch the QuickJS engine's control flow, the journal, or the
in-band child execution. It changes one thing: the workflow run stops
blocking the orchestrator turn and becomes a **detached execution** — the
same shape `delegate_agent` already is.

## Key finding: the machinery already fits

`startChildRunLoop` (`src/agent/runtime/childRunLoop.ts:491`) is
turn-_capable_ but not turn-_required_. A strategy that omits `runTurn` and
returns `isTerminal() => true` runs exactly once to completion and delivers
through the same follow-up-queue path `delegate_agent` uses.
`createNativeWorkflowStrategy` (`src/tools/delegation/nativeWorkflowStrategy.ts:95`),
which backs the fixed-round `delegate_workflow`, is exactly this shape and is
**run-to-completion, not turn-based**. A workflow-script run is the same kind
of job.

So the async conversion is a **new strategy**, not new runtime:

- **New** `createWorkflowScriptStrategy(params)` — a `ChildRunStrategy` shaped
  like `createNativeWorkflowStrategy`, whose `launch(ports)` calls
  `runPersistedWorkflowScriptWithProgress` (moved out of
  `WorkflowScriptTool.execute`), uses `ports.recordCost` for the final total
  and `ports.notify` for interim phase/log progress, `isTerminal: () => true`,
  no `runTurn`. `formatDelivery` → result + run log; `formatError` → error +
  run log + "resume with same meta.name" hint; `buildResultMeta` → the
  structured result envelope so `/executions/{id}/result` chaining works.
- **Split** `WorkflowScriptTool.execute` into a launch half (mint/derive the
  run executionId, capture `recordSubagentCost` +
  `approvalPromptsUnavailable`/`runtimeUnavailableTools` up front, call
  `registerExecution` + `startChildRunLoop`, return "Launched (async)") and
  the run body (now inside the strategy's `launch`).

Reused unchanged: `startChildRunLoop`, `src/tools/delegation/childRunDelivery.ts` (persist report /
enqueue / wake), the `executions` tool (kill / wait / subscribe / report /
result), and `runPersistedWorkflowScriptWithProgress` itself (with its
`trace`/`onActivity` re-pointed at the run's own stream instead of the parent
tool-call stage).

## The load-bearing hazard: durability across async relaunch

Resume (#8666) works today _because_ the checkpoint is anchored to the stable
orchestrator executionId plus `meta.name`:
`deriveWorkflowScriptCheckpointId({ name, defaultAgent, parentExecutionId })`
where `parentExecutionId` is the orchestrator's execution
(`WorkflowScriptTool.ts:127`), and the journal KV lives on
`getExecutionStore(orchestratorExecutionId)`.

If a detached run minted a fresh random executionId
(`generateExecutionId()`), then **every async relaunch would produce a new
checkpointId, orphan the journal, and destroy resume** — a direct regression
of #8666. This is the central design constraint.

**Resolution:** mint the workflow-run executionId **deterministically** from
the checkpoint identity — `deriveExecutionId({ checkpointId })` — the same
technique the run's `agent()` grandchildren already use. Then a relaunch with
the same `meta.name` from the same orchestrator regenerates the _same_ run
executionId, and registration, checkpoint store, and children all re-root at
that stable ID while resume still replays completed calls for free. This
requires teaching `registerExecution` (or a guard around it) to tolerate
re-registration of an already-known ID on relaunch — the async subagent path
today assumes a fresh random ID.

The journal store and checkpoint key must continue to bind to the
**orchestrator's** executionId + `meta.name`. If they migrate to the
workflow-run executionId, that is fine _only_ because the run executionId is
now itself deterministic from the same inputs; the two identities collapse to
one stable anchor.

## Mid-run steering: mostly free, one real engine gap

Each `agent()` call is **already** a registered execution with a stable
`executionId` (`workflowScriptAgentRunner.ts:27` →
`inBandSubagentExecution.ts:458`) and its own child stream. Therefore:

**Already works (inherited from `delegate_agent` children):**

- **Per-child kill.** CLI `k` in the subagent list resolves the row to an
  `executionId` and calls `executions.kill(executionId)`
  (`SubagentList.tsx:365`); the extension per-stream stop button does the same
  via `stopAgentStream`. A workflow `agent()` child is a normal registered
  execution, so both already target it.
- **Skip + retry-on-resume for free.** Killing one child makes `runAgent`
  reject; `agentPrimitive` resolves that call to `null` and deliberately does
  **not** journal it (`runWorkflowScript.ts:350`), so `.filter(Boolean)`
  fan-outs drop it and the next resume re-runs it. That is skip semantics with
  zero engine change.

**The one genuine engine gap — live single-call skip/retry:** the engine has
exactly one run-level `AbortController` (`runWorkflowScript.ts:205`), shared
by every `runAgent` call (`:342`). There is no per-call controller (contrast
Claude Code's `agentControllers` map keyed by call index), and
`pendingAgentCalls` is a `Set<Promise>` keyed by promise identity, not by
index, so a specific in-flight call cannot be addressed from inside the
engine. A first-class _live_ retry (re-run now, not on next resume) and a
"skip" distinct from "failure" would need:

- a `Map<number, AbortController>` keyed by call index, each linked to
  `runAbort`, passed to `runAgent` instead of the shared signal;
- an external `skip(index)` / `retry(index)` API on the run;
- a decision on the resolved value for a _deliberate_ skip (today only
  fail→null→un-journaled exists).

This is the only substantial new engine plumbing. It is optional — the
detached model delivers non-blocking runs and per-child kill without it, and
live retry can be a fast-follow.

## UI: what has to be rebuilt

The #8672 CLI projection (`workflowScriptProgress.ts`) is built entirely
around finding and patching the **owning tool row** (gated on
`DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME`, keyed to `logId`). A detached run is its
own stream, so its phase/log lines must instead route into a `StreamSlice`
and render through the existing focused-child viewport — a different
mechanism, not a config flip. The workflow's `agent()` children _already_
become real child streams, so only the workflow-run **container** stream and
its phase/log rendering are new work. The extension gets the run as a normal
child stream with its own header/stop for free; a Claude-Code-style flattened
multi-level detail view with per-agent skip/retry buttons does not exist in
either host and would be net-new.

The CLI child list also shows **one level at a time**
(`streamViews.ts:165`) — orchestrator → workflow-run → `agent()` child is a
two-drill-down path, not a single flattened tree. A `WorkflowDetailDialog`
equivalent is a separate, larger UI effort.

## Scope tiers

- **Tier 1 — detach the run (core).** New `createWorkflowScriptStrategy`,
  split `execute` into launch + run body, deterministic run executionId,
  re-point the trace projection to the run's own stream, route progress
  through the child-stream viewport. Delivers: non-blocking orchestrator,
  result-via-follow-up, whole-run kill, per-child kill (inherited), skip +
  retry-on-resume (inherited). This is the "same execution mode" ask.
- **Tier 2 — live per-call steering.** Per-call `AbortController` map,
  `skip(index)`/`retry(index)` engine API, index-addressable
  `pendingAgentCalls`. Delivers: live skip/retry of a single in-flight
  `agent()` call.
- **Tier 3 — detail UI.** A flattened multi-level workflow detail view with
  per-agent controls in CLI and extension.

## Open questions

1. **Re-rooting the grandchildren.** Today the script's `agent()` children
   register with `parentExecutionId`/`parentStreamId` = the _orchestrator_
   (`workflowScriptAgentRunner.ts:99,153`), so the orchestrator can kill a
   grandchild directly. Re-rooting them under the workflow-run execution gives
   a clean 3-level tree but **removes** the orchestrator's direct
   grandchild-kill authority (`executions.kill` gates on _direct_
   `parentStreamId` equality, no transitive kill). Killing the run cascades to
   its in-flight child via the run signal — arguably more correct, but a
   capability change to decide deliberately.
2. **Resume ergonomics.** With the run detached, who relaunches after a crash
   or lease loss — the orchestrator re-issuing `delegate_workflow_script`, or
   a resume-by-executionId path like `delegate_agent execution_id=`? The
   lease-lost watchdog (`childRunLoop.ts:510`) would now interrupt a detached
   run on ownership loss, a behavior the inline version never had.
3. **Is Tier 1 alone worth it?** Non-blocking + per-child kill + retry-on-
   resume may already close most of the gap with Claude Code for TeXRA's
   document-processing domain, deferring Tiers 2–3 until a real workflow needs
   live steering.

## Recommendation

Tier 1 is a real, contained change (~one new strategy file plus an
`execute` split and the deterministic-id guard) that reuses the entire async
delegation runtime and reverses the sync limitation the earlier audit flagged
as the one it "consciously would not fix." The durability hazard has a clean
resolution (deterministic run executionId). Tiers 2 and 3 are genuine
net-new engine and UI work and should be gated on demand, not shipped
speculatively. Recommend building Tier 1, keeping the run executionId
deterministic from day one, and treating live per-call steering as a
fast-follow only if dogfooding shows whole-run kill is too coarse.
