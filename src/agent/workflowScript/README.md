# Workflow script engine (prototype)

Deterministic, script-driven multi-agent orchestration: the orchestrator LLM
writes a small JS script **once**, and this engine executes its control flow
(loops, fan-out, joins, reduction) as plain code — zero model round-trips
between steps. Design rationale and the full findings that motivated it:
`docs/proposals/2026-07-05-workflow-script-engine.md`.

## Shape

```js
export const meta = {
  name: 'draft-chapter',
  description: 'Draft sections in parallel, then merge',
  phases: [{ title: 'Draft' }, { title: 'Merge' }],
};
phase('Draft');
const sections = await parallel(
  args.sections.map(
    (s) => () => agent(`Draft the "${s}" section.`, { label: `draft:${s}` }),
  ),
);
phase('Merge');
return concat(sections, { separator: '\n\n' });
```

- `agent(prompt, opts?)` — one subagent run; resolves to the host runner's
  typed result, or `null` on failure (filter with `.filter(Boolean)`).
  Set `opts.model` to an available model short name when a call needs a
  different cost or capability profile; otherwise ordinary delegation policy
  chooses the model. An explicitly selected model that is unavailable aborts
  the workflow rather than resolving that call to `null`.
  `agent(prompt, { schema })`, where `schema` is a JSON Schema object, runs a
  tool-use agent (name one via `agentName`) that finishes by calling
  `submit_output`; the call resolves to an envelope whose `.structured` is the
  validated object rather than edited files.
- `parallel(thunks)` — concurrent barrier; failed thunks resolve to `null`.
- `pipeline(items, ...stages)` — per-item stage chains with **no barrier**
  between stages; a throwing stage drops that item to `null`. Each stage is
  called `(prevValue, originalItem, index)`; the first stage's `prevValue`
  is seeded with the item itself, so later stages can still reach the
  original item and its index without threading them through return values.
- `concat(parts, {separator}?)` — zero-token fan-in for text parts;
  drops `null`/`undefined` (failed stages) and empty strings.
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
  manifests before passing them to a later stage.
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
  cross-process lock.
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
  host-side. Crucially, the fan-out primitives (`parallel`, `pipeline`,
  `concat`) run **inside the realm** as a trusted prelude — they consume
  script-created arrays, thunks, and promises, so running them host-side
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
  prompt/options hash), and a rerun with a prior journal replays matching
  calls from cache, re-running only edited or new calls. Failed and cancelled
  calls are not journaled, so resume retries them. Caveat: `agent()` calls made from
  `pipeline()` stages beyond the first get indices in completion order,
  which varies run-to-run — the per-index key check keeps replay safe, but
  multi-stage pipelines see lower journal cache-hit rates. Durable child
  identity instead uses the prompt/options hash, so a shifted journal index
  does not repeat completed model work. Otherwise-identical calls must provide
  distinct `id` options; ambiguous duplicates fail before launch.
- **Budgets**: one concurrency semaphore (default 4) across all `agent()`
  calls, a live-call cap (default 200; journal replays are free), a fan-out cap per
  `parallel()`/`pipeline()` call, and a wall-clock timeout. The cap and
  timeout raise `WorkflowRunAbortError`, which the realm-side
  `parallel()`/`pipeline()` match by name and deliberately do NOT convert
  to `null` — the whole run fails. On timeout
  guest execution is interrupted, the run's `AbortSignal` (on every
  `runAgent` invocation) fires, and new `agent()` calls are refused; runners
  should cancel in-flight work on it.
- **Debuggability**: a thrown error inside a `parallel()` thunk or
  `pipeline()` stage (a script bug, as opposed to an `agent()` failure,
  which already resolves to `null` with its own `agent:end` event) is
  logged via a `log` event before the slot becomes `null`.

## Production integration

The opt-in `delegate_workflow_script` tool composes the production in-band
subagent runner, durable checkpoint store, task-run file hand-off, progress
projection, parent cancellation, and completed-journal cost settlement. It
ships in the built-in `orchestrator` agent's tool list
(`prompts/agents/remote/orchestrator.yaml`); explicitly naming the tool in an
agent's configuration is one half of the consent boundary for automated
workflow fan-out. The other half is global: the "Workflow Script" toggle in
the Tools dashboard (`src/tools/externalToolDefs.ts`, id `workflow-script`)
strips `delegate_workflow_script` from every agent's resolved tools when
switched off, regardless of what any individual agent configuration names —
and new installs start with the switch off.

Domain-specific structures should travel as JSON output files rather than
per-call result schemas. Cost settlement covers completed logical calls retained
in the journal; failed or cancelled attempts can consume additional quota before
they become durable.
