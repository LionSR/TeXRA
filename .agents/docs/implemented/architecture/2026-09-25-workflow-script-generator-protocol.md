---
created: 2026-09-25
status: implemented
---

# Workflow scripts as generators over an Effect interpreter

**Recommendation:** change what crosses the `delegate_multi_agents` sandbox
boundary, and nothing else. A workflow script stops executing work and
becomes a generator that yields operations — `agent`, `all`, `attempt`,
`retry`, `timeout` — as plain data. One Effect interpreter on the host runs
each operation as the combinator it names and feeds the result, or a tagged
failure, back into the script. QuickJS, the determinism guards and the
content-addressed journal key stay exactly as they are; what goes is every
Promise inside the realm and the bridge machinery that exists only to carry
them. A prototype of the protocol passes 18 behavioral tests
([evidence](../../evidence/2026-09-25-workflow-generator-protocol/README.md)).
The owner ruled the §8 decisions on 2026-09-25 and the switch landed in one
change; §8 records the rulings and the model-reliability measurement, and
"As landed" below records where the implementation settled what this
proposal left open.

Baseline: `main` at `b4569d4c`.

## 1. The seam, as it stands

#13067 made the host side of the engine Effect-native: the sandbox is a
scoped Effect, cancellation is interruption, and skip/retry is a per-attempt
`Deferred` decision. The script side is still a Promise program, because the
script's contract is `async`:

- `agent()` and `parallel()` return Promises (`WorkflowScriptTool.ts:657`),
  and `parallel()` is a realm-side `Promise.all` over thunks, installed as
  trusted prelude code (`ORCHESTRATION_PRELUDE`, `runWorkflowScript.ts:120`).
- Because the realm holds pending promises, the host must pump QuickJS jobs
  and wake on host settlement: the pump loop and its `Latch`
  (`sandbox.ts:290`, `:420`–`:446`), the pending-deferred set (`:330`), the
  per-call settlement back into the realm (`settleHostPromise`, `:508`), and
  the async bridge wrappers in `BRIDGE_PRELUDE` (`:153`).
- A failed call resolves to `null` and a skip to the string
  `'__WORKFLOW_SKIPPED__'` (`runWorkflowScript.ts:725`, `:740`), so every
  script filters two sentinels before synthesis (`WorkflowScriptTool.ts:658`).
- Concurrency, retry and timeout policy the script wants is written by hand
  in the script, if at all; the host offers one semaphore.

## 2. The protocol

### 2.1 What a script looks like

```js
export const meta = {
  name: 'audit',
  description: 'Audit each file, then summarize',
};

const audits =
  yield *
  all(
    files.inputFiles.map((f, i) =>
      attempt(agent(`Audit ${f}.`, { id: `audit-${i}`, inputFiles: [f] })),
    ),
    { concurrency: 4 },
  );
const passed = audits.filter((r) => r._tag === 'Success').map((r) => r.value);

const summary =
  yield *
  retry(
    agent(`Summarize ${passed.length} audits.`, {
      agentName: 'writer',
      schema: SummarySchema,
    }),
    { times: 2 },
  );
return summary.structured;
```

