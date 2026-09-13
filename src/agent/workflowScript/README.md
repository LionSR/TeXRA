# Workflow script engine (prototype)

Deterministic, script-driven multi-agent orchestration: the orchestrator LLM
writes a small JS script **once**, and this engine executes its control flow
(loops, fan-out, joins, reduction) as plain code — zero model round-trips
between steps. Design rationale and the full findings that motivated it:
`.agents/docs/archived/feature/2026-07-05-workflow-script-engine.md`.

## Glossary

A **workflow agent** is the agent category whose output is organized into
workflow output rounds. A **workflow script** is the deterministic program run
under `runKind: 'multiAgentWorkflow'`; each `agent()` invocation in that script is
a **workflow call**. A **task run** is the host's stored execution record (and a
**background task** is host-managed asynchronous work), not a workflow call.
A trace **stage** is a generic grouping construct. Script **phases** and
reflection **rounds** are distinct typed stage kinds with different semantics:
phases group calls for progress display, while rounds delimit repeated
reflection iterations.

## Shape

```js
export const meta = {
  name: 'draft-chapter',
  description: 'Draft sections in parallel',
  phases: [{ title: 'Draft' }],
  tasks: [
    { id: 'introduction', label: 'Draft introduction', phase: 'Draft' },
    { id: 'results', label: 'Draft results', phase: 'Draft' },
  ],
};
phase('Draft');
const sections = await parallel([
  () => agent('Draft the introduction.', { id: 'introduction' }),
  () => agent('Draft the results.', { id: 'results' }),
]);
return sections.filter(
  (result) => result !== null && result !== '__WORKFLOW_SKIPPED__',
);
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

- `meta.tasks` — optional declarative task plan. When present, each
  `agent()` call must reference exactly one task with `{ id }`; its display
  label and phase come only from the plan. Progress surfaces can therefore
  show pending work before execution and update one call progress record in
  place.
  Scripts whose call set is data-dependent may omit the plan.
  A plan entry is a **label, not a call**: it carries no agent, model, files,
  or result contract, and nothing guarantees the script reaches it. Status is
  what keeps the two apart in `WorkflowRunSnapshot` — a `declared` call is a
  plan label the script has not issued, and every other status is an issued
  call, carrying the invocation facts (`kind`, plus the declared `model`,
  agent, and file basenames) the script supplied when it called `agent()`. A
  plan entry the run never reaches stays `declared` and settles as
  not-reached. Hosts must not present plan entries as resolved calls, nor
  infer parallelism or dependencies from shared phase membership — the run
  snapshot's `queued`/`running` calls are the only source of real concurrency.
- `agent(prompt, opts?)` — one subagent run; resolves to the host's
  script-facing envelope (the host's `toScriptValue` over the runner's typed
  result: in production the child's output plus `outcome` and `cost`, so a
  workflow call reads `{ category, outcome, outputs, diffs, compileFailures,
cost }` and a tool-use call `{ category, outcome, response, files,
structured, cost }`), `null` on failure, or the truthy
  `'__WORKFLOW_SKIPPED__'` sentinel when an interactive user skips it. Exclude
  both non-results before synthesis.
  Set `opts.model` to an available model short name when a call needs a
  different cost or capability profile; otherwise ordinary delegation policy
  chooses the model. An explicitly selected model that is unavailable aborts
  the workflow rather than resolving that call to `null`.
  `agent(prompt, { schema })`, where `schema` is a JSON Schema object, runs a
  tool-use agent (name one via `agentName`) that finishes by calling
  `submit_output`; the call resolves to an envelope whose `.structured` is the
  validated object rather than edited files.
- `parallel(thunks)` — concurrent barrier. Failed `agent()` calls resolve to
  `null`; other thrown errors reject the workflow.
- Ordinary JavaScript loops and awaited `agent()` calls own sequential control
  flow; array methods such as `.filter()` and `.join()` own local fan-in.
- `log(msg)` / `phase(title)` / `args` — progress + parameterization.
- `files` — immutable, role-separated workspace files bound to the run:
  `files.inputFiles` are editable, while `files.contextFiles` and
  `files.mediaFiles` are read-only. Scripts choose the appropriate subset for
  each workflow-agent call.

## Boundaries (deliberate for the prototype)

- **Host-agnostic**: the engine never spawns agents itself; hosts inject a
  `runAgent` callback. The production adapter in
  `src/tools/delegation/workflowScriptAgentRunner.ts` uses the in-band
  subagent execution path, so the engine consumes the run's `RunEnd`
  (`run.end` payload) — never the XML follow-up delivery string. The journal
  records that `RunEnd`; the strategy's `toScriptValue` flattens it into the
  documented `agent()` envelope at the one script-facing boundary. It
  also verifies task-run inputs against persisted child lineage and result
  manifests before passing them to a later workflow step.
- **Restart-safe checkpoints**: one strict, versioned execution-KV record per
  tool call stores the script, arguments, and journal atomically. Successful
  live calls are checkpointed before their results return to the script;
  parallel writes and overlapping resumes are serialized, malformed state
  fails loudly, and completed child manifests close the final crash-recovery
  gap without repeating model work. The journal replay is checked first: a
  call whose entry already carries a value never reaches a child at all.
  Past it, the child's own run aggregate is the record of what an attempt did.
  `run.start` is the launch edge, and a COMPLETED `run.end` carrying a
  `producer: 'subagent'` `run.result` manifest is durable completion, because
  the terminal row is the post-drain fact: the run settles its ordered
  publisher before committing that row and records a lost drain as a FAILED
  outcome, so a COMPLETED row can never outlive facts the child queued. Which
  ids to probe comes from the parent's own journal, the one thing that
  outlives every child it launches: a `workflow.attempt` row moves the call's
  attempt mark before each launch, and recovery probes the derived ids in
  order from there, so a deleted attempt whose tombstone has since been
  collected cannot read as an id that never started. An attempt that never
  reached `run.start` simply launches, and an attempt no live owner holds that
  settled no `child.turn` and can no longer record an outcome frees the next
  id (a settled turn under no outcome is unrepeatable work: the manifest
  beside it is written for a failed delivery too, so nothing says whether the
  turn succeeded) — a decision taken while holding that attempt's run claim,
  so a resume starting one instant later is refused instead of running beside
  the id this frees. A FAILED or CANCELLED `run.end` frees the next id only
  when no `run.result` manifest sits under it: the manifest commits ahead of
  the turn's settle, so a failed row beside one says the delivery landed and
  only the bookkeeping after it did not. A parent execution has one
  active runtime owner; the execution KV store is durable state, not a
  cross-process lock. Checkpoints use the strict version-4 schema; malformed or
  older records fail instead of being translated into the current journal.
  Deliberately NOT an append-only started/result journal (the shape Claude
  Code's Workflow tool uses): such a log cannot distinguish "never
  finished" from a `null` result, and beside the checkpoint, the commit
  fence, and the child run aggregate it would be a second owner of the
  same fact. Ruled 2026-08-28 (.agents/docs/archived/feature/2026-08-28-workflow-plan-vs-issued-calls.md §Study).
- **Cost ownership**: child costs remain in the persisted typed results. The
  future tool surface must aggregate the final journal at its tool-result
  boundary, rather than mutating parent totals during child launch; this keeps
  live execution, recovered manifests, and journal replay on one accounting
  path.
- **Sandbox**: a fresh QuickJS runtime and context per script, with a CPU
  interrupt deadline, 64 MB heap limit, 1 MB stack limit, dynamic code
  generation disabled, and no `require`/`process`. The WASM module is loaded
  once, while script heaps and interrupt state remain isolated. The boundary
  is **data-only in both directions**
  (`sandbox.ts`): only JSON text crosses it, so neither side ever holds the
  other realm's callables or objects. Scripts reach the host through
  realm-local bridge wrappers whose arguments are stringified realm-side
  (with a pristine, prelude-captured `JSON.stringify`) and whose results
  arrive as JSON revived with the sandbox's own `JSON.parse`; host errors
  are re-thrown as realm-local Errors. The script's own return value is
  reported through a result channel as JSON text rather than awaited
  host-side. Crucially, `parallel()` runs **inside the realm** as a trusted
  prelude — it consumes script-created arrays and thunks, so running it host-side
  would hand the script a host callback (via an overridden `arr.map`) or a
  host resolve function (via a malicious `thenable.then`) whose
  `.constructor` is the host's ungated `Function`. This closes the classic
  `fn.constructor('return process')()` escape in both directions. Script
  bodies are also forced into strict mode. QuickJS promise jobs are pumped
  explicitly, so the same interrupt deadline preempts synchronous loops and
  loops reached after an `await` without blocking the host event loop.
- **Determinism**: `Date.now()`, `Math.random()`, and argless `new Date()`
  throw inside scripts, installed non-writable so scripts cannot restore
  them (`new Date(timestamp)` stays usable). Resume relies on replaying the
  same calls: each `agent()` call is journaled by its prompt/execution-options
  hash — its position is recorded, not part of its identity — and a rerun
  with a prior journal replays matching calls from cache wherever they now
  sit, re-running only edited or new calls (per call, never the
  longest-unchanged-prefix rule Claude Code's Workflow tool applies, which
  re-runs every call after the first change). File-backed
  calls also hash the current bytes of their input, context, and media files,
  so editing a referenced path invalidates both its cached result and stable
  child identity. Display labels and phases do not participate in identity.
  Failed and cancelled calls are not journaled, so resume retries them; so
  is a user's skip — the journal records outcomes of the script's calls, a
  human verdict belongs to the attempt that asked for it, and a resume is a
  new attempt. The checkpoint identity
  is `meta.name` plus the default agent: resuming under a different agent
  starts a new journal.
  Otherwise-identical calls must provide distinct `id` options; ambiguous
  duplicates fail before launch.
- **Budgets**: one concurrency semaphore (the host's child-run budget; library default 4) across all `agent()`
  calls, a live-call cap (default 200; journal replays are free), a fan-out cap per
  `parallel()` call, and a wall-clock timeout. The cap and
  timeout raise `WorkflowRunAbortError`, which `parallel()` does
  not convert to `null` — the whole run fails. On timeout guest execution is
  interrupted, the run's `AbortSignal` (on every
  `runAgent` invocation) fires, and new `agent()` calls are refused; runners
  should cancel in-flight work on it.
- **Debuggability**: a thrown error inside a `parallel()` thunk
  (a script bug, as opposed to an `agent()` failure,
  which already resolves to `null` with its own `agent:end` event) rejects the
  workflow so the saved script can be edited and rerun.

## Production integration

The opt-in `delegate_multi_agents` tool composes the production in-band
subagent runner, durable checkpoint store, task-run file hand-off, progress
projection, parent cancellation, and completed-journal cost settlement. It
accepts exactly one of newly submitted `script` source or an existing
`scriptPath`. New source is saved immediately as a non-overwriting draft under
`.texra/workflow-scripts/`; every result reports that path so a model can edit
and rerun the file instead of reproducing the full script. Phase metadata
accepts both title strings and `{ title }` objects and normalizes them
to one internal representation. It ships in the built-in `orchestrator`
agent's tool list
(`prompts/agents/remote/tool_use/orchestrator.yaml`); explicitly naming the tool in an
agent's configuration is one half of the consent boundary for automated
workflow fan-out. The other half is global: the "Multi-Agent Workflow" toggle
in the Tools dashboard (`src/tools/externalToolDefs.ts`, id `workflow-script`)
strips `delegate_multi_agents` from every agent's resolved tools when
switched off, regardless of what any individual agent configuration names —
and new installs start with the switch off.

Use per-call schemas for compact decisions and synthesis inputs; use output
files when the artifact itself must be edited or passed to another workflow
agent. Cost settlement covers completed logical calls retained in the journal;
failed or cancelled attempts can consume additional quota before they become
durable.

## Grandchild observability contract

A scripted `agent()` grandchild and a `delegate_agent` child are debugged
through different artifacts. Each asymmetry below is a decided contract or a
recorded gap — not an accident:

| Artifact / behavior                                                                                     | Scripted grandchild (`agent()`)                                                                                  | Detached child (`delegate_agent`) | Verdict                                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `/executions/{id}/result` (typed)                                                                       | persisted and verified by read-back (required; failure results carry their structured `error`)                   | persisted                         | **Contract.** The typed result is the engine's consumed value and the authoritative terminal artifact for scripted children.    |
| `/executions/{id}/report` (prose)                                                                       | persisted (since the single-driver fold: one loop persists both artifacts for every child; older runs have none) | persisted at delivery             | **Closed.** The `executions` tool's `report` action still redirects to `/result` for pre-fold executions without one.           |
| Parent-facing delivery shape                                                                            | `<workflow-summary>` JSON line on the workflow run                                                               | `<subagent-result>` XML follow-up | **Contract.** One feeds a deterministic script's caller, one feeds a model conversation (see the standing two-surfaces ruling). |
| Runner post-conditions (`outcome !== 'completed'` → throw; workflow category with zero outputs → throw) | enforced                                                                                                         | absent                            | **Contract.** `agent()` must return a usable value or fail the stage; a conversational parent judges its child's output itself. |
| `turnToken` turn attribution                                                                            | stamped by the loop (since the single-driver fold)                                                               | stamped by the loop               | **Closed.** One driver stamps every manifest.                                                                                   |
