# Workflow script engine: deterministic multi-agent orchestration

Status: proposal + prototype (`src/agent/workflowScript/`)
Date: 2026-07-04

## Problem

TeXRA's multi-agent orchestration is entirely LLM-in-the-loop, which makes it
slow and token-expensive in three compounding ways:

1. **Every orchestration decision costs a full model round-trip.** The
   tool-use loop (`src/agent/core/flows/ToolUseRoundFlow.ts`) is
   `Prep → Call → Process → Dispatch → repeat`; "delegate to A, then B, then
   merge" burns a model call between every hop.
2. **Tool calls execute sequentially even when the model parallelizes.**
   `ToolUseDispatchNode` inherits `BatchNode`'s sequential for-loop
   (`src/agent/node/index.ts`), so N `tool_use` blocks = N serial executions.
   `ParallelBatchNode` is documented in
   `docs/pocketflow/core_abstraction/parallel.md` but not implemented.
3. **Results and files only flow between agents through an LLM.** A child's
   typed `AgentFlowResult` is flattened by `formatSubagentDelivery`
   (`src/tools/subagentResults.ts`) into an XML string injected into the
   parent's conversation; chaining one agent's output into another's input
   requires the orchestrator to call `accept_run_files` and re-list paths —
   two more model round-trips per pipeline edge.

## Proposal

Adopt the workflow-script pattern (as shipped in Claude Code's Workflow
tool): the orchestrator LLM writes a small JS script **once**; a
deterministic engine parses and executes it in a sandbox, exposing
orchestration primitives. Loops, fan-out, joins, dedup, and reduction run as
plain code with zero model round-trips between steps. The LLM plans; the
engine orchestrates.

```js
export const meta = {
  name: 'draft-chapter',
  description: 'Draft sections in parallel, then merge with shared notation',
  phases: [{ title: 'Draft' }, { title: 'Merge' }],
};
phase('Draft');
const drafts = await parallel(
  args.sections.map(
    (s) => () =>
      agent(`Draft the "${s.title}" section.`, {
        label: `draft:${s.title}`,
        inputFiles: s.notes,
        schema: DRAFT_SUMMARY_SCHEMA,
      }),
  ),
);
phase('Merge');
const valid = drafts.filter(Boolean);
return await agent('Merge these drafts, unify notation.', {
  agentName: 'merge',
  inputFiles: valid.flatMap((d) => d.outputs.map((o) => o.path)),
});
```

### Primitives

- `agent(prompt, opts?)` → one subagent run; returns the typed result
  (`null` on failure). Options: `label`, `phase`, `schema`, `agentName`,
  `inputFiles`.
- `parallel(thunks)` → concurrent barrier; failed thunks resolve to `null`.
- `pipeline(items, ...stages)` → per-item stage chains with **no barrier**
  between stages (wall-clock = slowest single-item chain, not
  sum-of-slowest-per-stage). A throwing stage drops that item to `null`.
- `concat(parts, {separator}?)` → zero-token fan-in for ordered text parts
  (the common "chapter = N drafted sections" case). LLM merge (via a
  combiner agent such as `merge.yaml`) stays available for reconciliation
  that genuinely needs a model.
- `log()` / `phase()` / `args` → progress narration, grouping,
  parameterization.

## Design decisions (grounded in the 2026-07 architecture audit)

### 1. Results are consumed typed, never as XML

The engine's `agent()` wraps the in-band subagent execution path
(`src/tools/delegation/subagentExecution.ts`, `stopAfterCycle` branch) and
consumes `executeAgent`'s `onCompleted(result)` / `onError` callbacks —
receiving `AgentFlowResult` _before_ it is flattened to the XML follow-up
string. The FollowUpQueue channel remains untouched for LLM-driven
delegation; scripted runs bypass it entirely.

Each `agent()` return is two-tier:

```
{ structured?, lastResponse?, outputs: OutputFileSummary[], executionId, costUsd }
```

Small data travels inline in the script; large artifacts (documents) travel
by file reference. A 40-page LaTeX rewrite never round-trips through the
script as a string.

### 2. `outputSchema`: the structured-output prerequisite

There is currently **no** schema-constrained final answer anywhere in the
agent stack — a child returns free-text `lastResponse` or file paths. Add an
optional `outputSchema` to the delegation/agent config: when set, the
child's final turn is forced through a synthetic `StructuredOutput` tool
(works on every provider, since all model handlers already do tool calling),
validated with Zod, retried on mismatch, and stored as a new
`structured?: unknown` field on `AgentFlowResult`.

This is what turns orchestration glue into code: parallel reviewers return
`{findings: [...]}` → plain-JS dedupe by file+line → parallel verifiers per
finding → filtered synthesis, with no LLM needed to parse prose between
arrows. It also benefits the existing LLM orchestrator independently of the
engine, and aligns with the "terminal outcome as data" direction already
ruled in `docs/proposals/error-pipeline-and-ownership.md` (`ResultEvent`).
Naming: the script-facing option on `agent()` is `schema` (brevity inside
scripts); `outputSchema` is the `executeAgent`-level config field it maps
to.

### 3. Deep layers: scripted orchestration costs zero delegation depth

The delegation depth budget is a hard 1–5
(`src/shared/constants/delegationPolicy.ts`), and every hop burns a level.
Script-internal `agent()` calls are deterministic code, not LLM delegation:
the engine spawns children at the **workflow's own depth**, not `+1` per
call, so only LLM-visible hops (orchestrator → workflow tool; an agent
inside the workflow that itself delegates) consume budget. Otherwise a
three-stage pipeline exhausts the budget on glue.

