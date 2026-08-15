# Workflow script engine (prototype)

Deterministic, script-driven multi-agent orchestration: the orchestrator LLM
writes a small JS script **once**, and this engine executes its control flow
(loops, fan-out, joins, reduction) as plain code — zero model round-trips
between steps. Design rationale and the full findings that motivated it:
`docs/proposals/2026-07-05-workflow-script-engine.md`.

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
- `agent(prompt, opts?)` — one subagent run; resolves to the host runner's
  typed result, `null` on failure, or the truthy
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
  subagent execution path, so the engine consumes the post-flow
  `AgentFinalResult` envelope — never the XML follow-up delivery string. It
  also verifies task-run inputs against persisted child lineage and result
  manifests before passing them to a later workflow step.
- **Restart-safe checkpoints**: one strict, versioned execution-KV record per
  tool call stores the script, arguments, and journal atomically. Successful
  live calls are checkpointed before their results return to the script;
  parallel writes and overlapping resumes are serialized, malformed state
  fails loudly, and completed child manifests close the final crash-recovery
  gap without repeating model work. Each stable child attempt records a
  reservation before registration and a launch marker before model work, so a
  failed registration can advance safely while an uncertain launched child is
  never repeated. The parent records the complete attempt sequence, so deleting
  an earlier child cannot hide a later completed result. A parent execution has
  one active runtime owner; the execution KV store is durable state, not a
  cross-process lock. Checkpoints use the strict version-3 schema; malformed or
  older records fail instead of being translated into the current journal.
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
  same call sequence: each `agent()` call is journaled by (call index,
  prompt/execution-options hash), and a rerun with a prior journal replays
  matching calls from cache, re-running only edited or new calls. File-backed
  calls also hash the current bytes of their input, context, and media files,
  so editing a referenced path invalidates both its cached result and stable
  child identity. Display labels and phases do not participate in identity.
  Failed and cancelled calls are not journaled, so resume retries them.
  Otherwise-identical calls must provide distinct `id` options; ambiguous
  duplicates fail before launch.
- **Budgets**: one concurrency semaphore (default 4) across all `agent()`
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
(`prompts/agents/remote/orchestrator.yaml`); explicitly naming the tool in an
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

| Artifact / behavior                                                                                     | Scripted grandchild (`agent()`)                       | Detached child (`delegate_agent`) | Verdict                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/executions/{id}/result` (typed)                                                                       | always persisted (required; failure results included) | persisted                         | **Contract.** The typed result is the engine's consumed value and the sole terminal artifact for scripted children.                                                                                |
| `/executions/{id}/report` (prose)                                                                       | never written                                         | persisted at delivery             | **Contract.** A report would be a second, derivable rendering of the same result; the `executions` tool's `report` action redirects to `/result` for result-only children.                         |
| Parent-facing delivery shape                                                                            | `<workflow-summary>` JSON line on the workflow run    | `<subagent-result>` XML follow-up | **Contract.** One feeds a deterministic script's caller, one feeds a model conversation (see the standing two-surfaces ruling).                                                                    |
| Runner post-conditions (`outcome !== 'completed'` → throw; workflow category with zero outputs → throw) | enforced                                              | absent                            | **Contract.** `agent()` must return a usable value or fail the stage; a conversational parent judges its child's output itself.                                                                    |
| `turnToken` turn attribution                                                                            | absent                                                | stamped by the loop               | **Gap** (recorded, unscheduled). Scripted children are single-turn, so the missing token has no ambiguity to resolve today; it becomes real work only if scripted children gain multi-turn resume. |