- The body is a generator. The engine wraps it in `function* () { … }` where
  it wraps it in `async () => { … }` today. `await` inside it is a syntax
  error, which the engine reports with a pointed message ("write
  `yield* agent(...)`"), so the model's repair loop is one tool result.
- Operations are lazy values. `items.map((x) => agent(x))` builds a list and
  runs nothing, which replaces today's `() => agent(...)` thunks and avoids
  the fact that arrow functions cannot `yield`.
- A branch with several steps is a generator function:
  `all(items.map((x) => function* () { const a = yield* agent(…); return yield* agent(…) }))`.
- `log()` and `phase()` stay synchronous calls; `args`, `files`, `meta`,
  `meta.tasks` and the `agent()` option set are unchanged.

### 2.2 The operation set

| Operation                     | Script meaning                                                                    | Host combinator                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `agent(prompt, options)`      | one delegated call                                                                | today's journaled `agentPrimitive`, unchanged: identity, fingerprints, permits, the skip/retry decision                            |
| `all(items, { concurrency })` | run items concurrently; the first failure fails the whole and interrupts the rest | `Effect.forEach(items, run, { concurrency: requested ?? 'unbounded' })`; the session `Semaphore` inside `agent()` bounds what runs |
| `forEach(items, fn, opts)`    | `all(items.map(fn), opts)`                                                        | realm-side shorthand; never crosses the wire                                                                                       |
| `attempt(body)`               | never fails: a `Success` or `Failure` value                                       | `Effect.catchTag('OpFailure', …)`                                                                                                  |
| `retry(body, { times })`      | re-run a call or a whole branch                                                   | `Effect.retry({ times, while: isOpFailure })`                                                                                      |
| `timeout(body, ms)`           | bound a call or a branch                                                          | `Effect.timeoutOrElse`, failing with `TimedOut`; the loser is interrupted, which reaches the child as a stop                       |

`race` is deliberately left out until a script needs it.

### 2.3 The wire

Every value a step returns is JSON text, parsed on the host against a Zod
discriminated union (`WireNodeSchema`, `StepReplySchema`; Zod because the
runtime design keeps Zod for every payload). A multi-step branch crosses as
`{ _tag: 'Branch', fn }`: the realm keeps the generator function in its own
table, and the host asks for a fresh instance per run of the branch, which is
what makes `retry` of a branch restart it. The fan-out cap moves from the
realm-side `parallel()` check into the schema (`items.max(512)`).

The host reaches the realm through exactly one trusted function, `step`,
captured by the prelude before the body is evaluated and never installed as
a global. It never calls a method on a guest object, which is the escape the
realm-side `parallel()` was designed to prevent (README "Sandbox"); the
protocol keeps that property by construction instead of by placing `Promise.all`
inside the realm.

### 2.4 Failures

- A failed operation throws inside the script: `yield*` raises an `Error`
  whose `name` is the failure's tag — `AgentFailed`, `TimedOut`, `Skipped`.
  Ordinary `try/catch` works, and an uncaught failure fails the branch that
  threw with the same name.
- `attempt()` is the non-throwing form. `all()` of `attempt`s is today's
  "collect everything, filter the failures", made explicit.
- A skip is a `Skipped` failure. A script that tolerates skips says so with
  `attempt` or `try`; there is no truthy sentinel to forget to filter.
- Run-level faults are never catchable: the host abandons the script rather
  than resuming it. That covers `WorkflowRunAbortError` (contract faults,
  the call cap, a journal-write failure), the realm's own faults (a step
  over its CPU budget, a malformed operation), and an uncaught script error
  whose name is not one of those tags (a `TypeError`, the script's own
  `Error`): `attempt()` does not turn it into a value and `retry()` does not
  re-run it.

## 3. What stays

- **The sandbox.** QuickJS, a fresh runtime per script, the heap and stack
  limits, the determinism prelude, disabled dynamic code. The runtime design
  calls the sandbox, its determinism requirement and the content-addressed
  key "the product" (§6.5 of the
  [runtime design](../../proposed/architecture/2026-09-10-effect-native-runtime-system-design.md));
  this proposal keeps all three. The sandbox shrinks to "evaluate the
  prelude, then call `step` under a per-step CPU deadline".
- **Identity and durability.** `journalKey` (prompt, options, dependency
  fingerprint), the checkpoint aggregate's `workflow.script`,
  `workflow.journal` and `workflow.attempt` rows, recovery, the child fences
  and the attempt probe in `workflowScriptAgentRunner.ts`. Because the key
  does not depend on script syntax, a script rewritten into the generator
  form replays the calls its `async` predecessor completed.
