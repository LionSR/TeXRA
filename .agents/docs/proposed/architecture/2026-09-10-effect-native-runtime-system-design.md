---
created: 2026-09-10
status: proposed
---

# The Effect-native agent runtime: one system across every surface

**Recommendation:** finish the runtime as one Effect program tree, not as a set of
converted files. The tree has four scopes (process, session, run, call), twelve
services, two `Effect.fn` loops, one durable append, and one place where a fiber's
`Exit` becomes a run outcome. Every surface that touches a run today (the flow engine,
both flow families, the tool runner, model handlers, follow-ups, approvals, child
dispatch, workflow scripts, the trace, the three hosts, the SDK) is mapped below to its
position in that tree and to the pinned Effect API it uses. Tools are already
Effect-inside (43 of 43 `*Tool.ts` files run a fiber at `execute()`), which is why the
next cut is the runner above them, not the tools.

This document does not restate the rules or the rows. The [migration PRD][prd] §7 owns
R1 to R10, the [runtime proposal][runtime] §2.1 owns the row vocabulary and §2.3 the
fold and resume rules, the [substrate decision][substrate] §6.1 owns C1 to C10, the
[injection note][injection] §5 owns the carrier manifest, and the [one run
model][onerun] §3.10 owns the names. Where those documents disagree, §7 says which
reading this design takes and why. What is new here:

1. the **fiber tree** (§2): which scope forks which fiber, what interrupts what, and
   where a child run's lifetime is decided;
2. the **service manifest as a single reconciled table** (§3), with the shape of each
   service and the mechanism it deletes;
3. the **two programs with their real signatures** (§4): success values, error
   channels, requirements, and the three combinators tool dispatch needs;
4. the **per-surface conversion map** (§5): for every runtime surface, its current
   mechanism, its Effect form, and the boundary it lands on;
5. an **rc.112 verification table** (§6): every Effect API this design names, checked
   against `node_modules/effect@4.0.0-rc.112`, including the places where the
   `effect-solutions` guides describe a newer API than the pin.

## 1. Verified starting point (`main` at `c29238e6bd`, 2026-09-10)

Measured by three parallel surveys of the tree; counts are direct references unless
stated.

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Consequence                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 526 files import `effect`; 478 `Effect.fn`, 351 `Effect.gen`, 269 `Stream.`, 147 `Deferred.`, 126 `Scope`/`Effect.scoped`, 67 `Queue.`, 54 `Data.TaggedError` classes, 18 `Context.Service` tags, one `ManagedRuntime.make` (`src/controllers/session/sessionLayer.ts:791`), one `LayerMap` (`:537`). `PubSub`, `Semaphore.make`, `Context.Reference`, `Schema.TaggedError`: **zero**.                                                                                                                                                  | The idiom is established. What is missing is not adoption but the runtime's own program tree.                                                                                            |
| The Effect spine of a run stops at exactly one line: `runFlowWithLifecycle`'s `runner` parameter is `(handle, lifecycle) => Promise<AgentRuntimeFlowResult>` (`src/agent/runtime/AgentRunLifecycle.ts:478-481`). `runAgent.ts:95`, `executeAgent.ts:405` and `AgentLaunchContext.ts` are already `Effect.fn`.                                                                                                                                                                                                                           | The run layer (§3 row `Run`) is inserted at that line; nothing above it needs re-conversion.                                                                                             |
| Below that line everything is Promise: `src/agent/node/index.ts` (158 LoC, `prep/exec/post`, clones every node per step at `:141-148`), `persistedFlow.ts` (517 LoC, one KV write plus one `structuredClone` of the whole conversation per node step, `:491-499`), `src/agent/implementations/flows/**` (8,315 LoC, **zero** `effect` imports), `ModelInvocationNode.ts` (846 LoC, `p-retry` batch at `:405-431`, unbounded manual-retry `for(;;)` at `:447-465`), `src/agent/modelHandlers/**` (21,061 LoC, `createResponse` Promise). | These are the deletion set. Their domain bodies (reflection `output/` ≈ 2,700 LoC, provider protocol code) are preserved as plain functions and `packages/llm` protocol modules.         |
| Tools: `BaseTool.execute(input): Promise<ToolResult>` (`src/tools/core/base.ts:89`); 43 of 43 `*Tool.ts` are `effectRuntime().runPromise(Effect.fn(...))` at that edge (68 `run*` sites under `src/tools`). The single `.call()` site is `ToolUseDispatchNode.ts:314`, inside `withToolFileInteractionContext` (`:292`), under `PQueue({concurrency: 4})` + `Promise.all` (`:169`, `:189`) with `AbortSignal` polling (`:172`, `:194`, `:236`).                                                                                         | "Much of tools have been converted" is exactly right: the tool bodies are Effect; the **runner** is not. Converting the runner deletes 68 run sites and retires R1 boundary kind (b).    |
| `packages/llm` (`@texra-ai/llm`, ~10k LoC) already defines the Effect-typed model contract: `Model.prepareTurn/streamTurn/generateTurn/background.*` return `Effect`/`Stream` with `ModelError extends Data.TaggedError` (`packages/llm/src/turn.ts:1610-1629`). Two production importers, neither on the run path.                                                                                                                                                                                                                     | `ModelInvoker` is written over `packages/llm`, not over `IModelHandler`. The handlers are retired with the loops, as the [delivery plan][plan] §7 package D already requires.            |
| Five `AsyncLocalStorage` scopes (`workspaceRoots.ts:43`, `RunContext.ts:79`, `TraceEmitter.ts:58` per instance, `ToolFileInteractionContext.ts:49`, `executionLease.ts:131`) and 13 `AsyncLocalStorage.bind` re-entry sites (11 in tools, `executeAgent.ts:439`, `:618`). rc.112 has no ALS awareness: a fiber resumed from outside the `als.run()` frame reads `undefined`.                                                                                                                                                            | Every carrier converts in the same change that makes its readers fibers; the [injection note][injection] §5 disposition is adopted, with the name `Run` (§7).                            |
| Human waits are promises held in memory: `SessionHostInteractions.pending: Set<…>` (`HostInteractions.ts:471`), `retryPrompt` blocks a node with no timeout (`ModelInvocationNode.ts:534`), `ModelRetryGate` is `p-defer` + `setTimeout` (337 LoC), `FollowUpQueue` is `p-defer`. Approval facts are durable rows; the prompt is not.                                                                                                                                                                                                   | One `Requests` service (§3) parks a run on a `Deferred` and re-parks from the fold after restart, which is the one-run-model §3.7 rule in Effect terms.                                  |
| Child dispatch: native subagents re-enter the engine through a late-bound `provideAgentEngine` record installed at module load (`executeAgent.ts:743` → `nativeSubagentStrategy.ts:109`) to break an import cycle; workflow scripts run `PQueue` + one `AbortController` per call cascading from a run-level one + `pTimeout` at teardown (`runWorkflowScript.ts:328`, `:693-698`, `:949`).                                                                                                                                             | Child launch becomes a service yielded from context (`Runs`), which dissolves the cycle; the queue, controllers and timeout become `Semaphore`, fiber interruption and `Effect.timeout`. |
| Ratchet rows on main: `platform()` 50/106, `setServices()` 6/6, `new AbortController(` 11/12, `p-queue` 11, `p-defer` 5, `p-retry` 3, `p-map` 1, `p-timeout` 1, `async-mutex` 1, below-boundary `Effect.run*` 11/27, `catch:effect-importer` 8/11, `dep:@agent/node` 25/27, `dep:@agent/modelHandlers` 9/28.                                                                                                                                                                                                                            | §8 says which rows each slice drives to zero. `setServices()`, `dep:@agent/node` and `p-retry` reach zero only in the atomic cut (§8 slice 3).                                           |

