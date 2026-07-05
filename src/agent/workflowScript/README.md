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
  between stages; a throwing stage drops that item to `null`.
- `concat(parts, {separator}?)` — zero-token fan-in for text parts.
- `log(msg)` / `phase(title)` / `args` — progress + parameterization.

## Boundaries (deliberate for the prototype)

- **Host-agnostic**: the engine never spawns agents itself; hosts inject a
  `runAgent` callback. Production wiring should use the in-band subagent
  execution path so the engine consumes the typed `AgentFlowResult` — never
  the XML follow-up delivery string.
- **Sandbox**: `node:vm` with code generation disabled and no
  `require`/`process`. Host primitives are installed behind **realm-local
  bridge wrappers** (`sandbox.ts`): scripts never hold host-realm callables
  or objects — async results cross as JSON and are revived with the
  sandbox's own `JSON.parse`, and host errors are re-thrown as realm-local
  Errors. This closes the classic `fn.constructor('return process')()`
  escape. Script bodies are forced into strict mode so sandbox-authored
  thunks invoked from host code cannot walk `arguments.callee.caller` to a
  host function. Known hard limit: `node:vm` cannot preempt CPU-bound
  continuations after an `await` (`await agent(...); while (true) {}`
  blocks the event loop, defeating both the vm timeout and the wall-clock
  timer) — the preemptible-isolate swap (quickjs-emscripten) behind the
  same `runScriptInSandbox` signature is a **hard gate** before this engine
  is wired to a `delegate_workflow_script` tool.
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
  calls, a lifetime call cap (default 200), a fan-out cap per
  `parallel()`/`pipeline()` call, and a wall-clock timeout. The cap and
  timeout raise `WorkflowRunAbortError`, which `parallel()`/`pipeline()`
  deliberately do NOT convert to `null` — the whole run fails. On timeout
  the run's `AbortSignal` (on every `runAgent` invocation) fires and new
  `agent()` calls are refused; runners should cancel in-flight work on it.
- **Debuggability**: a thrown error inside a `parallel()` thunk or
  `pipeline()` stage (a script bug, as opposed to an `agent()` failure,
  which already resolves to `null` with its own `agent:end` event) is
  logged via a `log` event before the slot becomes `null`.

## Not yet built (production integration)

- `outputSchema` on `executeAgent` so `agent(..., {schema})` returns
  validated structured data instead of prose.
- Depth semantics: script-internal `agent()` calls should spawn children at
  the workflow's own delegation depth (scripted orchestration is not LLM
  delegation and must not burn the depth budget).
- File hand-off: binding a stage's `outputs` (`OutputFileSummary[]`) as the
  next stage's `inputFiles` directly from run storage, without an
  `accept_run_files` round-trip.
- A `delegate_workflow_script` tool + journal persistence in the execution
  KV store, and progress-event bridging onto the existing stream tree.