- **The call path under `Agent`**: dependency refresh, `maxAgentCalls`, the
  per-attempt skip/retry decision, now fed by session requests (#13196),
  and the progress cards.
- **The two bounds.** The session's child-run budget stays one `Semaphore`
  across every branch, and each `all()` keeps its own cap: the "two bounds
  with two meanings" of §6.5. The prototype shows both are required (§7).

## 4. Interaction with the liveness program

The [liveness design](../../proposed/architecture/2026-09-21-effect-design-liveness-park-interruption.md)
is converting run stops to fiber interruption. On `main` already,
`executeSubagentInBand` stops its child by run id through
`Runs.interruptActive` rather than an `AbortSignal`, and that is the path
`timeout()` and fail-fast `all()` use when they interrupt a runner, the same
path skip uses today. `workflowScriptStrategy`'s abort-to-interrupt edge
stays until liveness step 3 removes the child-run `signal` parameter;
`ChildRunInterruptible`'s controller is a ruled permanent resident either way.
This proposal edits neither. Its files overlap the liveness program's only at
`workflowScriptAgentRunner.ts` (liveness step 2), which the switch does not
need to change; if it does, sequence after step 2.

## 5. Amendment to the runtime design

§6.5's `parallel()` row reads "realm-side unchanged (realm isolation)". This
proposal replaces it: there is no realm-side fan-out; the realm yields `All`
and the host runs `Effect.forEach`. Realm isolation holds for the reason in
§2.3 — the host calls only the trusted `step` — not because `Promise.all`
runs inside the realm. The row's second half, the two bounds, is unchanged.
If this proposal is accepted, that row is edited in the same PR.

## 6. The switch

One PR, because a dual format is ruled out (runtime design §12: "any
adapter, shim, flag, or dual engine").

- `sandbox.ts`: the step protocol replaces the promise bridge. Deleted: the
  job pump and its `Latch`, the pending-deferred set, `settleHostPromise`,
  the host-call `FiberSet`, the async wrappers in `BRIDGE_PRELUDE`.
- `runWorkflowScript.ts`: the interpreter (§2.2) around the existing
  `agentPrimitive`; `ORCHESTRATION_PRELUDE`'s `parallel()`, the `'null'`
  and skip-string results and `WORKFLOW_SKIPPED_RESULT` delete.
- `types.ts`, `parseScript.ts` (the `await` diagnostic; meta parsing is
  unchanged), `WorkflowScriptTool.ts`'s description and example.
- The surfaces that teach the format, besides the tool description: the
  agent-creation `tool_catalog.md`, the published user guide
  `docs/guide/multi-agent-workflows.md` (its worked example, its primitive
  table and its "a task shows Failed while the rest continue"
  troubleshooting entry), and `src/agent/workflowScript/README.md`. The
  three agent YAMLs that offer the tool (`orchestrator`, `engineer`,
  `leanOrchestrator`) only list it and need no change.
- Tests: `WorkflowScriptEngine.vitest.ts`'s script literals move to the new
  form; the prototype's cases that are not already covered join it; the
  bundle smoke test is unchanged.
- Saved scripts under `.texra/workflow-scripts/` in the `async` form fail
  with the `await` hint. There is no reader for the old form; the journal
  key means a rewritten script loses no completed work.
- Retry and identity: a retried body re-issues the same call keys, so the
  duplicate-key check (`runWorkflowScript.ts:502`) must admit a re-issue
  inside the same `Retry` (decision 4).

## 7. Evidence

The prototype in
[`evidence/2026-09-25-workflow-generator-protocol/`](../../evidence/2026-09-25-workflow-generator-protocol/README.md)
implements §2 end to end against a fake agent runner: about 500 lines, 18
tests, typecheck clean, stable across repeated runs. It establishes
fail-fast `all`, both concurrency bounds, deadlock freedom at a budget of 1,
`attempt`, `retry` of a call and of a whole branch, `timeout` with
interruption, concurrent multi-step branches, run-wide interruption,
preemption of a synchronous loop that the script cannot catch, the `await`
hint, and the escape and determinism probes.

Its tests were checked by breaking each guarantee: removing `attempt`'s
catch fails 1 test, making `all` collect instead of fail fast fails 3, and
removing the host budget initially passed — a single `all()`'s own cap hid
it — which is why the nested fan-out test exists and now fails without the
budget.

It does not cover the durable journal, identity checks, plan and cards,
fingerprints, the call cap, skip/retry control, the run timeout or the real
runner. Each moves under the `Agent` case or around the interpreter
unchanged; none conflicts with the protocol.

## As landed

- `src/agent/workflowScript/sandbox.ts` is the realm and the wire:
  `openWorkflowRealm` evaluates the protocol and determinism preludes and the
  body, and exposes `start`/`resume` over the one trusted `step`. The job
  pump, its `Latch`, the pending-deferred set, `settleHostPromise`, the
  host-call `FiberSet` and the async `BRIDGE_PRELUDE` wrappers are deleted.
- `src/agent/workflowScript/interpreter.ts` holds the interpreter of §2.2
  (split from `runWorkflowScript.ts` by the file-size budget);
  `runWorkflowScript.ts` keeps the journaled `agentPrimitive`, which now
  fails with `AgentFailed`/`Skipped` where it returned `'null'` and the skip
  sentinel. `ORCHESTRATION_PRELUDE` and `WORKFLOW_SKIPPED_RESULT` are gone.
- `parseScript.ts` parses the body as a generator function body and reports
  `await` with "write `yield* agent(...)`".
- No per-step CPU budget was added: the realm's interrupt handler preempts a
  step still running at the run's wall-clock deadline, as before, and records
  the timeout as the run's first fault. The wall clock is a
  `WorkflowRunAbortError` run fault.
- `all()` without `concurrency` runs every item (at most 512), so every
  issued call shows its queued card; the session `Semaphore` inside
  `agent()` bounds what runs. An explicit `concurrency` is the all()'s own
  bound. These are the two bounds of §6.5.
- A call an operation interrupts (a fail-fast sibling, a `timeout()`) settles
  its card `cancelled`; a call a run-level fault interrupts is left to the
  terminal sweep.
- `retry()` does not re-run past `Skipped`: a skip is the user's verdict on
  that call.
- An `all()`/`forEach` item that is a started generator object is refused
  with "pass the generator function itself (fn, not fn())", and an
  `agent()` file option that received an object says to pass
  `output.absolutePath` (both from the measurement below).

## 8. Decisions

Ruled by the owner on 2026-09-25:

1. **Model reliability.** Measured on 144 generations across gemini38f,
   deepseek41T and glm53flash (48 per arm; failures on first submission →
   after one repair turn): today's `async` description (A) 8/48 → 1/48; the
   generator description with §2.1's example as written (B) 13/48 → 5/48;
   the generator description plus one line mapping outputs to
   `output.absolutePath` before a later call's `inputFiles` (B2) 6/48 →
   0/48. All of B's lost ground was one multi-stage pipeline task. The
   switch shipped with B2: the tool description's example keeps the
   output-path mapping.
2. **Failure default.** Fail-fast `all`; `attempt` for tolerant fan-out. No
   `settle` option.
3. **Operation set.** The five in §2.2, `forEach` as realm shorthand;
   `race` deferred.
4. **Retry and the journal.** A retried body replays calls it already
   completed from the current run's journal (no re-billing, no second cost
   observation); the duplicate-key check admits a key an earlier attempt of
   the same `retry()` issued, and a key issued twice within one attempt is
   still a duplicate.
5. **Skip.** A skip is a `Skipped` failure.

The proposal text of the decisions follows as the record.

1. **Model reliability — the gate.** Models write `async`/`await` more
   fluently than `yield*`. Before the switch, run the orchestrator on the
   same task set under both tool descriptions and compare first-submission
   parse and validation failures, and repairs needed. Recommended: switch
   only if the generator form is not measurably worse after one repair turn;
   the owner sets the threshold.
2. **Failure default.** Recommended: fail-fast `all`, with `attempt` for
   tolerant fan-out. This changes what today's scripts mean, not only their
   syntax, since they rely on `null` results, and it changes behavior users
   are told to expect: the user guide says a failed task leaves the rest
   running. Under fail-fast that holds only where the script used
   `attempt`. The alternative is an `all(…, { settle: true })` default,
   which keeps the documented behavior at the cost of the silent-sentinel
   footgun.
3. **Operation set.** Recommended: the five in §2.2, with `race` deferred.
4. **Retry and the journal.** Recommended: calls a retried body already
   completed replay from the current run's journal rather than re-running,
   so a retry never re-bills finished work; the duplicate-key check admits
   a re-issue inside one `Retry`. The prototype re-runs them, which is the
   simpler behavior this decision rejects.
5. **Skip.** Recommended: a skip is a `Skipped` failure, as in §2.4.

## 9. Not proposed

- An Effect evaluator for a JavaScript subset in place of QuickJS: stronger
  on preemption and integration, weaker on memory containment and language
  breadth, and contrary to §6.5's ruling that the sandbox is the product.
- Running the Effect library inside the realm: a bundled runtime per run,
  shimmed timers, and fibers the host cannot supervise.
- Effect `Schema` for the wire: Zod owns payloads.
- A transition period in which both formats run.

## Verified

- Read on `main` at `b4569d4c`: `src/agent/workflowScript/{sandbox,runWorkflowScript,types,parseScript}.ts`,
  `docs/guide/multi-agent-workflows.md`, the three agent YAMLs that offer the
  tool (none teaches the format),
  `src/tools/delegation/{WorkflowScriptTool,workflowScriptStrategy,workflowScriptAgentRunner,inBandSubagentRun}.ts`,
  §6.5 and §12 of the runtime design, the liveness design's steps 1–5, and
  the rulings ledger (no ruling covers the script format).
- Ran the prototype's suite and typecheck from the repository root at the
  pins in its README; recorded the three deliberate breakages above.
- Not run: the model-reliability comparison (decision 1), the production
  engine against the protocol, or any live agent.