## 2. The fiber tree

Effect's structured concurrency gives the runtime its lifetime model for free if, and
only if, the fork sites are chosen deliberately. This is the tree; every later section
places itself in it.

```text
process scope            ManagedRuntime (one per host; disposal registered into LifecycleHost, R6)
└─ session scope         Sessions LayerMap entry (exists: sessionLayer.ts:537)
   │                       Database, SessionEvents, RunLedger, WorkspaceRoots, Requests, Runs
   ├─ run fiber  ───────  Runs.launch: FiberMap.run(runs, runId, program)   [forkIn session scope]
   │  │                    Layer.effect(Run, …) provided around the program; Run owns
   │  │                    identity, ModelCell, trace, policy, and the run's Scope
   │  ├─ turn / round       plain Effect.gen inside runToolUse / runReflection (no fiber)
   │  │  ├─ model call      ModelInvoker.invoke: one fiber = the calling fiber;
   │  │  │                  the provider stream is consumed with Stream.runFold on it;
   │  │  │                  AbortSignal derived only inside Effect.tryPromise((signal) => sdk…)
   │  │  ├─ dispatch        Tools.dispatch: parallel-safe segment = Effect.forEach({concurrency: 4})
   │  │  │  └─ tool call      one child fiber per call [forkChild via forEach];
   │  │  │                     Effect.provideService(ToolCall, …) on that subtree;
   │  │  │                     per-call cancel = interrupt that fiber; timeout = Effect.timeout
   │  │  └─ human wait      Requests.open: Deferred.await on the calling fiber (run parks)
   │  └─ settlement         Effect.onExit at the root: terminal rows appended under the lease,
   │                        then Scope closes (finalizers: trace detach, lease release)
   ├─ run fiber (child)     a delegated or scripted child is ANOTHER FiberMap entry under the
   │                        SESSION scope, never a child of the parent run fiber (§5.9)
   └─ reader fibers         SessionView subscribers; detaching never touches run fibers
```

Rules the tree encodes:

- **A run is a session-scoped fiber, not a child of whoever launched it.** `Runs.launch`
  forks into the session scope's `FiberMap` keyed by `RunId`. Host stop is
  `FiberMap`-lookup then `Fiber.interrupt`. Closing the session interrupts every run
  fiber in the map, which is the existing `SessionHandle.dispose` contract, now obtained
  from `Scope` rather than from a teardown ledger.
- **In-band delegation awaits; it does not parent.** A parent that dispatches an in-band
  child yields `Deferred.await(child.result)`. If the parent is interrupted, the
  `delegate` tool's finalizer decides, by the child's declared `mode` (`inband` |
  `detached`, one-run-model §3.2), whether to interrupt the child's map entry. Nothing
  depends on re-parenting a running fiber, which the [delivery plan][plan] §5 forbids.
- **The only `forkDetach` in the runtime is gone.** `AgentRunLifecycle.ts:541` forks the
  `onRun` host callback detached; under the tree it is `forkIn(sessionScope)`, so it
  is interrupted when the session closes instead of outliving the process.
- **Interruption is the only cancellation.** `RunScope.signal`, the run
  `AbortController` (`AgentLaunchContext.ts:510`), `linkAbortSignals`, per-call
  signals in `ToolCallContext`, and the workflow-script controller cascade all delete.
  Where a foreign SDK needs a signal, `Effect.tryPromise((signal) => …)` and
  `Effect.promise((signal) => …)` derive one from the current fiber (rc.112 signatures,
  §6). `Effect.abortSignal` (an `Effect<AbortSignal, never, Scope>`) covers the two
  places that hand a signal to a long-lived object rather than a call.
- **Masks are small.** The one uninterruptible region per activity is the append
  handoff (`Effect.uninterruptibleMask((restore) => …)` with preparation under
  `restore`), per [runtime][runtime] §2.4. `Effect.uninterruptible` already guards
  settlement at `sessionLayer.ts:746`, `runAgent.ts:254`, `executeAgent.ts:538`; those
  three sites remain and become the pattern's only other instances.

## 3. Service manifest

Twelve tags across four lifetimes. Each row names the shape (the methods a program
yields), what it deletes, and the composition point. Ids follow the injection note's
grammar (`@texra/<area>/<Name>`). Where the [runtime proposal][runtime] §2.4, the
[injection note][injection] §5, and the [one run model][onerun] §3.10 name the same
thing differently, the one-run-model name wins (§7 item 2).

