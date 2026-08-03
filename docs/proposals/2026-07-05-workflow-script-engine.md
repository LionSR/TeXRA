# Workflow script engine: deterministic multi-agent orchestration

Status: implemented (`src/agent/workflowScript/`)
Date: 2026-07-04

Follow-up, 2026-07-27: `pipeline()` and `concat()` were removed after real
workflow dogfooding found no production use and exposed unstable resume order
for multi-stage pipelines. Scripts use `parallel()` plus ordinary JavaScript
control flow. Structured calls are supported through the shared
`submit_output` boundary described below.

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
   (`src/tools/delegation/subagentResults.ts:150`) into an XML string injected into the
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
  tasks: [
    { id: 'introduction', label: 'Draft introduction', phase: 'Draft' },
    { id: 'results', label: 'Draft results', phase: 'Draft' },
    { id: 'merge', label: 'Merge sections', phase: 'Merge' },
  ],
};
phase('Draft');
const drafts = await parallel([
  () => agent('Draft the introduction.', { id: 'introduction' }),
  () => agent('Draft the results.', { id: 'results' }),
]);
phase('Merge');
const valid = drafts.filter(Boolean);
return await agent('Merge these drafts, unify notation.', {
  id: 'merge',
  agentName: 'merge',
  inputFiles: valid.flatMap((d) =>
    d.category === 'workflow' ? d.outputs.map((o) => o.absolutePath) : d.files,
  ),
});
```

When the task set comes from runtime arguments, the script omits `meta.tasks`
and creates one call per input:

```js
export const meta = {
  name: 'audit-sections',
  description: 'Audit every requested section in parallel',
};
return await parallel(
  args.sections.map(
    (section, index) => () =>
      agent(`Audit ${section}.`, {
        id: `section-${index}`,
        label: `Audit ${section}`,
      }),
  ),
);
```

### Primitives

- `meta.tasks` → an optional declarative plan of `{ id, label, phase? }`
  records. When present, every `agent()` call references one record by `id`;
  progress surfaces show the entire plan before execution and update each
  record in place. Data-dependent workflows may omit it.
- `agent(prompt, opts?)` → one subagent run; returns the typed result
  (`null` on failure). Common options are `id`, `label`, `phase`, `agentName`,
  and `model`. File-editing calls accept editable `inputFiles` plus read-only
  `contextFiles` and `mediaFiles`. Structured calls instead provide a JSON
  `schema` and a tool-use `agentName`. Otherwise-identical calls require
  distinct `id` values so restart recovery does not depend on scheduling
  order.
- `parallel(thunks)` → concurrent barrier. Failed `agent()` calls resolve to
  `null`; script errors reject the workflow.
- Ordinary JavaScript loops and awaited calls express sequential chains.
  Native array methods own local filtering and joining; an agent such as
  `merge.yaml` owns reconciliation that genuinely needs a model.
- `log()` / `phase()` / `args` → progress narration, grouping,
  parameterization.

## Design stance: smaller than Claude Code, native to TeXRA

Claude Code's Workflow tool is the proof of pattern, not the spec. TeXRA's
engine should be **less, but wiser** — every feature must earn its place in
an academic-writing product whose unit of work is a document, not a diff.

**Deliberately not adopted (v1):**

- **No token-budget API inside scripts** (`budget.remaining()` loops) — cost
  governance belongs to the host and the user, not to script logic.
- **No nested `workflow()`** — one flat script per delegation. If a workflow
  needs a sub-workflow, that is the orchestrator's decision to make with a
  second delegation, visible in the execution tree.
- **No per-call effort or raw agent-type overrides** — an `agent()` call names
  a TeXRA agent (`agentName`) and may select an available model short name.
  Agent definitions still own their ordinary policy; the explicit model field
  is the declarative exception for assigning lower-cost or specialized work.
- **No worktree isolation** — TeXRA runs are already execution-scoped in run
  storage (`executions/{id}/`), with lineage instead of git.
- **Sequential stages use ordinary JavaScript** — production usage showed that
  `parallel()` plus directly awaited `agent()` chains and file lineage cover
  document pipelines without a second orchestration abstraction.

**TeXRA workflow agents are the unit of work.** `agent()` composes the
existing YAML agents — `merge`, `polish`, `correct`, user-defined agents —
with their native `inputFiles`/`outputFiles` semantics. Reflection rounds
stay _inside_ the agent (scripts compose agents; they do not re-implement
rounds), the `merge` agent is the canonical LLM reduce, native array methods
own local zero-token fan-in, and the engine automates the file hand-off between
stages that today costs two orchestrator round-trips per edge.

**Where TeXRA aims to be better, not bigger:**

1. **Document-native results** — a stage returns one fixed `AgentFinalResult`
   envelope. Workflow results carry `OutputFileSummary[]`, compile failures,
   and line-diff references; tool-use results carry response text and edited
   file paths.
2. **Durable resume** — script + journal persist in the execution KV store,
   so a workflow resumes across host restarts, not just within a session.
3. **Reproducibility as a feature** — deterministic scripts + named agents +
   journals give academics a rerunnable derivation record for how a
   document was produced.
4. **Workflows as first-class artifacts** — a good orchestration is saved
   next to the agent YAMLs as a named, `args`-parameterized asset, and the
   `agentCreator` flow extends naturally to agents authoring workflow
   scripts themselves.

## Design decisions (grounded in the 2026-07 architecture audit)

### 1. Results are consumed typed, never as XML

The engine's `agent()` wraps the in-band subagent execution path
(`src/tools/delegation/subagentExecution.ts`, `stopAfterCycle` branch). The
runtime first completes post-flow work such as diff generation, then returns
the same `AgentFinalResult` object used for persistence and XML delivery. The
FollowUpQueue channel remains untouched for LLM-driven delegation; scripted
runs bypass it entirely.

Each `agent()` return has one of two fixed forms:

```ts
type AgentFinalResult =
  | { category: 'workflow'; outcome; outputs; diffs; compileFailures; cost }
  | { category: 'toolUse'; outcome; response; files; cost };
