# Workflow script engine (prototype)

Deterministic, script-driven multi-agent orchestration: the orchestrator LLM
writes a small JS script **once**, and this engine executes its control flow
(loops, fan-out, joins, reduction) as plain code — zero model round-trips
between steps. Design rationale and the full findings that motivated it:
`docs/proposals/workflow-script-engine.md`.

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
- `parallel(thunks)` — concurrent barrier; failed thunks resolve to `null`.
- `pipeline(items, ...stages)` — per-item stage chains with **no barrier**
  between stages; a throwing stage drops that item to `null`. Each stage is
  called `(prevValue, originalItem, index)`; the first stage's `prevValue`
  is seeded with the item itself, so later stages can still reach the
  original item and its index without threading them through return values.
- `concat(parts, {separator}?)` — zero-token fan-in for text parts;
  drops `null`/`undefined` (failed stages) and empty strings.
- `log(msg)` / `phase(title)` / `args` — progress + parameterization.

## Boundaries (deliberate for the prototype)

- **Host-agnostic**: the engine never spawns agents itself; hosts inject a
  `runAgent` callback. Production wiring should use the in-band subagent
  execution path so the engine consumes the post-flow `AgentFinalResult`
  envelope — never the XML follow-up delivery string.
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
  calls from cache, re-running only edited or new calls. Failed calls are
  not journaled, so resume retries them. Caveat: `agent()` calls made from
  `pipeline()` stages beyond the first get indices in completion order,
  which varies run-to-run — the per-index key check keeps replay safe, but
  multi-stage pipelines see lower resume cache-hit rates.
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

## Not yet built (production integration)

- Production `runAgent` wiring that returns the fixed `AgentFinalResult`
  envelope after workflow diffs have been generated.
- File hand-off: binding a stage's `outputs` (`OutputFileSummary[]`) as the
  next stage's `inputFiles` directly from run storage, without an
  `accept_run_files` round-trip. Domain-specific structures travel as JSON
  output files rather than per-call result schemas.
- A `delegate_workflow_script` tool + journal persistence in the execution
  KV store, and progress-event bridging onto the existing stream tree.