| #   | Tag                                       | Lifetime | Shape (yielded API)                                                                                                                                                                                                                                                               | Deletes                                                                                                                                                                                     |
| --- | ----------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | process tags per injection §5 rows 1 to 4 | process  | `Secrets`, `AppState`, `FileSystem` + `Path`, `SetupPlatform`, `ToolInjections`, `LogSink`, `HttpClient` (exists)                                                                                                                                                                 | `platform()` reads in the runtime; `processRuntime.ts` global once every host holds its runtime in a local                                                                                  |
| 2   | `@texra/session/Database`                 | session  | exists (`src/shared/session/database.ts:84`)                                                                                                                                                                                                                                      | none                                                                                                                                                                                        |
| 3   | `@texra/session/SessionEvents`            | session  | exists (`sessionEvents.ts:41`); `publishBatch` is the C6 transaction                                                                                                                                                                                                              | none                                                                                                                                                                                        |
| 4   | `@texra/session/RunLedger`                | session  | `append(rows): Effect<RunState, LedgerRefused>`, `load(runId): Effect<RunState \| null, LedgerRefused>`; both fold with `foldRunState` ([PR1 note][pr1] §3)                                                                                                                       | `persistedFlow.ts`, `FlowRecord`, `flow_<id>` KV writes, the preservation ladder at `runToolUseFlow.ts:619-664`                                                                             |
| 5   | `@texra/session/Runs`                     | session  | `launch(input): Effect<RunHandle, LaunchRefused>`, `interrupt(runId): Effect<void>`, `handle(runId): Effect<Option<RunHandle>>`; backed by `FiberMap<RunId>` + admission over ledger claims (C5)                                                                                  | `executionRegistry.ts` (924), `executionLanes.ts` (247), the late-bound `provideAgentEngine`, `AgentRunHandle` bookkeeping, the lease's live-ownership map (the file fence stays, §7)       |
| 6   | `@texra/session/Requests`                 | session  | `open(req): Effect<RequestDecision, never, Scope>` (appends the opened row, registers a `Deferred` by `requestId`, awaits), `decide(id, decision): Effect<void, UnknownRequest>` (appends the decided row, completes the `Deferred`), `restore(runState): Effect<void>` on resume | `SessionHostInteractions.pending` set, `streamApprovalQueue.ts`, the seven per-kind Promise round-trips in `HostInteractions.ts`, `toolEditApproval.ts` waits, `p-defer` in `FollowUpQueue` |
| 7   | `@texra/agent/Run`                        | run      | `id: RunId`, `parent`, `agent`, `workingDirectory`, `policy`, `model: ModelCell` (the one mutable seam, `swap`/`current` as `Ref`), `trace: AgentTrace`, `stage: Context.Reference<readonly string[]>` (per run, §5.7), `scope: Scope`                                            | `RunContext` ALS (47 readers), `RunScope`, `AgentCore`, `BaseFlowContextInit`, both `AsyncLocalStorage.bind` sites in `executeAgent.ts`, `Flow.setServices()`                               |
| 8   | `@texra/agent/ModelInvoker`               | run      | `invoke(prepared): Effect<CompletedTurn, ModelFailure>` (automatic retry, route gate, manual-retry admission, compaction rows, delta streaming to the trace); `count(prepared): Effect<number, ModelFailure>`                                                                     | `ModelInvocationNode.ts` (846), `ModelRetryGate.ts` (337), `p-retry`, `auxiliaryRetry.ts`, the `IModelHandler` hierarchy once `packages/llm` serves every route                             |
| 9   | `@texra/agent/Tools`                      | run      | `dispatch(calls, ctx): Effect<readonly ToolSettlement[]>` (never fails: a tool failure is a settlement), `registry` (overlay + `submit_output`), `endTurn: Latch`                                                                                                                 | `ToolUseDispatchNode.ts` (607), `PQueue` there, `ToolFileInteractionContext` ALS (43 sites), the 68 `effectRuntime().run*` sites in `src/tools`, `ToolTypes.ITool.call(): Promise`          |
| 10  | `@texra/agent/FollowUps`                  | run      | `wait: Effect<Batch \| null>` (blocks on a per-run `Queue`; `null` on run end), `drain: Effect<Batch \| null>` (`Queue.poll`), `consume(batch): Effect<RunState, LedgerRefused>` (one C6 transaction: `model.message` rows + queue removal + `turn.ready`)                        | `ToolUseSessionLifecycle.ts`, `FollowUpQueue.ts`'s deferred, `ToolUseFollowUpQueueManager`'s in-memory dedup set, `waitForFollowUp`, `takePendingFollowUps` re-attachment loop              |
| 11  | `@texra/agent/OutputPipeline`             | run      | reflection's six output managers behind one tag: `produce(state): Effect<OutputFacts, OutputError>`, `reconcile(pending): Effect<OutputFacts, OutputError>`                                                                                                                       | the four stateful manager objects in `ReflectionServices.ts`, three `effectRuntime().runPromise` boundaries in `MediaExtractionNode`, `TeXCountNode`, `LatexDiffManager`                    |
| 12  | `@texra/agent/ToolCall`                   | call     | `{ callId, attempt, instruction, workPlan, hooks }`, provided with `Effect.provideService` around each tool fiber                                                                                                                                                                 | `ToolCallContext` and its ALS stack; the per-call `AbortSignal` field (the fiber is the cancel handle)                                                                                      |

Not services, on purpose: agent definition, prompt, setting, initial state (plain
arguments); the six reflection output managers individually (one tag, row 11); node
instance fields (generator locals); anything crossing `postMessage`. R2's four-part test
is applied to every row above: each is independently acquired, scoped, or substituted in
an existing test.

Composition points are the three the injection note fixes (process layer, session
`LayerMap` entry, `Layer.effect(Run, …)` inside `runAgent`) plus call-local
`Effect.provideService`. No fourth.

## 4. The two programs

### 4.1 Signatures

```ts
// src/agent/runtime/loop/toolUse.ts
export const runToolUse: (
  start: ToolUseStart, // plain data: agent, prompt, setting, resume flag
) => Effect.Effect<
  RunOutcome, // 'completed' | 'waiting' | 'cancelled' | 'halted' (data, R7)
  RunFailure, // LedgerRefused | ModelFailure | ToolsRefused  (typed, R7)
  Run | RunLedger | ModelInvoker | Tools | FollowUps | Requests
>;

// src/agent/runtime/loop/reflection.ts
export const runReflection: (
  start: ReflectionStart,
) => Effect.Effect<
  RunOutcome,
  RunFailure | OutputError,
  Run | RunLedger | ModelInvoker | Requests | OutputPipeline
>;
```

Three channels, three meanings (PRD R7):

- **Success** carries every product outcome, including the ones that today arrive as
  thrown sentinels: `waiting`, `cancelled` after a denied retry, `halted` after a
  rejected output. Callers inspect data, not `Cause`.