```

Identity, stream state, wall time, memory misses, and CLI copy destinations
stay outside this envelope. Documents and domain-specific JSON travel as file
artifacts, so a 40-page rewrite or a large data structure never round-trips
through the script as an inline value. The execution store persists the
envelope and `/executions/{id}/result` returns it directly for agent runs.

### 2. Fixed envelopes with one structured-output boundary

Workflow-agent calls retain one fixed `AgentFinalResult` file envelope.
For data-dependent mathematical or analytical fan-out, a call may instead
name a tool-use agent and supply a root-object JSON Schema. That agent
finishes through the existing shared `submit_output` terminal tool; the
workflow receives the validated value in the same result envelope's
`structured` field. Workflow scripts do not add provider-specific
`response_format` or `output_config.format` plumbing.

### 3. Deep layers: one parent-child relation

Execution lineage has one representation: each child records its direct
`parentExecutionId`. There is no numeric delegation depth or separate depth
budget. Script-internal `agent()` calls are ordinary direct children of the
execution that invoked the workflow-script tool, and their streams attach to
that execution's stream through the existing child registry.

The engine does not expose a nested `workflow()` primitive. A workflow script
may launch agents, but those agents cannot recursively launch another workflow
script through the default tool roster. This keeps the production tree flat
without introducing a second lineage policy.

### 4. Concurrency budget (missing today, needed regardless)

Script fan-out needs a bounded resource policy independent of execution
lineage. The engine runs every `agent()` call through one counting semaphore
(prototype default 4; production default should be provider-rate-limit aware).
Excess calls queue. A lifetime call cap (default 200) backstops runaway loops,
and per-call fan-out is bounded.
The same semaphore should eventually gate LLM-driven delegation too.

### 5. Direct chaining reuses existing lineage machinery

The reflection flow already implements "previous round's outputs become this
round's base" (`OutputFileProcessor.similarityBaseFiles`,
`traceFileLineage`) — intra-agent. Workflow scripts use the same shape across
agents: one call's `OutputFileSummary` records become the next call's
`inputFiles` directly from run
storage (`executions/{id}/r{round}/…`) — no `accept_run_files` workspace
copy, no LLM involvement. Rounds that emitted nothing leave symlinks
(`AcceptRunFilesTool` guard); the binding step must skip them.

### 6. Resume via call journal

Every completed `agent()` call is journaled by its call index and a hash of
the prompt plus execution-affecting options. Display labels and phases are
excluded, so revising a declarative task plan does not repeat completed model
work. Re-running with a prior journal replays matching calls from cache and
re-runs only edited or new calls; failed and cancelled calls are not journaled,
so resume retries them. This extends the existing `persistedFlow` checkpoint
pattern and is why scripts must be deterministic — `Date.now()` and
`Math.random()` throw inside the sandbox (pass timestamps via `args`).
Journals persist in the execution KV store alongside the script text.

### 7. One consolidated delivery; full usage roll-up

The script's return value is formatted into a single `<subagent-result>`
delivery to the orchestrator — one context injection for N agents' work,
instead of N interleaved follow-ups bubbling up one layer at a time through
serialized wake-cascades. Because the engine owns the whole tree, it sums
full token usage across children (today only `totalCostUsd` rolls up, by
design, in `ToolUseDispatchNode`).

### 8. Sandbox

The engine runs each script in a fresh QuickJS runtime and context with a CPU
interrupt deadline, bounded heap and stack, disabled dynamic code generation,
no `require`/`process`, and the determinism prelude. Host capabilities and
results cross the boundary only as JSON text. The shared WASM module is embedded
in all three hosts, so packaged execution does not depend on a filesystem path.

## Validation

A live run of Claude Code's Workflow tool over this repo (4 agents:
3 parallel analyzers + 1 synthesizer, ~2.2 minutes
wall-clock) independently confirmed the audit's findings on TeXRA's own
orchestration files — sequential dispatch, delivery-blocking latexdiff,
typed-result flattening, unbounded fan-out — and demonstrated the target UX:
a typed result at every edge, file-backed artifacts, plain-code joins, and one
consolidated result.

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
2. **Canonical `AgentFinalResult` envelope after post-flow artifact work.**
   This is the fixed chaining contract for both workflow and tool-use agents;
   it requires no model-constrained JSON mechanism.
3. **The engine as a `delegate_workflow_script` tool**: prototype engine
   (`src/agent/workflowScript/`) wired to the in-band execution path,
   ordinary `parentExecutionId` lineage, run-storage file binding, journal persistence,
   progress-event bridging onto the existing stream tree (extension board
   already renders arbitrary depth; CLI shows direct children per stream).

## Implementation status

`src/agent/workflowScript/` (host-agnostic, VS Code-free; `runAgent`
injected). Implements: meta parsing/validation (Zod), import ban,
preemptible QuickJS sandbox with determinism guards, `agent()` / `parallel()` /
`log()` / `phase()` / `args`, concurrency
semaphore, call cap, fan-out caps, wall-clock timeout, and journal-based
resume. The Vitest suite in
`src/test-kernel/agent/WorkflowScriptEngine.vitest.ts` covers parsing,
semaphore bounds, failure-to-null, resume replay, determinism guards, and
sandbox-escape prevention. The production tool composes the engine with
in-band child execution and the execution store.