Nested `workflow()` is allowed **one level only** (child shares the parent's
semaphore, abort signal, and cost roll-up). This keeps trees comprehensible
and limits exposure to the fail-closed depth-recovery path
(`computeDelegationDepthFromStorage` → `UNKNOWN_DELEGATION_DEPTH`), whose
risk grows with tree height.

### 4. Concurrency budget (missing today, needed regardless)

There is no semaphore, queue, or cap anywhere: N delegations in one round =
N unbounded concurrent LLM streams, each able to fan out again — the only
limiter in the system is depth. The engine runs every `agent()` call through
one counting semaphore (prototype default 4; production default should be
provider-rate-limit aware). Excess calls queue. A lifetime call cap
(default 200) backstops runaway loops, and per-call fan-out is bounded.
The same semaphore should eventually gate LLM-driven delegation too.

### 5. Stage chaining generalizes existing lineage machinery

The reflection flow already implements "previous round's outputs become this
round's base" (`OutputFileProcessor.similarityBaseFiles`,
`traceFileLineage`) — intra-agent. `pipeline()` generalizes it across
agents: the edge payload is `OutputFileSummary` records, and the engine
binds stage N's outputs as stage N+1's `inputFiles` directly from run
storage (`executions/{id}/r{round}/…`) — no `accept_run_files` workspace
copy, no LLM involvement. Rounds that emitted nothing leave symlinks
(`AcceptRunFilesTool` guard); the binding step must skip them.

### 6. Resume via call journal

Every completed `agent()` call is journaled by (call index, hash of
prompt+options). Re-running with a prior journal replays matching calls from
cache and re-runs only edited or new calls; failed calls are not journaled,
so resume retries them. This extends the existing `persistedFlow` checkpoint
pattern and is why scripts must be deterministic — `Date.now()` and
`Math.random()` throw inside the sandbox (pass timestamps via `args`).
Journals persist in the execution KV store alongside the script text.
Known limitation: `agent()` calls issued from `pipeline()` stages beyond the
first acquire journal indices in completion order, which varies run-to-run
with agent latency; the per-index key check keeps replay safe (a mismatch
forces a live re-run), but multi-stage pipelines see lower resume cache-hit
rates than sequential scripts.

### 7. One consolidated delivery; full usage roll-up

The script's return value is formatted into a single `<subagent-result>`
delivery to the orchestrator — one context injection for N agents' work,
instead of N interleaved follow-ups bubbling up one layer at a time through
serialized wake-cascades. Because the engine owns the whole tree, it sums
full token usage across children (today only `totalCostUsd` rolls up, by
design, in `ToolUseDispatchNode`).

### 8. Sandbox

Prototype: `node:vm` with code generation disabled, no `require`/`process`,
determinism prelude. This is an isolation convenience, not a hardened
security boundary — acceptable while scripts are generated exclusively by
TeXRA's own orchestrator and the only reachable capabilities are the
injected primitives. If scripts ever come from untrusted sources (shared
workflow libraries), swap `sandbox.ts` for quickjs-emscripten (WASM; works
in all three hosts) behind the same `runScriptInSandbox` signature.

## Validation

A live run of Claude Code's Workflow tool over this repo (4 agents:
3 parallel schema-constrained analyzers + 1 synthesizer, ~2.2 minutes
wall-clock) independently confirmed the audit's findings on TeXRA's own
orchestration files — sequential dispatch, delivery-blocking latexdiff,
typed-result flattening, unbounded fan-out — and demonstrated the target UX:
structured JSON at every edge, plain-code joins, one consolidated result.

## Build order

1. **Concurrency semaphore + parallel dispatch of independent tool calls**
   (`ToolUseDispatchNode`; per-tool `parallelSafe` flag or read-only
   allowlist). Safety fix plus the cheap latency win; no new dependencies.
   Prerequisite: the single shared abort-controller slot must become
   per-call. _Landed (2026-07-04)_: tools declare `parallelSafe` on `ITool`
   (set via `defineTool`), and contiguous runs of parallel-safe calls
   dispatch concurrently under a shared semaphore with a batch-scoped abort
   controller; duplicate parallel calls fan out the primary's result instead
   of burning a model turn on a synthetic error; subagent report persistence
   runs concurrently with parent delivery; and `FollowUpQueue` coalesces
   contiguous synthetic follow-ups into one turn.
2. **`outputSchema` / `structured` on `executeAgent` + `AgentFlowResult`.**
   Independently useful; the load-bearing prerequisite for scripted
   map-reduce.
3. **The engine as a `delegate_workflow_script` tool**: prototype engine
   (`src/agent/workflowScript/`) wired to the in-band execution path,
   zero-depth child spawning, run-storage file binding, journal persistence,
   progress-event bridging onto the existing stream tree (extension board
   already renders arbitrary depth; CLI shows direct children per stream).

## Prototype status

`src/agent/workflowScript/` (host-agnostic, VS Code-free; `runAgent`
injected). Implements: meta parsing/validation (Zod), import ban,
`node:vm` sandbox with determinism guards, `agent()` / `parallel()` /
`pipeline()` / `concat()` / `log()` / `phase()` / `args`, concurrency
semaphore, call cap, fan-out caps, wall-clock timeout, and journal-based
resume. 18 Vitest cases in
`src/test-kernel/agent/WorkflowScriptEngine.vitest.ts` cover parsing,
no-barrier pipeline semantics, semaphore bounds, failure-to-null, resume
replay, and determinism guards. Not yet wired to `executeSubagent` — see
`src/agent/workflowScript/README.md` for the integration checklist.
