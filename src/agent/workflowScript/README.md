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
const sections =
  yield *
  all([
    attempt(agent('Draft the introduction.', { id: 'introduction' })),
    attempt(agent('Draft the results.', { id: 'results' })),
  ]);
return sections
  .filter((result) => result._tag === 'Success')
  .map((result) => result.value);
```

When the task set comes from runtime arguments, the script omits `meta.tasks`
and creates one call per input:

```js
export const meta = {
  name: 'audit-sections',
  description: 'Audit every requested section in parallel',
};
return (
  yield *
  forEach(args.sections, (section, index) =>
    agent(`Audit ${section}.`, {
      id: `section-${index}`,
      label: `Audit ${section}`,
    }),
  )
);
```

The body is a generator. `agent()`, `all()`, `forEach()`, `attempt()`,
`retry()` and `timeout()` build frozen operation values that run nothing;
`yield*` hands one to the host, which runs it and resumes the script with the
result or throws a failure into it. `await` is a syntax error that the parser
reports with a pointed hint.

- `meta.tasks` — optional declarative task plan. When present, each
  `agent()` call must reference exactly one task with `{ id }`; its display
  label and phase come only from the plan. Progress surfaces can therefore
  show pending work before execution and update one call progress record in
  place.
  Scripts whose call set is data-dependent may omit the plan.
  A plan entry is a **label, not a call**: it carries no agent, model, files,
  or result contract, and nothing guarantees the script reaches it. Status is
  what keeps the two apart on the `workflow.call` card — a `declared` card is
  a plan label the script has not issued, and every other status is an issued
  call, carrying the invocation facts (`kind`, plus the declared `model`,
  agent, and file basenames) the script supplied when it called `agent()`. A
  plan entry the run never reaches stays `declared` and settles as
  not-reached. Hosts must not present plan entries as resolved calls, nor
  infer parallelism or dependencies from shared phase membership — the
  `queued`/`running` cards are the only source of real concurrency.
  The engine publishes its plan, phase and call transitions once, through
  `onEvent`; the host adapter records them as `workflow.plan`, `stage.start`
  / `stage.end` and `workflow.call` rows. Nothing else persists board state,
  and `/executions/{id}` reads the same `workflowRunModel` fold the boards
  paint.
- `agent(prompt, opts?)` — one subagent run; resolves to the host's
  script-facing envelope (the host's `toScriptValue` over the runner's typed
  result: in production the child's output plus `outcome` and `cost`, so a
  workflow call reads `{ category, outcome, outputs, diffs, compileFailures,
cost }` and a tool-use call `{ category, outcome, response, files,
structured, cost }`). A failed call throws an Error named `AgentFailed` into
  the script, and a call the user skips throws `Skipped`.
  Set `opts.model` to an available model short name when a call needs a
  different cost or capability profile; otherwise ordinary delegation policy
  chooses the model. An explicitly selected model that is unavailable aborts
  the workflow rather than failing just that call.
  `agent(prompt, { schema })`, where `schema` is a JSON Schema object, runs a
  tool-use agent (name one via `agentName`) that finishes by calling
  `submit_output`; the call resolves to an envelope whose `.structured` is the
  validated object rather than edited files.
- `all(items, { concurrency })` — concurrent barrier, fail-fast: the first
  failure interrupts the siblings still running (their cards settle
  cancelled) and fails the `all()`. An item is an operation or a generator
  function (a multi-step branch); a called generator is refused.
  `forEach(items, fn, opts)` is realm-side shorthand for `all(items.map(fn))`.
- `attempt(op)` — never fails: `{ _tag: 'Success', value }` or
  `{ _tag: 'Failure', error: { name, message } }`. Tolerant fan-out is
  `all(items.map((x) => attempt(agent(...))))`.
- `retry(op, { times })` — re-runs an operation or a whole branch after
  `AgentFailed` or `TimedOut` (default once, at most 10); a `Skipped` call is
  the user's verdict and is not retried. A re-attempt issuing a call key an
  earlier attempt of the same `retry()` issued is the same call: the
  duplicate-key check admits it, it keeps its card, and if it completed it
  replays from this run's journal instead of running (and billing) again.
- `timeout(op, ms)` — interrupts the operation at the deadline, which reaches
  a child as a stop, and throws `TimedOut`.
- Operation failures (`AgentFailed`, `TimedOut`, `Skipped`) are the only
  failures a script can observe. Run-level faults (`WorkflowRunAbortError`:
  contract faults, the call cap, journal-write failures, the wall clock) and
  the script's own errors (a `TypeError`, its own `Error`) end the run;
  `attempt()` does not turn them into values and `retry()` does not re-run
  them.
- Ordinary JavaScript loops over `yield* agent(...)` own sequential control
  flow; array methods such as `.filter()` and `.map()` own local fan-in.
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
  outcome, so a COMPLETED row can never outlive facts the child queued. That
  completion belongs to a lifecycle, not to the aggregate: the manifest is
  written by child delivery alone, so a host that resumed a completed child
  leaves the launch's manifest under the resume's terminal row, where the two
  can no longer be correlated. Every result the parent journals, recovered or
  just launched, therefore comes from a child whose aggregate carries exactly
  one `run.activate`; a second one is refused for operator attention rather
  than reported. Which
  ids to probe comes from the parent's own journal, the one thing that
  outlives every child it launches: a `workflow.attempt` row moves the call's
  attempt mark before each launch, and recovery probes the derived ids in
  order from there, so a deleted attempt whose tombstone has since been
  collected cannot read as an id that never started. An attempt that never
  reached `run.start` simply launches. What an existing attempt did is its own
  bookkeeping to say, and the terminal row beside it says only what that came
  to: acceptance commits immediately before a turn dispatches, so an accepted
  `child.turn` is where model work and file edits begin, and the `run.result`
  manifest commits ahead of the turn's settle, so a settled turn is where the
  delivery that records them ended. An active turn refuses, with an outcome or
  without one — a child cancelled in that window ends CANCELLED with no
  manifest over tool edits that already landed. A settled turn with no
  manifest refuses too, whether or not the run recorded an outcome: the
  delivery can roll back after the model and the tools have finished, leaving
  the settle, a FAILED (or, under a stop, CANCELLED) `run.end`, and no record
  of what was delivered, and finished work is not repeated because its record
  was lost. A settled turn with a manifest is durable work the terminal row
  labels: a FAILED or CANCELLED row is an ordinary failed child (the manifest
  is written for `isError` too), replayed as the call's own failure, the same
  one a live child of that outcome raises and the same `AgentFailed` the
  engine journals nothing for; a COMPLETED row recovers the manifest. Only a run that
  opened no turn and delivered no manifest frees the next id — a decision
  taken while holding that attempt's run claim, so a resume starting one
  instant later is refused instead of running beside the id this frees. A
  manifest whose turn never settled lost its bookkeeping between the delivery
  and the settle, and a COMPLETED row with no manifest lost the delivery its
  post-drain row claims; both are refused for operator attention. A parent
  execution has one active runtime owner; the execution KV store is durable
  state, not a cross-process lock. Checkpoints use the strict version-4
  schema; malformed or older records fail instead of being translated into the
  current journal.
  Deliberately NOT an append-only started/result journal (the shape Claude
  Code's Workflow tool uses): such a log cannot distinguish "never
  finished" from a failed result, and beside the checkpoint, the commit
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
  is **data-only in both directions** (`sandbox.ts`): only JSON text crosses
  it, so neither side ever holds the other realm's callables or objects. The
  realm holds no host promises and so has no job queue to pump. The host
  reaches it through exactly one trusted function, `step`, which the protocol
  prelude captures before the body is evaluated and never installs as a
  global: `step` runs one generator to its next yield and reports the yielded
  operation, the result, or the throw as JSON text that the host validates
  with a Zod discriminated union. A multi-step branch crosses as the id of a
  generator function the realm keeps in its own table, so the host never
  calls a method on a guest object; that is what closes the classic
  `fn.constructor('return process')()` escape, since every callback a script
  can capture is realm-local and codegen-gated. `log()` and `phase()` are
  synchronous bridge calls whose arguments are stringified realm-side with a
  pristine, prelude-captured `JSON.stringify`. Script bodies are forced into
  strict mode, and the interrupt handler preempts a step still running at the
  run's deadline, so a synchronous loop cannot outlive the wall clock.
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
- **Budgets**: two bounds with two meanings: one concurrency semaphore (the
  host's child-run budget; library default 4) across every `agent()` call in
  every branch, and each `all()`'s own `concurrency` over its items (a branch
  holds no permit while it waits on its children, so a budget of 1 cannot
  deadlock). Also a live-call cap (default 200; journal replays are free), a
  fan-out cap of 512 items per `all()` (in the wire schema), and a wall-clock
  timeout. The cap and the timeout are `WorkflowRunAbortError` run faults,
  which no script can catch: in-flight `agent()` fibers are interrupted and
  awaited before the run settles.
- **Cancellation is interruption**: the engine and the sandbox take no
  `AbortSignal`. The interpreter (`interpreter.ts`) runs each operation as the
  Effect combinator it names (`Effect.forEach` for `all()`, `catchIf` for
  `attempt()`, `Effect.retry` for `retry()`, `Effect.timeoutOrElse` for
  `timeout()`) inside one scope that owns the QuickJS runtime and context and
  the deadline timer, so a result, a timeout, the first run-level fault, or
  the caller interrupting the run all tear it down the same way: calls
  interrupted (an admitted journal commit reaching its durability point
  first), then the realm disposed, then the terminal sweep. A call an
  operation interrupts (a fail-fast sibling, a `timeout()`) settles its card
  cancelled; one a run-level fault interrupts is left to the sweep, which
  knows the fault. Skip and retry
  are a per-attempt `Deferred` decision the host's gesture and the runner's
  settlement race for; a retry journals its supersession before it
  interrupts the runner. The two cancellation edges live in the host, where
  the child-run loop is a detached fiber: `workflowScriptStrategy` turns the
  loop's abort into an interrupt of the run, and `executeSubagentInBand`
  turns an interrupt of its caller into a stop of the in-band child by run
  id, then waits for the child to settle.
- **Debuggability**: a script's own error (a bug, as opposed to an operation
  failure) fails the workflow with up to three guest stack frames, so the
  saved script can be edited and rerun. An uncaught `AgentFailed` fails it
  with a hint to wrap the call in `attempt()`.

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
(`packages/extension/resources/tool_use_agents/orchestrator.yaml`); explicitly naming the tool in an
agent's configuration is one half of the consent boundary for automated
workflow fan-out. The other half is global: the "Multi-Agent Workflow" toggle
in the Tools dashboard (`src/tools/plugins.ts`, id `workflow-script`)
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