- **Error** carries expected operational failures that end the attempt: the ledger
  refused an append (lease lost, C5), the model failed after the automatic schedule and
  a denied manual retry, the tool registry could not be built. Each is a
  `Data.TaggedError` with Zod-typed fields; none carries an SDK object.
- **Interruption** is interruption. Host stop, session close, and process shutdown
  reach the loop as `Fiber.interrupt`; the loop does not catch it, and the root's
  `Effect.onExit` turns `Exit.hasInterrupts` into the `cancelled` terminal row.
- **Defects** are programming errors and are never caught below the root.

The loop bodies are the [runtime proposal][runtime] §2.2 sketches, unchanged in
structure. What this section adds is the shape of the two helpers those sketches call
and left open: the turn (§4.2) and dispatch (§4.3).

### 4.2 A turn, with its one mask

```ts
const runTurn = Effect.fn('toolUse.turn')(function* (s: RunState) {
  const ledger = yield* RunLedger;
  const model = yield* ModelInvoker;
  const tools = yield* Tools;
  const followUps = yield* FollowUps;

  const queued = yield* followUps.drain; // non-blocking; consumed under the lease
  if (queued) s = yield* followUps.consume(queued);

  // Activity/append pair: preparation interruptible, handoff + append masked.
  s = yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const turn = yield* restore(model.invoke(prepare(s))); // CompletedTurn, validated
      return yield* ledger.append([
        ...compactionRows(turn),
        assistantRow(turn),
        step('response.ready'),
      ]);
    }),
  );

  if (s.pendingCalls.length === 0) return s;
  const settlements = yield* tools.dispatch(s.pendingCalls, s); // never fails; appends per call
  return yield* ledger.append([
    pairedFollowUpMessages(settlements),
    snapshot(s),
    step('turn.end'),
  ]);
});
```

`Effect.uninterruptibleMask` is the rc.112 name (§6). The model call runs under
`restore`, so a stop during streaming interrupts the provider request; only the
committed response is durable. `Effect.fn('toolUse.turn')` gives every turn a span
whose name the observability plane maps to the existing stage id (R9).

### 4.3 Dispatch: three combinators, not one

`ToolUseDispatchNode` carries four product contracts the [injection note][injection]
§3.3 and the [delivery plan][plan] §5 name as the one place a mechanical port loses
behavior: barriers, parallel-safe segments, duplicate fan-out, result order, and the
absence of fail-fast sibling interruption. In Effect they are:

```ts
const dispatch = Effect.fn('tools.dispatch')(function* (calls, state) {
  const { registry, endTurn } = yield* Tools;
  const ledger = yield* RunLedger;
  const results = new Map<CallId, ToolSettlement>(); // result order restored from `calls`
  const primaries = new Map<Dedup, Deferred.Deferred<ToolSettlement>>();

  for (const segment of partition(calls)) {
    // 1. segments: contiguous parallel-safe runs vs single barrier calls (existing rule)
    if (yield* endTurn.isOpen) break; // a terminal tool ended the turn; later calls get skip results

    const runOne = (call) =>
      Effect.gen(function* () {
        const dup = primaries.get(call.dedupKey);
        if (dup) return yield* Deferred.await(dup); // 2. duplicates wait for their primary
        const mine = yield* Deferred.make<ToolSettlement>();
        primaries.set(call.dedupKey, mine);
        if (segment.barrier) yield* ledger.append([intent(call)]); // tool.intent at the dispatch site
        const settlement = yield* registry
          .get(call.name)
          .call(call.input)
          .pipe(
            Effect.provideService(ToolCall, callContext(call, state)),
            Effect.timeout(call.timeout), // rc.112: fails with TimeoutError, mapped below
            Effect.exit, // 3. a failure is a settlement, never a sibling interrupt
            Effect.map(settlementOf(call)),
          );
        yield* ledger.append([result(call, settlement), end(call)]);
        yield* Deferred.succeed(mine, settlement);
        return settlement;
      });

    const settled = segment.barrier
      ? [yield* runOne(segment.calls[0])]
      : yield* Effect.forEach(segment.calls, runOne, {
          concurrency: MAX_PARALLEL_TOOL_CALLS,
        });
    settled.forEach((s, i) => results.set(segment.calls[i].id, s));
  }
  return calls.map((c) => results.get(c.id) ?? skipped(c));
});
```

What each combinator buys and why the alternative loses behavior:

- **`Effect.forEach` with `concurrency`** replaces `PQueue` for the parallel-safe
  segment only. Because `runOne` never fails (its body ends in `Effect.exit`), `forEach`
  cannot fail fast and cannot interrupt siblings, which is the current
  `Promise.all`-over-settled-results behavior. A tool that throws produces the same
  `{status:'error'}` settlement `BaseTool.call` produces today.
- **`Deferred` per primary** replaces `_duplicateToPrimary`. A duplicate awaits its
  primary's settlement and derives the same `duplicateOf` result; it never executes.
  This is also what resume needs (§2.3 of the proposal), since an unpaired duplicate
  can await a primary that resumed.
- **`Latch` for `endTurn`** replaces the `TurnEnded` throw-and-catch. `submit_output`
  or any terminal tool opens the latch; the loop checks it between segments, so the
  current partition settles before the short-circuit, as today.
- **Per-call `Effect.timeout`** replaces the per-call `AbortSignal` in
  `ToolCallContext`; the fiber `forEach` forked is the cancel handle. Interrupting the
  run interrupts the segment's fibers through the tree, and the `Exit` each `runOne`
  observes carries the interruption, so the settlement is `cancelled` for calls still
  running and unchanged for calls already settled, matching `post()`'s pairing rule
  (`ToolUseDispatchNode.ts:534-543`).

The tool contract that makes this possible is one line in `src/tools/core/base.ts`:
`protected abstract execute(input: T): Effect.Effect<ToolResult, never, ToolCall | Run>`
(requirements as each tool actually needs them), with `call()` an `Effect.fn` that
Zod-validates and maps `ZodError` to the existing diagnostics. The 43 `*Tool.ts`
bodies are already `Effect.fn`; the change per tool is deleting the
`effectRuntime().runPromise` wrapper and the `AsyncLocalStorage.bind` prelude. That
retires R1 boundary kind (b), which the PRD ties to exactly this event ("when the tool
runner is itself Effect-typed"), and answers injection Q4: yes, the dispatcher is the
unit that retires the kind.

### 4.4 Model invocation

`ModelInvoker.invoke` is one `Effect.fn` over `packages/llm`'s `Model`:

```ts
const invoke = Effect.fn('model.invoke')(function* (
  prepared: PreparedInvocation,
) {
  const run = yield* Run;
  const cell = yield* Ref.get(run.model); // the invocation binds one model (contract 0.1)
  const attempt = cell.model.streamTurn(prepared).pipe(
    Stream.tap((ev) => deltaToTrace(run.trace, ev)), // live-only; the trace is the product surface (R9)
    Stream.runFold(emptyTurn, foldTurnEvent), // -> CompletedTurn (validated by the package)
    routeGate(cell.route), // Latch per route key: closed while a route cools, one probe fiber reopens it
    Effect.retry({
      while: isAutoRetryable, // status-based transient classification, as today
      schedule: Schedule.spaced(retryWait).pipe(
        Schedule.recurs(maxAttempts - 1),
      ),
    }),
  );
  return yield* manualRetryLoop(attempt); // durable admission, not a schedule (§4.5)
});
```

- The automatic batch is `Effect.retry` with the `{ while, schedule }` options object;
  `Schedule.spaced` + `Schedule.recurs` reproduce `p-retry`'s `factor: 1, randomize:
false` batch exactly (the first evaluation is not a retry, so `recurs(n - 1)` gives
  `n` attempts, as the rc.112 doc comment states). Background mode's floor of three
  and the per-invocation re-read of `texra.model.retry.maxAttempts` stay as inputs to
  `prepared`, not as fields on a node.
- `ModelRetryGate`'s cooling and probing become a `Latch` per route key inside the
  invoker: a failure closes the latch and forks one probe under the run scope; the
  probe's success opens it. Waiters block on `Latch.whenOpen`. This is 337 lines of
  `p-defer` + `setTimeout` replaced by two primitives and one schedule.
- Provider SDK streaming enters once, at the foreign edge, in `packages/llm`:
  `Stream.fromAsyncIterable` for `for await` SDKs (OpenAI Responses), `Stream.callback`
  for event-callback SDKs (Anthropic's `.on()`), each with the SDK's `AbortSignal`
  derived inside `Effect.tryPromise((signal) => …)`. Handlers' mutable
  `compactionRequested` / `outputStreaming` / `lastAttemptUsageRoute` fields become
  fields of `PreparedInvocation` and `CompletedTurn`.
- Effect AI's `LanguageModel` / `Toolkit` / `Chat` (`effect/unstable/ai`, present at the
  pin) are not adopted: its `Toolkit` decodes with Effect Schema, and its
  `LanguageModel` dispatches tools while streaming, which contract 0.1 forbids (a
  committed, validated response precedes any local dispatch). The
  [comparison][aicmp] holds.

### 4.5 Human requests: park the run, keep the fact

Every wait on a person (the seven `PERMISSION_KIND`s plus manual model retry) is
`Requests.open`:

```ts
const open = Effect.fn('requests.open')(function* (req: OpenRequest) {
  const ledger = yield* RunLedger;
  const gate = yield* Deferred.make<RequestDecision>();
  yield* ledger.append([requestOpened(req)]); // durable before the prompt is shown
  pending.set(req.requestId, gate); // session-scoped Map; cleared by decide/restore
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => pending.delete(req.requestId)),
  );
  return yield* Deferred.await(gate); // the run parks here; the fiber holds no promise
});
```

`decide` is a host command (one-run-model §2 R2): it appends `request.decided` and
completes the `Deferred`. On resume, `Requests.restore(state)` re-registers a
`Deferred` for every opened-without-decided request the fold reports and the loop
re-parks on it, which is the durable-recovery binding the [proposal][runtime] §2.3
requires for `model-retry` and `tool-outcome`. A decision for a run that is not parked
is delivered as a follow-up (one-run-model §3.7 rule), which is `FollowUps.consume`.
Manual model retry is the same primitive with `kind: 'model-retry'`; the proposal's
`authorized` → `started` permit consumption is two rows appended around the next
`invoke`, not a schedule.

Until the `request.*` arms land, the same service writes today's
`approval.requested` / `approval.resolved` rows; the service shape does not change
when the vocabulary does.

## 5. Surface map

Each row: what exists, what it becomes, and the boundary it lands on. "Boundary" is one
of R1's three kinds or "none" (Effect-typed end to end).

| #    | Surface                                                                                               | Today                                                                                                        | Effect-native form                                                                                                                                                                                                              | Boundary                           |
| ---- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 5.1  | Flow engine `src/agent/node/`                                                                         | `BaseNode`/`Flow`/`PersistedFlow`, action strings, BFS cursor, one write + clone per step                    | **deleted**; the two loops in `src/agent/runtime/loop/`; `RunLedger.append` is the only write                                                                                                                                   | none                               |
| 5.2  | Tool-use family (9 files, 2,704 LoC)                                                                  | prepare/cycle/wait nodes + inner round flow with non-persisted `ToolUseRoundShared`                          | `runToolUse` + `runTurn` (§4.2); round state is generator locals; WAITING is a returned outcome, not a parked cursor                                                                                                            | none                               |
| 5.3  | Reflection family (11 files + `output/`)                                                              | `RoundPersistedFlow` + `ResponseCycleFlow` five-node fan-in                                                  | `runReflection` with `Effect.scoped` + `Effect.acquireRelease(openStage)` per round; `processCommittedResponse` and `produceOutput` are plain functions over `OutputPipeline`                                                   | none                               |
| 5.4  | `ModelInvocationNode` + `ModelRetryGate` + handlers                                                   | Promise, `p-retry`, `p-defer`, mutable handler state, `createResponse` returns `{response, updatedMessages}` | `ModelInvoker` (§4.4) over `packages/llm`; `Stream` at the SDK edge only                                                                                                                                                        | foreign edge inside `packages/llm` |
| 5.5  | Tool runner + tools                                                                                   | `ToolUseDispatchNode` (`PQueue`, `Promise.all`, signal polling); 43 tools run a fiber in `execute()`         | `Tools.dispatch` (§4.3); `execute()` returns `Effect`; `ToolCall` service replaces the ALS stack                                                                                                                                | none (kind (b) retired)            |
| 5.6  | Approvals, retry prompt, ask_user, inquiry                                                            | Promise round-trips + in-memory pending set + a separate inquiry database and continuation module            | `Requests` (§4.5); inquiry keeps its cross-project record and loses its second protocol                                                                                                                                         | host command enters at kind (a)    |
| 5.7  | Trace                                                                                                 | `TraceEmitter` synchronous listener set + per-instance ALS stage stack                                       | **stays synchronous** (the [interface findings][findings] §3 price a `PubSub` hub at ≥27 files and seven adapter-owned properties for one gained property); the stage stack becomes a per-run `Context.Reference` held on `Run` | none                               |
| 5.8  | Follow-ups                                                                                            | `FollowUpQueue` (`p-defer`), `ToolUseSessionLifecycle` park/release, in-memory dedup                         | `FollowUps` (§3 row 10): `Queue.unbounded` per run fed by `SessionInputs`; durable queue rows unchanged; consumption is one C6 transaction                                                                                      | none                               |
| 5.9  | Native delegation, `childRunLoop`, workflow-script `agent()`                                          | late-bound engine record, `PQueue`, controller cascade, `pTimeout`, script journal in `persistence.ts`       | `Runs.launch` from context (cycle dissolves); `Semaphore.withPermits` for script concurrency; `Effect.timeout` at teardown; child results as `Deferred`; script journal rows on the event table (proposal §2.4, PR 4)           | none                               |
| 5.10 | `agentCreator`                                                                                        | linear `async` with `pRetry` around a helper completion                                                      | one `Effect.fn` with `Effect.retry`; uses `ModelInvoker.invoke` in helper mode (no session)                                                                                                                                     | none                               |
| 5.11 | Session: `SessionHandle`, `HostInteractions`, `executionRegistry`, `executionLanes`, `executionLease` | mixed; two of five `effectRuntime()` sites in `src/agent` are here                                           | `Runs` + `Requests` absorb the registry, lanes and pending set; `SessionHandle` keeps the view `SubscriptionRef` and publication `Semaphore(1)`; the lease keeps only its file fence (ownership note F2)                        | none                               |
| 5.12 | Hosts (CLI, extension, desktop)                                                                       | each root calls `installProcessRuntime`; handlers run fibers ad hoc (31/19/15 `effectRuntime` refs)          | each root builds one `Layer`, holds its `ManagedRuntime` in a local, and runs one program per host entry with `runtime.runPromiseExit(program, { signal })`; `LifecycleHost` keeps shutdown authority (R6)                      | kind (a)                           |
| 5.13 | SDK `packages/agent`                                                                                  | `./effect` subpath already Effect-typed; root renders Promises/async iterables                               | unchanged in shape; `Sessions` gains `Runs`/`Requests` pass-through of the same operations; `RunFailure` union widens to the typed errors in §4.1                                                                               | kind (c)                           |
| 5.14 | Tests                                                                                                 | six behavior suites pinned to the record format (13 of 17 engine-importing tests)                            | those 13 delete with the format; the behavior suites move to `it.effect` over `RunLedger`'s real layer and `TestClock` for retry/timeouts; no new tests for plumbing                                                            | none                               |

## 6. Effect rc.112 verification

Every API this design names, checked in `node_modules/effect/dist/*.d.ts` at
`4.0.0-rc.112` on 2026-09-10, and the `effect-solutions` guides (`basics`,
`services-and-layers`, `error-handling`, `data-modeling`, `testing`, `config`) plus the
Effect repository's `ai-docs` and `cookbooks/schedule.md` at
`~/.local/share/effect-solutions/effect` (`3a1128c7`, 2026-07-14). The guides track
Effect `main`, which is ahead of the pin; the third column records each divergence so
nobody copies an example that does not compile here.

| Design use                   | rc.112 API (verified)                                                                                                                                                          | Guide divergence at the pin                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Service tags                 | `Context.Service<Self, Shape>()(id)`; `Context.Reference(key, { defaultValue })` (`Context.d.ts:383`, `:1643`); `Context.ServiceClass`                                         | `Effect.Service` **does not exist** at the pin (0 matches in `Effect.d.ts`); the guide's note about it is for a newer release                                                                                            |
| Layers                       | `Layer.effect`, `Layer.scoped`, `Layer.succeed`, `Layer.provide`, `Layer.provideMerge`, `Layer.mergeAll`, `Layer.fresh`, `LayerMap`                                            | none                                                                                                                                                                                                                     |
| Runtime                      | `ManagedRuntime.make`; `runPromiseExit(effect, { signal })` (`RunOptions.signal`, `Effect.d.ts:16097`); `runFork`                                                              | none                                                                                                                                                                                                                     |
| Forking                      | `Effect.forkChild`, `forkScoped`, `forkIn(scope)`, `forkDetach` (`Effect.d.ts:15817-15980`); `FiberMap.run/make/join`, `FiberSet`                                              | none (`forkDaemon` is gone; `forkDetach` is the global-scope fork)                                                                                                                                                       |
| Interruption                 | `Effect.uninterruptibleMask`, `interruptibleMask`, `onInterrupt`, `onExit`, `ensuring`, `Effect.exit`; `Exit.hasInterrupts`; `Fiber.interrupt`                                 | none                                                                                                                                                                                                                     |
| Cancellation to foreign SDKs | `Effect.tryPromise({ try: (signal) => … , catch })` and `Effect.promise((signal) => …)` (`:1169`, `:1240`); `Effect.abortSignal: Effect<AbortSignal, never, Scope>` (`:13384`) | none                                                                                                                                                                                                                     |
| Retry                        | `Effect.retry({ while \| until \| times \| schedule })` (`Effect.d.ts:6486-6510`); `Effect.retryOrElse`                                                                        | v3 predicate combinators are gone; the options object is the only form                                                                                                                                                   |
| Schedules                    | `Schedule.spaced`, `recurs`, `exponential`, `jittered`, `during`, `upTo`, `max`, `min`, `concat`, `addDelay`, `modifyDelay`, `passthrough`, `tap`                              | **`Schedule.both`, `Schedule.while`, `Schedule.andThen` do not exist** at the pin (the `basics` guide and the cookbook use them); use `recurs` piped after the delay schedule, `max`/`min`, and `Effect.retry`'s `while` |
| Timeouts                     | `Effect.timeout`, `timeoutOption`, `timeoutOrElse`                                                                                                                             | none                                                                                                                                                                                                                     |
| Concurrency                  | `Effect.forEach(xs, f, { concurrency, discard })` (`:14294`); `Semaphore.make/withPermits`; `PartitionedSemaphore`; `Latch.make/whenOpen/open/close`                           | none; `Effect.makeSemaphore` is not the v4 name (`Semaphore.make` is)                                                                                                                                                    |
| Coordination                 | `Deferred.make/await/succeed/fail/interrupt`; `Queue.unbounded/bounded/offer/take/poll/end`; `PubSub.bounded/unbounded/subscribe`                                              | none                                                                                                                                                                                                                     |
| Streams                      | `Stream.fromAsyncIterable(iter, onError)`, `Stream.callback((queue) => …)`, `Stream.tap`, `Stream.runFold`, `runFoldEffect`, `runForEach`, `toAsyncIterable`                   | none                                                                                                                                                                                                                     |
| Errors                       | `Data.TaggedError(tag)<Fields>` (`Data.d.ts:966`), yieldable; `Effect.catch`, `catchTag`, `catchTags`, `catchCause`, `catchDefect`; `Cause.squash/pretty`                      | **`Schema.TaggedErrorClass` and `Schema.ErrorClass` do not exist** at the pin (`Schema.TaggedError` does, but §15 decision 8 keeps Zod); **`Effect.catchAll` does not exist** (`Effect.catch`, declared `catch_`)        |
| Tracing                      | `Effect.fn(name)(gen, ...pipeables)`, `Effect.withSpan`, `Effect.annotateLogs`                                                                                                 | none                                                                                                                                                                                                                     |
| Resources                    | `Effect.acquireRelease`, `acquireUseRelease`, `addFinalizer`, `Effect.scoped`, `Scope.make/close/fork`                                                                         | none                                                                                                                                                                                                                     |
| Testing                      | `@effect/vitest` `it.effect` / `it.live` / `it.layer`; `TestClock.adjust` from `effect/testing`                                                                                | none (matches AGENTS.md's rule)                                                                                                                                                                                          |
| Not adopted                  | `effect/unstable/workflow` (Effect Schema, memoized exits, memory engine only); `effect/unstable/ai`; `effect/unstable/eventlog`                                               | present at the pin; rejected for the reasons in PRD §13.C, the [findings][findings] §4, and §4.4 above                                                                                                                   |

Two further rc.112 facts that shape the design: `Context.Reference` is type-erased from
`R` and overridden per subtree with `Effect.provideService`, which is why the stage
stack can be a per-run reference without inflating every signature; and `Layer` values
are memoized by reference, so the per-run layer is built once per launch inside
`runAgent` and never hoisted to a module constant (a hoisted layer would share one
`ModelCell` across runs).

## 7. Where the corpus disagrees, and the reading taken

Recommended options are taken and stated, per the owner's 2026-09-10 rule; each is one
sentence the PR body repeats.

1. **Aggregate count.** The [proposal][runtime] §2.1 and C2 use two aggregates per run;
   the [one run model][onerun] §3.1 recommends one `run` aggregate. This design is
   written over **one aggregate**: `RunLedger.load(runId)` reads one history,
   `foldRunState` needs no cross-aggregate `commit` merge, and the `flow.step`
   coordinate lives beside the state rows it orders. The proposal's `aggregatesAfterCommit`
   tail read becomes the ordinary indexed read of one aggregate after the snapshot's
   `commit`.
2. **The per-run service is `Run`**, not `RunContext` (proposal §2.4) or `AgentRun`
   (injection §5 row 6). One word in every layer (one-run-model §3.10).
3. **`flow.snapshot` stays**, as C10's single sanctioned derived row, with the
   one-run-model R1 constraint honored: the snapshot carries only state that rows
   already carry (a base point, not a second store). The reflection state the
   [PR1 note][pr1] §2.6 could not fit in a snapshot becomes rows (`output.pending`,
   `round.begin`, `round.end`), which §4.1's `OutputError` channel already assumes.
4. **`RunContext` ALS retires with the loops** (injection §6 step 6), while
   `workspaceRoots` waits for the filesystem ruling (step 10). The two were one item
   only because `RunContext.ts:151-156` nests them.
5. **Injection Q1 (filesystem):** adopt Effect's `FileSystem` + `Path`, keeping TeXRA's
   atomic-publication, symlink and workspace-URI behavior as thin Effect functions,
   with the [findings][findings] §2 gaps (`lstat`, `readDirectory` types, `remove`
   ambiguity) closed inside those functions before any walker converts. Nothing in
   §2 to §5 depends on this; it gates only the `platform()` row.
6. **Injection Q2 (provide topology):** yes, the three points in §3 are the topology;
   "one `provide` at the process entry" scopes to the process layer.
7. **Injection Q3 (what sits outside `Run`):** `ModelInvoker`, `Tools`, `FollowUps`,
   `OutputPipeline`, `ToolCall`. Each is independently substituted in an existing
   test (fake model, fake registry, drained queue, no-op pipeline, explicit call
   context), which is R2's test.
8. **Injection Q4:** the dispatcher is the unit that retires R1 kind (b) (§4.3).
9. **The lease.** The [ownership note][lease] F2 leaves the lease one job, fencing files
   outside the database. `Runs` owns liveness (`FiberMap` + claims); the file fence
   stays as a scoped resource acquired inside `Layer.effect(Run, …)` and released by
   its finalizer, which is the `Effect.acquireRelease` form of what `executionLease.ts`
   hand-rolls. Its ALS re-entrancy set becomes a `Context.Reference` (injection §5 row
   9).
10. **`p-queue`.** AGENTS.md line 774 forbids it; the CLAUDE.md bullet that once
    permitted it has been corrected on main (#12203). Every remaining importer is in
    the deletion set or converts to `Semaphore`/`PartitionedSemaphore`.

## 8. Delivery: three slices, one atomic cut

The [delivery plan][plan] §7 packages and the [injection note][injection] §6 steps
already order the work; this section maps this design's sections onto them and names
what each slice deletes and which ratchet rows it moves. The one-run-model S1 (identity)
precedes slice 3 because `RunLedger`'s aggregate arm needs `RunId`.

| Slice | Content                                                                                                                                                                                                                                                                            | Deletes (symbols that cease to exist)                                                                                                                                                                                                                                                                                                                                                                                                  | Rows                                                                                                                                                                                                            | Alone?                          |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1     | **Run layer and requests.** `Layer.effect(Run, …)` inside `runAgent`; flip the `runner` seam at `AgentRunLifecycle.ts:479` to `Effect`; `Requests` over today's `approval.*` rows; `Runs` as `FiberMap` over the existing registry's admission rules                               | `RunContext` ALS, `RunScope`, both `AsyncLocalStorage.bind` sites in `executeAgent.ts`, `SessionHostInteractions.pending`, `streamApprovalQueue.ts`, `executionLanes.ts`, the run `AbortController`, `forkDetach` at `AgentRunLifecycle.ts:541`                                                                                                                                                                                        | `new AbortController(` −3, `p-defer` −2, below-boundary `Effect.run*` −2 (`SessionHandle.ts`)                                                                                                                   | yes (injection steps 6, part 7) |
| 2     | **Tool boundary.** `execute(): Effect`; `ToolCall` service; each of the 43 tools drops its `runPromise` wrapper and `bind` prelude. The single `.call()` site stays inside `ToolUseDispatchNode` and runs the tool's `Effect` with **one** `runPromise` at that site until slice 3 | `ToolFileInteractionContext` ALS, 11 `AsyncLocalStorage.bind` sites in tools, 68 `effectRuntime().run*` sites in `src/tools`, `ITool.call(): Promise`                                                                                                                                                                                                                                                                                  | `Effect.run*` boundary allowance for `src/tools/**/*Tool.ts` retires; the one new site in `ToolUseDispatchNode.ts` is a **baseline widening the ratchet refuses**, so slice 2 cannot land alone                 | **no**: lands inside slice 3    |
| 3     | **The atomic cut.** Engine + both loops + `Tools.dispatch` + `ModelInvoker` over `packages/llm` + `FollowUps` + `OutputPipeline` + child protocol on the event table; `RunLedger` + `foldRunState` (PR1 note) land first on the same integration branch                            | `src/agent/node/**`, `src/agent/implementations/flows/**` node and flow classes (bodies move to `loop/` and `OutputPipeline`), `ModelInvocationNode.ts`, `ModelRetryGate.ts`, `IModelHandler` and `src/agent/modelHandlers/**`, `ToolUseSessionLifecycle.ts`, `FollowUpQueue.ts`'s deferred, `workflowScript/persistence.ts`, `provideAgentEngine`, `docs/architecture/2026-06-20-pocketflow-state.md`, AGENTS.md's PocketFlow section | `setServices()` → 0 (row deleted), `dep:@agent/node` → 0 (row deleted), `dep:@agent/modelHandlers` → 0, `p-retry` → 0, `p-queue` −4, `p-map` → 0, `p-timeout` → 0, `catch:effect-importer` −4, `Effect.run*` −5 | no: one merge, stacked reviews  |

Slice 2's constraint is worth stating twice because it is the one place the ratchet
and the desire to "convert tools first" collide: converting `execute()` to `Effect`
moves the run site from 43 tool files to the one dispatcher file, and that file is
below the boundary, so the ratchet fails on a file newly entering the row. The
[injection note][injection] §6 reaches the same conclusion for step 8. Slice 2 is
therefore prepared as its own reviewable commits on the integration branch and merges
with slice 3. Nothing else in slice 2 waits: the `ToolCall` service, the tool-body
edits and the deletion of the eleven `bind` sites are mechanical and can be reviewed
first.

Gates per slice are the [delivery plan][plan] §8 table, unchanged. Slice 3 additionally
runs the six behavior suites the plan names (`RunAgentOwnership`, `ExecutionLease`,
`ToolUseDispatchParallel`, `RoundPersistedFlowCompileRepair`, `WorkflowScriptPersistence`,
`ChildRunLoop`), migrated to `it.effect` over the real `RunLedger` layer, plus the
proposal §2.3 crash-window cases behind a real process (a `TestClock` cannot establish
those).

## 9. What this design refuses

- **A generic activity or step abstraction.** Two loops and one append do not justify
  an interpreter. The [findings][findings] §4 record what `unstable/workflow` would
  cost (definition identity on resume, memo-key collisions per repeated activity,
  replayed delays, a `never` error channel over a store that can fail); the same
  costs apply to any repo-owned equivalent.
- **A `PubSub` behind the trace.** One gained property against seven adapter-owned
  ones and ≥27 files ([findings][findings] §3). The trace stays a synchronous product
  surface; Effect spans annotate it (R9).
- **Effect Schema anywhere in the runtime.** Zod owns every payload (§15 decision 8);
  `Data.TaggedError` fields are Zod-typed values.
- **Any adapter, shim, flag, or dual engine.** R1's second ruling and R10's struck
  clause. Slice 3 is atomic for exactly this reason.
- **A tag per class or per `Platform` port.** R2, the delivery plan's negative, and the
  twelve-row manifest in §3, which is the reviewed count.

## 10. Verified

- `main` at `c29238e6bd` surveyed by three parallel read-only passes (runtime
  internals; Effect adoption; the design corpus) with file:line citations reproduced
  in §1; counts are direct references.
- Every API in §6 was checked by grep against `node_modules/effect/dist/*.d.ts` at
  `4.0.0-rc.112`; the four divergences (`Effect.Service`, `Schema.TaggedErrorClass`,
  `Schedule.both/while/andThen`, `Effect.catchAll`) were confirmed absent by name.
- `effect-solutions list` and `show basics services-and-layers error-handling
data-modeling testing config` were read; the Effect repository's `ai-docs/src`
  (`01_effect`, `03_stream`, `06_schedule`, `09_testing`, `71_ai`) and
  `cookbooks/schedule.md` at `3a1128c7` were read for the service, resource, pubsub,
  stream and AI-tool patterns cited in §3 to §6.
- No production code, data format, or public API changed. The fiber tree in §2, the
  signatures in §4 and the slice table in §8 are design, not measurement; §8's row
  arithmetic is derived from §1's ratchet counts and must be re-derived by the PR that
  claims each row.

[prd]: ./2026-08-26-effect-4-runtime-migration.md
[runtime]: ./2026-09-04-agent-runtime-on-effect.md
[substrate]: ./2026-09-03-persistence-substrate-decision.md
[plan]: ./2026-09-06-effect-runtime-delivery-plan.md
[injection]: ./2026-09-10-effect-native-injection-context-pipelines.md
[onerun]: ./2026-09-10-one-run-model.md
[pr1]: ./2026-09-08-pr1-run-ledger-foundation.md
[findings]: ./2026-09-08-effect-4-interface-findings.md
[aicmp]: ./2026-09-07-effect-ai-comparison.md
[lease]: ./2026-09-10-execution-ownership-lane-and-lease.md
