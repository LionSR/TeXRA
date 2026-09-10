---
created: 2026-09-10
status: proposed
revision: 3
---

# The Effect-native agent runtime: one system across every surface

**Recommendation:** finish the runtime as one Effect program tree built from native
`Context.Service` tags, `Layer` composition, and `Context.Reference` values, not as a
set of converted files. The tree has four scopes (process, session, run, call), twenty
tags across them, two `Effect.fn` loops, one durable append, and one place where a
fiber's `Exit` becomes a run outcome. Every surface that touches a run today (the flow
engine, both flow families, the tool runner, model handlers, follow-ups, approvals,
child dispatch, workflow scripts, the trace, the view, the three hosts, the SDK) is
mapped below to its position in that tree, to the layer that provides it, and to the
pinned Effect API it uses. The run is replayable along its flow: the step vocabulary
is the graph, one pure fold gives the state at any step, and replay is a layer swap.

Revision 2 (same day) followed six deep read-only passes over the surfaces and corrected
revision 1 where the code disagreed with it. Revision 3 (same day) follows a seventh pass
over today's resume and replay paths and makes the owner's central question the central
section: how the flow is persisted, replayed and resumed (§6), including coordination
with the `delegate_multi_agents` workflow mode, how Effect's pipeline is used natively
(§3.4), and a collapse ledger of everything that becomes one thing (§11). Peer designs
(OpenCode V2, Pi's harness, effect-agent) are cited from the [loop study][loop] rather
than re-derived.

This document does not restate the rules or the rows. The [migration PRD][prd] §7 owns
R1 to R10, the [runtime proposal][runtime] §2.1 owns the row vocabulary and §2.3 the
fold and resume rules, the [substrate decision][substrate] §6.1 owns C1 to C10, the
[injection note][injection] §5 owns the carrier manifest, and the [one run
model][onerun] §3.10 owns the names. Where those documents disagree, §9 says which
reading this design takes and why.

## 1. Verified starting point (`main` at `c29238e6bd`, 2026-09-10)

Nine read-only passes; counts are direct references unless stated.

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Consequence                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 526 files import `effect`; 478 `Effect.fn`, 351 `Effect.gen`, 269 `Stream.`, 147 `Deferred.`, 126 `Scope`/`Effect.scoped`, 18 `Context.Service` tags, one `ManagedRuntime.make` (`sessionLayer.ts:791`), one `LayerMap` (`:537`). `PubSub`, `Semaphore.make`, `Context.Reference`: **zero**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | The idiom is established. What is missing is the runtime's own program tree and the layers that compose it.                                                    |
| The Effect spine of a run stops at one line: `runFlowWithLifecycle`'s `runner` is `(handle, lifecycle) => Promise<AgentRuntimeFlowResult>` (`AgentRunLifecycle.ts:478-481`). Below it: `src/agent/node/` (158 + 517 LoC), `implementations/flows/**` (8,315 LoC, zero `effect` imports), `ModelInvocationNode.ts` (846), `modelHandlers/**` (21,061).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | The run layer is provided at that line; the code below it is the deletion set.                                                                                 |
| Tools: 54 `protected execute()` methods and 53 registry entries under `src/tools`; 62 `effectRuntime()` sites there. About 35 tools' `execute` is nothing but an `AsyncLocalStorage.bind` prelude plus `runPromise` (≈250 lines); 7 `Ports` interfaces exist only to type that capture. The single `.call()` site is `ToolUseDispatchNode.ts:314`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Tool bodies are Effect; the runner is not. Converting the runner deletes ≈420 LoC of prelude and retires R1 boundary kind (b).                                 |
| `packages/llm` (10,116 LoC, six `Model` factories) already defines the Effect-typed model contract: `prepareTurn`/`streamTurn`/`generateTurn`/`background.*` return `Effect`/`Stream`, the terminal `completed` event carries a validated `TurnResult` (`turn.ts:1419-1466`), `ModelError extends Data.TaggedError` (`:1610`). Two production importers, neither on the run path. No factory for `vscode-lm`; no hosted-tool definitions; inline media only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `ModelInvoker` is written over `packages/llm`. Four capabilities must be written into the package before the handlers can retire (§5.4).                       |
| Liveness has **six** authorities: `ExecutionRegistry.handles`, `StreamStatusMachine`'s in-memory phase map, `AgentExecutionHandle.terminalState`, `ExecutionLanes.live`, the `ownedLeases` process map plus claim files, and `event_sequence.owner_id`. A seventh registry, the module-global `liveSessions` set (`SessionHandle.ts:823`), sits beside the `Sessions` `LayerMap`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | One session service owns "is this run live and who may write" (§4 row 7). About 4,700 LoC of arbitration ceases to exist (§7.11).                              |
| Human waits: seven request kinds go through one `enqueue` that creates a `new Promise` and adds to an in-memory `pending` set; the extension and desktop attachments implement one of the seven methods each, and `dispatch` auto-cancels a request whose method is missing (`HostInteractions.ts:936`). Six of seven kinds already decide through the fold plus `decision.*` arms of `RuntimeRequest`; tool-edit approval takes a second, 13-hop route through a controller.                                                                                                                                                                                                                                                                                                                                                                                                                                                       | One route for every kind (§5.5). The auto-cancel hazard (#12083) disappears by construction.                                                                   |
| Hosts: `effectRuntime()`/`run*` sites number about 124 (CLI, 45 files), 99 (extension, 24), 80 (desktop, 18). A typed, shared command vocabulary exists (`RuntimeRequest`, 16 arms, one handler `SessionRequests.handle`). A second vocabulary (`HostRequest`, 50+ arms) is dispatched three different ways, and the CLI re-implements its runtime subset as slash commands.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Revision 1 undercounted by 4×. The hosts already share a view path (extension and desktop) and a command vocabulary; the cut is to finish both (§7.12).        |
| Four folds run over the same rows: `sessionFold` (1,882 LoC, the view), `createTranscriptFold` (instantiated twice, once inside the view and once in `StreamLogStore`), `StreamSnapshotStore`, `executionMetaFromEvents`. Redaction runs at three sites. Publication has seven entry methods, four of them fire-and-forget through `schedulePublication`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | One fold per question (one-run-model R1): the view fold and the run-state fold. Three private folds delete (§7.7).                                             |
| Follow-ups: three in-memory layers (`FollowUpQueue` + `p-defer`, a per-stream lease map with a 1,000-entry dedup set and tombstones, `ToolUseSessionLifecycle`); **zero durable queue rows**. A crash loses every queued follow-up. Resume re-attaches through a third channel (`drainedFollowUps` + `takePendingFollowUps` threaded through four files).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Follow-ups become ledger rows plus one `Queue` per run (§7.8).                                                                                                 |
| Child dispatch: six entry paths, two launch primitives, one driver (`childRunLoop.ts`, 1,280 LoC). In-band and detached differ by four flags. A workflow `agent()` call is recorded four times (script journal, child result row, stable-attempt marker, workflow snapshot). Cancellation is an `AbortController` cascade attached to handles, not interruption.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | One launch operation with a `mode`; checkpoints become child result rows keyed by the existing content-addressed journal key (§7.9, §7.10).                    |
| SDK: `packages/agent/src/effect/sessions.ts` re-implements admission (an `admitted` `Deferred`, a two-window interrupt dance, a 512-event trace handover buffer with warn-and-drop) because no typed per-run launch or durable tail is available underneath.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | The SDK becomes the same session services plus Promise rendering; ≈160 LoC of `sessions.ts` deletes (§7.13).                                                   |
| Resume today: the whole tool-use turn (every model call, every tool batch) is **one** persisted step, written when `ToolUseCycleNode.post` returns (`persistedFlow.ts:363-372`); a crash mid-turn re-runs tools that already ran. Not restored on resume: round state, in-flight tool results, pending approvals, queued follow-ups, the provider continuation anchor (`ServerChainState`, so the next call resends the whole transcript), current-turn usage. Reflection's only mid-round checkpoint is the partial output file. A workflow script re-executes from the top and short-circuits `agent()` calls by a content-addressed key; in-flight children are adopted one layer down by stable-attempt markers that fail closed when ambiguous. There is no stepper or scrubber in any host; the trace viewer renders a finished transcript from the same fold the live UI uses. Fifteen crash windows are enumerated in §6.6. | Persistence at the activity boundary, not the turn boundary, is the whole difference (§6). Every item in the "state needed to resume" table (§6.1) gets a row. |
| Ratchet rows: `platform()` 50/106, `setServices()` 6/6, `new AbortController(` 11/12, `p-queue` 11, `p-defer` 5, `p-retry` 3, `p-map` 1, `p-timeout` 1, `async-mutex` 1, below-boundary `Effect.run*` 11/27, `catch:effect-importer` 8/11, `dep:@agent/node` 25/27, `dep:@agent/modelHandlers` 9/28.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | §10 says which rows each slice drives to zero; §11 lists every collapse.                                                                                       |

## 2. The fiber tree

Effect's structured concurrency gives the runtime its lifetime model for free if the
fork sites are chosen deliberately. Every later section places itself in this tree.

```text
process scope            ManagedRuntime (one per host root; disposal registered into LifecycleHost, R6)
└─ session scope         Sessions LayerMap entry (exists: sessionLayer.ts:537)
   │                       Database, SessionEvents, RunLedger, SessionView, Runs, ModelRoutes, WorkspaceRoots
   ├─ run fiber  ───────  Runs.launch: FiberMap.run(runs, runId, program)   [forkIn session scope]
   │  │                    Layer.scoped(Run, …) provided around the program; Run owns identity,
   │  │                    the model selection Ref + its Scope.fork, trace, policy, overlay tools
   │  ├─ turn / round       plain Effect.gen inside runToolUse / runReflection (no fiber)
   │  │  ├─ model call      ModelInvoker.invoke on the calling fiber; the provider Stream is
   │  │  │                  consumed with Stream.tap (deltas to trace) and its terminal `completed`
   │  │  │                  event is the TurnResult; AbortSignal only inside Effect.tryPromise
   │  │  ├─ dispatch        parallel-safe segment = Effect.forEach({ concurrency: 4 })
   │  │  │  └─ tool call      one child fiber per call; Effect.provideService(ToolCall, …);
   │  │  │                     cancel = interrupt that fiber; bash additionally kills its
   │  │  │                     process group from a release action (the one named exception)
   │  │  └─ human wait      Requests.open: Deferred.await on the calling fiber (run parks)
   │  └─ settlement         Effect.onExit at the root: terminal rows appended under the lease;
   │                        Scope closes (finalizers: trace detach, model scope, file fence)
   ├─ run fiber (child)     a delegated or scripted child is ANOTHER FiberMap entry under the
   │                        SESSION scope, never a child of the parent run fiber (§7.9)
   └─ reader fibers         SessionView subscribers; detaching never touches run fibers
```

Rules the tree encodes:

- **A run is a session-scoped fiber, not a child of whoever launched it.** `Runs.launch`
  forks into the session scope's `FiberMap` keyed by `RunId`. Host stop is a map lookup
  then `Fiber.interrupt`. Closing the session interrupts every entry, which is the
  existing `SessionHandle.dispose` contract obtained from `Scope` rather than from a
  teardown ledger.
- **In-band delegation awaits; it does not parent.** `Runs.launch` returns
  `{ id, result: Deferred<ChildResult> }`. An in-band caller yields
  `Deferred.await(result)`; a detached caller forks
  `Deferred.await(result) *> FollowUps.offer(parent, format(result))` under the session
  scope. If the parent is interrupted, the delegate tool's finalizer decides by the
  child's declared `mode` (`inband` | `detached`, one-run-model §3.2) whether to
  interrupt the child's map entry. Nothing depends on re-parenting a running fiber.
- **The child strategy contract drops its `AbortSignal` parameters.** Today
  `launch(ports, signal)` and `runTurn(followUps, ports, signal)`
  (`childRunLoop.ts:212-227`) carry a signal that a `ChildRunInterruptible` controller
  aborts. `Fiber.interrupt` on a map entry only becomes the cancel path once those
  parameters are gone; renaming the fork does not pay that cut.
- **The only `forkDetach` in the runtime is gone.** `AgentRunLifecycle.ts:541` forks the
  `onRun` host callback detached; it becomes `forkIn(sessionScope)`.
- **Interruption is the only cancellation.** `RunScope.signal`, the run
  `AbortController` (`AgentLaunchContext.ts:510`), `linkAbortSignals`, the per-call
  signal field (which is the run signal passed through, `ToolUseDispatchNode.ts:392`,
  with 20 of 21 tool-side readers being pure forwarding), and the workflow-script
  controller cascade all delete. Foreign SDKs get a signal from
  `Effect.tryPromise((signal) => …)` or `Effect.promise((signal) => …)`;
  `Effect.abortSignal` covers a long-lived foreign object. Bash's process-group teardown
  (`execUtils.ts:207-375`) is preserved explicitly as the release of an
  `Effect.acquireRelease` around the spawn.
- **Masks are small.** The one uninterruptible region per activity is the append handoff
  (`Effect.uninterruptibleMask((restore) => …)` with preparation under `restore`).

Peer confirmation, from the [loop study][loop] §3: OpenCode V2's runner is an
`Effect.fn` while loop with no step cursor, tool settlement under `uninterruptibleMask`,
and a durable input inbox promoted at safe boundaries; Pi's harness commits the
assistant operation intent before provider I/O and settles interrupted results from
recorded frames. Both are this tree. OpenCode starts tools while the stream is still
open; this design commits the validated `TurnResult` first (contract 0.1), a deliberate
difference the study already records.

### 2.1 Ownership: one owner per fact, one writer per row

Ownership is the property the surveys found violated most often (six liveness
authorities, three pending-request registries, four folds). The rule in this design has
three parts: every fact has exactly one owning service, that service is the only writer of
the rows that carry it, and everyone else reads the fact through the fold or the service's
tag, never through a second structure. The table is normative; a PR that adds a second
writer for a row or a second holder for a fact is wrong by this table.

| Fact or resource                                   | Owner (tag)                  | Lifetime | Writes                                                                                  | Readers                                                                    | Replaces                                                                                          |
| -------------------------------------------------- | ---------------------------- | -------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| the process runtime                                | the host root (a local)      | process  | none                                                                                    | host entries only                                                          | `processRuntime.ts` global, SDK refcount, `effectRuntime()` reads                                 |
| which sessions exist                               | `Sessions` (`LayerMap`)      | process  | none                                                                                    | hosts, SDK                                                                 | the `liveSessions` set                                                                            |
| committed rows, their order, the C6 transaction    | `SessionEvents`              | session  | every row, on behalf of the callers below                                               | `SessionView`, `RunLedger`, hosts' tails, the SDK                          | `schedulePublication`, four fire-and-forget publish methods                                       |
| run state (the fold)                               | `RunLedger`                  | session  | `flow.snapshot`                                                                         | the loops (via `append`/`load`), the stepper                               | `persistedFlow.ts`, `StreamSnapshotStore`, `executionMetaFromEvents`, `StreamStatusMachine`'s map |
| run liveness, admission, the C5 claim              | `Runs`                       | session  | `run.start`, `run.end`, `child.launched`, `child.result`                                | hosts (`interrupt`, `handle`), tools (`launch`), `FollowUps` (is it live?) | the six authorities in §1, `executionRegistry`, lanes, handles, the lease's ownership map         |
| pending human decisions                            | `Requests`                   | session  | `request.opened`, `request.decided`                                                     | the view (pending = opened without decided), the parked fiber              | `HostInteractions.pending`, `streamApprovalQueue`, the controller's map                           |
| per-route cooling and probing                      | `ModelRoutes`                | session  | none (in-memory `Latch` + version `Ref` per route)                                      | `ModelInvoker`                                                             | `ModelRetryGate`, `SessionHandle.modelRetries`                                                    |
| the view                                           | `SessionView`                | session  | none (a fold)                                                                           | every renderer, through `changes`                                          | `StreamLogStore`, `getUnsafe` pokes                                                               |
| workspace roots                                    | `WorkspaceRoots`             | session  | none                                                                                    | filesystem functions                                                       | `workspaceRoots.ts` ALS                                                                           |
| run identity, policy, trace, stage stack           | `Run`                        | run      | none                                                                                    | everything under the run                                                   | `RunContext` ALS, `RunScope`, `AgentCore`                                                         |
| the selected model and its resources               | `Run.model` (`Ref` + scope)  | run      | none                                                                                    | `ModelInvoker`                                                             | `ModelCell`                                                                                       |
| the file fence for run-owned files                 | `Run` (scoped resource)      | run      | none                                                                                    | tools writing run files                                                    | `executionLease.ts`'s ownership half                                                              |
| model invocations, usage, continuation, compaction | `ModelInvoker`               | run      | `model.turn`, `model.compaction`, `background.*`                                        | the loop                                                                   | `ModelInvocationNode`, handler mutable state, `recordCycleMetrics`, `UsageMonitor`'s live reads   |
| tool calls and their settlement                    | `dispatch` (in the loop)     | run      | `tool.intent`, `tool.result`, `model.message` (paired results)                          | the loop, the fold                                                         | `ToolUseDispatchNode`                                                                             |
| the base tool registry                             | `ToolRegistry`               | process  | none                                                                                    | `dispatch`                                                                 | lazy singleton, `SharedToolInjectionRegistry`                                                     |
| the run's overlay tools and end-of-turn latch      | `Run.overlay`, `Run.endTurn` | run      | none                                                                                    | `dispatch`, `submit_output`                                                | per-run overlay registry construction in `runToolUseFlow.ts`                                      |
| queued input                                       | `FollowUps`                  | run      | `followup.queued`, `followup.consumed` (+ the `model.message` rows of a consumed batch) | the loop (`wait`/`drain`), the view                                        | three in-memory layers, `updateQueuedFollowUps`                                                   |
| phase coordinates and round facts                  | the loop                     | run      | `flow.step`, `round.begin`, `round.end`, `output.pending`                               | the fold, the stepper                                                      | the cursor, `RoundPersistedFlow`                                                                  |
| reflection output artifacts                        | `OutputPipeline`             | run      | none (writes files; facts go through the loop's `round.end`)                            | the loop                                                                   | four manager objects                                                                              |
| per-call context                                   | `ToolCall`                   | call     | none                                                                                    | the tool body                                                              | `ToolFileInteractionContext` ALS                                                                  |
| token deltas                                       | `Run.trace` (synchronous)    | run      | none durable                                                                            | renderers, live only                                                       | unchanged (§7.7)                                                                                  |
| shutdown                                           | `LifecycleHost`              | process  | none                                                                                    | the runtime's disposal registers into it                                   | unchanged (R6)                                                                                    |

Two consequences worth stating once: a host never holds runtime state (it sends commands
and reads the view, one-run-model R2), and the SDK holds none either (it is the same
tags plus Promise rendering, §7.13). If a surface needs a fact this table does not give it
a reader for, the fix is a row or a tag method, never a local copy.

## 3. Layers: how the tree is composed

The owner's three requirements for this revision are one requirement. Native
`Context.Service` tags are only useful if the layers that provide them compose, and
composability is what makes replay (§6) a layer swap rather than a mode flag.

### 3.1 The layer graph

```ts
// process root, one per host (packages/{cli,desktop,extension,agent}/src)
const processLayer = Layer.mergeAll(
  Secrets.layer(adapters.secrets),
  AppState.layer(adapters.state),
  NodeFileSystem.layer,
  NodePath.layer, // effect/platform-node, injection Q1
  SetupPlatform.layer(adapters.setup),
  ToolRegistry.layer, // 53 singleton tools + injections (§4 row 2)
  LogSink.layer(adapters.log),
  FetchHttpClient.layer,
);

// session, one LayerMap entry per workspace root (exists: sessionLayer.ts:481-537)
const sessionLayer = (roots: WorkspaceRoots) =>
  Layer.mergeAll(
    Runs.layer,
    ModelRoutes.layer,
    SessionView.layer,
    RunLedger.layer,
  ).pipe(
    Layer.provideMerge(SessionEvents.layer),
    Layer.provideMerge(Database.layer(roots)),
    Layer.provideMerge(Layer.succeed(WorkspaceRoots, roots)),
  );

// run, built once per launch inside Runs.launch (never hoisted: a hoisted layer would share
// one model selection across runs, because Layer values memoize by reference)
const runLayer = (launch: LaunchInput) =>
  Layer.mergeAll(
    ModelInvoker.layer,
    FollowUps.layer,
    OutputPipeline.layer,
  ).pipe(Layer.provideMerge(Layer.scoped(Run, acquireRun(launch))));

// call-local: not a layer, a subtree provision
tool
  .call(input)
  .pipe(Effect.provideService(ToolCall, { callId, instruction, hooks }));
```

Three provision points and one subtree provision, exactly as the [injection
note][injection] §3.1 fixes; no fourth. The arrows are `Layer.provideMerge`: a shorter
lifetime is built from a longer one, never the reverse (R3). Each host root holds its
`ManagedRuntime` in a local (`ManagedRuntime.make(processLayer)`), and
`processRuntime.ts`'s throwing global accessor deletes when the last of the ≈300
`effectRuntime()` reads is gone.

### 3.2 What composability buys, concretely

| Substitution                  | Layer swapped                                                              | Who uses it                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Headless SDK                  | `Requests.layerDenyAll` for `Requests`                                     | `packages/agent` (replaces the `HEADLESS_HOST` stub, `sessions.ts:208-214`)                                    |
| Webview renderer              | `SessionView.layer` over a `SessionInputs` fed by frames instead of SQLite | `webviewSessionLayer.ts` already does this; it is the finished native root the injection note names            |
| Replay from the ledger        | `ModelInvoker.layerReplay(ledger)`, `Tools.layerReplay(ledger)`            | §6: the viewer's stepper, deterministic tests, "re-run this turn with the recorded I/O"                        |
| Test clock                    | `it.effect` provides `TestClock`; retry schedules advance without sleeping | `ModelInvoker`'s automatic retry, `ModelRoutes`' cooling                                                       |
| Fake model, fake tools        | `Layer.succeed(ModelInvoker, …)`, `Layer.succeed(ToolRegistry, …)`         | every loop test; today these need `createFakePlatform` plus `setServices()` plus an ALS frame                  |
| Process-scoped vs. run-scoped | `ToolRegistry` (process) + `Run.overlay` (run value)                       | the base registry is a singleton of stateless instances (`registry.ts:74-76`); only `submit_output` is per run |

The rule for whether something is a tag or a value (R2, and the injection note's §5
"explicitly not services" list) still applies. Agent definition, prompt, setting, initial
state, and every per-visit local remain plain arguments. Twenty tags is the reviewed
count.

### 3.3 `Context.Reference` for the two defaulted ambient values

Effect 4 has no `FiberRef`; `Context.Reference(key, { defaultValue })` is the
request-scoped value with a default, read without a layer and overridden per subtree
with `Effect.provideService`. Two carriers become references: the trace stage stack
(held on `Run`, keyed per run so cross-trace inheritance cannot recur) and the lease
maintenance set. Everything else that was ambient becomes a service whose absence fails
to compile.

### 3.4 The pipeline, natively

A run is a stream of durable rows and the states they fold to. Effect's stream
primitives express that directly, and the loops become the step function of an unfold
rather than a hand-written driver around one:

```ts
// The loop as a pipeline. `turn` is the Effect.fn of §5.2; it appends its rows through
// RunLedger.append and returns the folded state, so every emitted element is a committed
// state. Stream.unfold's step returns `[state, state]` to continue or `undefined` to stop.
export const runToolUse = (start: ToolUseStart) =>
  Stream.unfold(loadOrInit(start), (s) =>
    s.phase === 'done'
      ? Effect.succeed(undefined)
      : turn(s).pipe(Effect.map((next) => [next, next] as const)),
  ).pipe(Stream.runLast, Effect.map(outcomeOf)); // rc.112: unfold's step is effectful; runLast yields the final state

// Inspect: the same fold over the persisted rows, one state per row, no execution.
export const statesAt = (rows: Stream.Stream<RunRow>) =>
  rows.pipe(Stream.scan(emptyRunState, foldRunStep));

// Observe: history then tail, one stream, for the SDK, the viewer and the CLI renderer.
export const observe = (events: SessionEvents, id: RunId) =>
  Stream.concat(Stream.fromIterable(events.aggregate(id, 0)), events.tail(id));
```

Three consequences:

- **R4 is satisfied, not bent.** There is still no graph, cursor, node or flow record;
  `Stream.unfold` is a while loop whose state after each step is observable to any
  subscriber. The same `turn` runs under `Effect.fn` in tests and under the unfold in
  production.
- **Deltas and rows are two streams with one consumer model.** Token deltas are
  `Stream.tap` inside `ModelInvoker.invoke` (live-only); rows are what `observe`
  yields. A renderer merges `observe` with the delta stream; the ledger never sees a
  delta.
- **The workflow-script sandbox bridge is a fiber set, not a global runtime.** The
  script's `agent()` global is `FiberSet.makeRuntimePromise` (rc.112, with
  `propagateInterruption`) scoped to the workflow run: every Promise the sandbox awaits
  is a fiber the run owns, interrupted when the run's scope closes. That is the one
  legitimate Effect-to-Promise crossing inside the runtime (a `node:vm` realm is a
  foreign edge in R1's sense), and it replaces `effectRuntime().runPromise` at
  `WorkflowScriptTool.ts:619` and the per-call `AbortController` cascade.

## 4. Service manifest (revision 2)

Twenty tags across four lifetimes; §2.1 says which fact each owns. Each row names the
shape a program yields, what it deletes, and the surveys' measured LoC where one exists. Ids follow
`@texra/<area>/<Name>`.

| #   | Tag                                                                                    | Lifetime | Shape (yielded API)                                                                                                                                                                                                                                                                      | Deletes                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `Secrets`, `AppState`, `SetupPlatform`, `LogSink`, `FileSystem` + `Path`, `HttpClient` | process  | per [injection note][injection] §5 rows 1 to 4, 13 to 15                                                                                                                                                                                                                                 | `platform()` reads; `processRuntime.ts` once every root holds its runtime in a local                                                                                                                                                                                                                   |
| 2   | `@texra/tools/ToolRegistry`                                                            | process  | `base: MapToolRegistry` (53 singleton instances), `injections: readonly ToolInjection[]`                                                                                                                                                                                                 | `getDefaultToolRegistry` lazy singleton, `SharedToolInjectionRegistry` mutable array (`toolInjection.ts:34`)                                                                                                                                                                                           |
| 3   | `@texra/session/Database`                                                              | session  | exists                                                                                                                                                                                                                                                                                   | none                                                                                                                                                                                                                                                                                                   |
| 4   | `@texra/session/SessionEvents`                                                         | session  | exists; `publishBatch` is the C6 transaction and holds the publication `Semaphore(1)`; publications tracked in a `FiberSet`                                                                                                                                                              | `SessionHandle.schedulePublication` + `publications` + `settlePublications` (`:678-705`); the four fire-and-forget publish methods become awaited appends                                                                                                                                              |
| 5   | `@texra/session/RunLedger`                                                             | session  | `append(rows): Effect<RunState, LedgerRefused>`, `load(runId): Effect<RunState \| null, LedgerRefused>`; both fold with `foldRunState` ([PR1 note][pr1] §3). One aggregate per run (§9 item 1).                                                                                          | `persistedFlow.ts`, `FlowRecord`, `flow_<id>` KV writes, the preservation ladder (`runToolUseFlow.ts:619-664`), `StreamSnapshotStore` (312), `executionMetaFromEvents` and its callers, KV `turn-state`                                                                                                |
| 6   | `@texra/session/SessionView`                                                           | session  | exists (`SessionView.ts:51`): `ref: SubscriptionRef<SessionView>`, `changes: Stream`; the only consumer of `sessionFold.ts`                                                                                                                                                              | `StreamLogStore` (380) and its second `createTranscriptFold`; the six `SubscriptionRef.getUnsafe` pokes on hosts become `changes` readers                                                                                                                                                              |
| 7   | `@texra/session/Runs`                                                                  | session  | `launch(spec): Effect<RunHandle, LaunchRefused>` where `RunHandle = { id, result: Deferred<ChildResult>, interrupt }`; `interrupt(runId)`; `handle(runId): Option<RunHandle>`; backed by `FiberMap<RunId>` and the ledger's C5 claims. **One implementation also provides tag 8.**       | `executionRegistry.ts` (924), `executionLanes.ts` (247), `waitingTermination.ts` (240), `executionInteractionOwnership.ts` (218), most of `ExecutionHandle.ts`, `StreamStatusService.ts`'s in-memory map, the `liveSessions` set, `provideAgentEngine`, `childRunBudget.ts`, `detachedChildRun.ts`     |
| 8   | `@texra/session/Requests`                                                              | session  | `open(req, { policy, bypassed }): Effect<RequestDecision, never, Scope>`, `openDetached(req): Effect<RequestId>` (inquiry), `decide(id, decision)`, `restore(runState)`; one prompt at a time per stream via `Semaphore.withPermits(1)` with the bypass re-check inside the permit       | the seven `HostInteractions` request methods, `enqueue`/`dispatch`/`settleRequest`/`settleRetry`/`pending` (≈450 of 1,001), `streamApprovalQueue.ts` `enqueue` (≈200 of 376), the CLI `park()` stubs, `ToolEditApprovalController`'s second pending map, `p-defer` there                               |
| 9   | `@texra/session/ModelRoutes`                                                           | session  | `withRoute(wire, model)(effect)`: cooling and probing per route key, two nested scopes, a version `Ref` per route for the staleness re-check                                                                                                                                             | `ModelRetryGate.ts` (337) and `SessionHandle.modelRetries`; must be session-scoped because the gate coordinates credential failures across concurrent runs (`SessionHandle.ts:231,300`)                                                                                                                |
| 10  | `@texra/session/WorkspaceRoots`                                                        | session  | exists; widened per injection §5 row 5                                                                                                                                                                                                                                                   | `workspaceRoots.ts` ALS (after the filesystem ruling)                                                                                                                                                                                                                                                  |
| 11  | `@texra/agent/Run`                                                                     | run      | `id`, `parent`, `agent`, `workingDirectory`, `policy`, `model: Ref<Selected>` with `Scope.fork` per selection (`swap = Scope.close(old) *> Ref.set(new)`), `trace`, `stage: Context.Reference`, `workspace` (tracker, work plan), `overlay: readonly ITool[]`, `endTurn: Latch`, `scope` | `RunContext` ALS (47 readers), `RunScope`, `AgentCore`, `BaseFlowContextInit`, `ModelCell.ts` (140, incl. the lazy-client memo), `AgentLaunchContext.ts`'s rollback ladder and `linkAbortSignals`, both `AsyncLocalStorage.bind` sites in `executeAgent.ts`, `Flow.setServices()`                      |
| 12  | `@texra/agent/ModelInvoker`                                                            | run      | `prepare(request): Effect<ResolvedTurn, ModelError>`, `invoke(turn): Effect<TurnResult, ModelFailure>`, `count(turn)`, `submit(turn): Effect<RemoteOperation, ModelFailure>` (commits the handle before returning), `observe(op)`                                                        | `ModelInvocationNode.ts` (846), `helperModel.ts` (99), `auxiliaryRetry.ts`, `p-retry`, `IModelHandler` and `src/agent/modelHandlers/**` once §5.4's four gaps are closed in `packages/llm`                                                                                                             |
| 13  | `@texra/agent/FollowUps`                                                               | run      | `wait: Effect<Batch \| null>` (`Queue.take`), `drain: Effect<Batch \| null>` (`Queue.poll`), `offer(row)`, `consume(batch): Effect<RunState, LedgerRefused>` (one C6 transaction: `followup.consumed` + `model.message` rows + `turn.ready`)                                             | `ToolUseFollowUpQueueManager.ts` (357), `FollowUpQueue.ts` (164), `ToolUseSessionLifecycle.ts` (93), the `drainedFollowUps`/`takePendingFollowUps` re-attachment (`resumeRun.ts:451-500`, four `executeAgent.ts` sites), the four `updateQueuedFollowUps` publishers, the goal-continuation race check |
| 14  | `@texra/agent/OutputPipeline`                                                          | run      | `produce(state): Effect<OutputFacts, OutputError>`, `reconcile(pending)`                                                                                                                                                                                                                 | the four stateful managers in `ReflectionServices.ts`; three `effectRuntime().runPromise` boundaries in reflection nodes                                                                                                                                                                               |
| 15  | `@texra/agent/ToolCall`                                                                | call     | `{ callId, instruction, hooks }` (three fields; `tracker`, `trace`, `workPlan` are run-lifetime and live on `Run`; the signal is the fiber; there is no `attempt` because dispatch never retries a tool)                                                                                 | `ToolFileInteractionContext.ts` (72), its 35 reader sites, the 7 `Ports` interfaces, 14 `AsyncLocalStorage.bind` sites in tools                                                                                                                                                                        |

Corrections against revision 1: `SessionView` was missing and already exists as a tag;
`Runs` and `Requests` are one implementation with two tags because a run is either
executing (owns a fiber) or parked (owns a `Deferred`) and today that one fact is spread
across five places; `ModelRoutes` moved from inside `ModelInvoker` to the session
because the cooling state is cross-run; `Tools` split into a process-scoped registry and
run-scoped values (`overlay`, `endTurn`) because no registered tool holds run state;
revision 1's "`SessionInputs` feeds the follow-up queue" was a name collision with the
existing fold-input tag and is withdrawn.

## 5. The two programs

### 5.1 Signatures

```ts
export const runToolUse: (start: ToolUseStart) => Effect.Effect<
  RunOutcome, // 'completed' | 'waiting' | 'cancelled' | 'halted'  (data, R7)
  RunFailure, // LedgerRefused | ModelFailure | ToolsRefused          (typed, R7)
  Run | RunLedger | ModelInvoker | ToolRegistry | FollowUps | Requests
>;

export const runReflection: (
  start: ReflectionStart,
) => Effect.Effect<
  RunOutcome,
  RunFailure | OutputError,
  Run | RunLedger | ModelInvoker | Requests | OutputPipeline
>;
```

Success carries every product outcome, including the ones that arrive today as thrown
sentinels. Error carries expected operational failures that end the attempt, each a
`Data.TaggedError` with Zod-typed fields and no SDK object. Interruption is interruption:
the root's `Effect.onExit` turns `Exit.hasInterrupts` into the `cancelled` terminal row.
Defects are never caught below the root. The loop bodies are the [runtime
proposal][runtime] §2.2 sketches; the turn and dispatch helpers they call are below.

### 5.2 A turn, with its one mask

```ts
const runTurn = Effect.fn('toolUse.turn')(function* (s: RunState) {
  const ledger = yield* RunLedger;
  const model = yield* ModelInvoker;
  const followUps = yield* FollowUps;

  const queued = yield* followUps.drain;
  if (queued) s = yield* followUps.consume(queued);

  s = yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const turn = yield* restore(
        model.invoke(yield* model.prepare(request(s))),
      );
      return yield* ledger.append([
        ...compactionRows(turn),
        assistantRow(turn),
        step('response.ready'),
      ]);
    }),
  );

  if (s.pendingCalls.length === 0) return s;
  const settlements = yield* dispatch(s.pendingCalls, s); // never fails; appends per call
  return yield* ledger.append([
    pairedFollowUpMessages(settlements),
    snapshot(s),
    step('turn.end'),
  ]);
});
```

### 5.3 Dispatch: three combinators, not one

`ToolUseDispatchNode` carries four product contracts: barriers, parallel-safe segments,
duplicate fan-out, result order, and the absence of fail-fast sibling interruption.

```ts
const dispatch = Effect.fn('tools.dispatch')(function* (calls, state) {
  const { overlay, endTurn } = yield* Run;
  const { base } = yield* ToolRegistry;
  const ledger = yield* RunLedger;
  const registry = overlayRegistry(base, overlay);
  const results = new Map<CallId, ToolSettlement>();
  const primaries = new Map<DedupKey, Deferred.Deferred<ToolSettlement>>();

  for (const segment of partition(calls)) {
    if (yield* endTurn.isOpen) break; // a terminal tool ended the turn; later calls get skip results
    const runOne = (call) =>
      Effect.gen(function* () {
        const dup = primaries.get(call.dedupKey);
        if (dup) return yield* Deferred.await(dup); // duplicates wait for their primary
        const mine = yield* Deferred.make<ToolSettlement>();
        primaries.set(call.dedupKey, mine);
        if (segment.barrier) yield* ledger.append([intent(call)]); // tool.intent at the dispatch site
        const settlement = yield* registry
          .get(call.name)
          .call(call.input)
          .pipe(
            Effect.provideService(ToolCall, callContext(call, state)),
            Effect.exit, // a failure or an interruption is a settlement, never a sibling interrupt
            Effect.map(settlementOf(call)), // interrupted -> CANCELLED_CALL_ERROR, verbatim
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
    settled.forEach((r, i) => results.set(segment.calls[i].id, r));
  }
  return calls.map((c) => results.get(c.id) ?? skipped(c));
});
```

- **`Effect.forEach` with `concurrency`** replaces `PQueue` for the parallel-safe
  segment only. `runOne` never fails (it ends in `Effect.exit`), so `forEach` cannot
  fail fast or interrupt siblings.
- **`Deferred` per primary** replaces `_duplicateToPrimary`; a duplicate awaits and
  derives the same `duplicateOf` result, which resume also needs.
- **`Latch` for `endTurn`** replaces the `TurnEnded` throw-and-catch; the current
  partition settles before the short-circuit, as today.
- **No per-call timeout.** Revision 1 wrote `Effect.timeout(call.timeout)`; there is no
  such timeout today (`SdkToolCall` has no `timeout`, the dispatcher applies none), and
  `src/tools/timeouts.ts` is a per-HTTP-request deadline that stays as it is. Adding one
  would be new behavior and is dropped.
- **Cancellation.** The fiber `forEach` forked is the cancel handle. An interrupted call
  settles as the synthetic `CANCELLED_CALL_ERROR` result so every `tool_use` stays paired
  (`ToolUseDispatchNode.ts:530-543`). Bash's `executeCommand` keeps its process-group
  kill, wired as the release of an `Effect.acquireRelease` around the spawn.

The tool contract is one line in `src/tools/core/base.ts`:
`protected abstract execute(input: T): Effect.Effect<ToolResult, never, ToolCall | Run>`
(requirements narrowed per tool), with `call()` an `Effect.fn` that Zod-validates and
maps `ZodError` to the existing diagnostics. Per tool the change is deleting the
prelude and the `runPromise`; ≈9 lines each across 54 tools. That retires R1 boundary
kind (b) and answers injection Q4.

### 5.4 Model invocation (corrected)

`packages/llm` already produces the completed turn: the terminal `completed` event of
`streamTurn` carries a `TurnResult` validated by five cross-field refinements
(`turn.ts:1334-1415`). Revision 1's `Stream.runFold` into a `CompletedTurn` would have
re-derived that value; it is withdrawn. `ResolvedTurn` is the prepared invocation
(contract 0.1 row 2), so `invoke` takes the output of `prepare`.

```ts
const invoke = Effect.fn('model.invoke')(function* (turn: ForegroundTurn) {
  const run = yield* Run;
  const routes = yield* ModelRoutes;
  const ledger = yield* RunLedger;
  const selected = yield* Ref.get(run.model); // one invocation binds one model
  const attempt = selected.model.streamTurn(turn).pipe(
    Stream.tap((ev) => deltaToTrace(run.trace, ev)), // live-only; the trace is the product surface (R9)
    Stream.filter((ev) => ev.kind === 'completed'),
    Stream.runLast,
    Effect.flatMap(
      Option.match({
        onNone: () => new ModelError({ kind: 'malformed-output' }),
        onSome: (ev) => Effect.succeed(ev.result),
      }),
    ),
    routes.withRoute(selected.wireRoute, selected.modelRoute),
    Effect.retry({
      while: isAutoRetryable,
      schedule: Schedule.spaced(retryWait).pipe(
        Schedule.recurs(maxAttempts - 1),
      ),
    }),
  );
  const result = yield* manualRetryLoop(attempt); // durable admission through Requests, not a schedule
  yield* ledger.append([modelTurnRow(result, selected)]); // usage attributed once, here
  return result;
});
```

What the model survey fixed or added:

- **Retry layers.** Provider SDK retries are already clamped to zero on both the handlers
  and the package (`SDK_RETRIES_DISABLED`, `maxRetries: 0`). The automatic batch is
  `Effect.retry` with `{ while, schedule }`; `Schedule.spaced` + `Schedule.recurs`
  reproduce `p-retry`'s fixed-interval batch exactly (the first evaluation is not a
  retry). The manual loop is `Requests.open({ kind: 'retry' })` with the proposal's
  `authorized` → `started` permit rows. The Kimi-Code credential fallback
  (`ModelInvocationNode.ts:225-264`) is invoker policy, expressed as a `Ref.set` of a new
  selection under a fresh `Scope.fork`. `auxiliaryRetry`'s SDK-side retries (eight
  sites) disappear once counting, uploads and compaction summarization run under the
  invoker.
- **The route gate is a session service** (`ModelRoutes`, row 9): two nested route
  scopes, a `Ref<version>` per route for the staleness re-check the current gate does
  (`ModelRetryGate.ts:126-152`), a `Latch` per route for cooling, one probe fiber. About
  60 LoC, not 10; still a fivefold cut.
- **Usage is one row.** `model.turn` carries the package's `UsageSchema` object, the
  resolved wire and usage routes, cost, response time, provider response id and returned
  model. Run totals fold from those rows; `recordCycleMetrics`' in-place mutation,
  `usageAccumulator`, and `UsageMonitor`'s live read of handler state delete;
  `UsageLogService` subscribes to the row.
- **Four gaps in `packages/llm` gate the handler retirement** and are named here so the
  cut is not booked before they close: hosted tools (web search and fetch;
  `ToolDefinitionSchema` admits only local functions; ≈400 LoC of handler code has no
  home), media uploads (`InputPartSchema` is inline base64 only; provider file uploads
  are an external operation and need an explicit package operation; ≈1,360 LoC of
  attachment code relocates), compaction (≈1,320 LoC of mechanism moves into the loop as
  ledger rows; the `updatedMessages` backchannel dies), and a `vscode-lm` `Model`
  factory (546 LoC of handler with no package counterpart). `ModelError` also needs
  `retryAfterMs`.
- **Net:** of ≈23,000 LoC in handlers, node, gate, cell and factory, roughly 11,000
  deletes outright, 2,700 relocates, and 950 is blocked on the four gaps.

### 5.5 Human requests (corrected)

Every wait on a person is `Requests.open`, and every decision arrives as a
`decision.*` arm of the existing `RuntimeRequest` vocabulary. The second route (a host
attachment method plus a controller's pending map, 13 hops for tool-edit approval)
deletes.

```ts
const open = Effect.fn('requests.open')(function* (
  req: OpenRequest,
  opts: { policy; bypassed },
) {
  const ledger = yield* RunLedger;
  const short = decideTexraApproval(opts); // allow/deny without a row, as every kind does today
  if (short) return short;
  return yield* perStream(req.streamId).withPermits(1)(
    // one prompt at a time per stream
    Effect.gen(function* () {
      if (yield* bypassedNow(req)) return autoApprove(req); // re-checked inside the permit, as streamApprovalQueue.ts:142-164 does
      const gate = yield* Deferred.make<RequestDecision>();
      yield* ledger.append([requestOpened(req)]);
      pending.set(req.requestId, gate);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => pending.delete(req.requestId)),
      );
      return yield* Deferred.await(gate);
    }),
  );
});
```

The tool survey found one contract revision 1 lost: the policy short-circuit before any
row is written, and the per-stream serialization with the bypass re-checked at dispatch
time, so "always allow" applies to calls already queued behind the prompt. Both are in
the sketch above. Three carve-outs are named rather than forced through `open`:

- **External inquiry** does not park the run: the tool returns after dispatch and the
  answer arrives as a follow-up. It is `openDetached`, and its delivery is
  `FollowUps.offer`, which also retires the separate continuation module
  (one-run-model §3.7).
- **Manual model retry** runs a `prepareRetry(selection)` step during the interaction
  (`ModelInvocationNode.ts:565-572`). That is a decide-side effect on the invoker's
  `Ref<Selected>`, expressed as the decision carrying the selection and the invoker
  applying it before consuming the permit.
- **Tool-edit approval** folds the user's edited content into the result
  (`finalizeApprovalResult`). That fold, and each kind's rejection-to-`ToolResult`
  mapping, stay tool-side; `open` returns the raw decision.

Until the `request.*` arms land, the same service writes today's `approval.requested`
and `approval.resolved` rows. `tool-outcome` is proposed vocabulary from the runtime
proposal §2.3, not an existing kind.

## 6. Replay, persistence and resume

This is the section the design exists for. The row vocabulary is the [runtime
proposal][runtime] §2.1's, extended by exactly the rows the resume survey showed are
missing; the fold and resume rules are §2.3's; what this section adds is the mapping from
today's resume state to rows, the crash windows each row closes, the family-specific
rules, and the workflow-mode protocol.

### 6.1 Every item of resume state becomes a row

Today's "state needed to resume" (survey §7) against the row that carries it:

| Family     | State item                                                                             | Today                                                      | Row                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| all        | replay coordinate (`nextNodeId`, `lastAction`)                                         | `flow_<id>.json` cursor                                    | `flow.step { phase, round?, turn }`; the phase names are the [loop study][loop] §4 table                      |
| all        | config, meta, lineage                                                                  | execution KV                                               | `run.start { agent, parent, mode }` (exists)                                                                  |
| all        | ownership                                                                              | lease file + `owner_id`                                    | `owner_id` claim (C5) only; the file fence is a scoped resource, not state                                    |
| all        | base point for the fold                                                                | whole `shared` blob per node step                          | `flow.snapshot` per turn or round (C10's one derived row)                                                     |
| tool-use   | `messages`                                                                             | blob, at cycle end                                         | `model.turn` (assistant, byte-exact `TurnResult`) + `model.message` (user, tool results) per activity         |
| tool-use   | `modelId`, compatibility key, continuation anchor (`previous_response_id`, sent count) | blob; anchor **not persisted**                             | `model.turn.continuation` (contract 0.1: continuation bound to the covered history prefix)                    |
| tool-use   | in-flight tool batch, partial results                                                  | in memory                                                  | `tool.intent` (barrier calls) + `tool.result` per call                                                        |
| tool-use   | pending approvals, retry permit                                                        | in-memory set                                              | `request.opened` / `request.decided`; `authorized` → `started` permit rows                                    |
| tool-use   | queued and drained follow-ups                                                          | in-memory array + local                                    | `followup.queued { deliveryId }` / `followup.consumed`                                                        |
| tool-use   | usage of the current turn                                                              | accumulator, at cycle end                                  | `model.turn.usage`                                                                                            |
| tool-use   | `shouldSkipCycle`, `lastError`, `userCancelledRetry`, `structured`                     | blob                                                       | `flow.step` phase (`turn.ready` vs `waiting`), `run.end { outcome, error }`, `tool.result` of `submit_output` |
| reflection | `currentRound`, `totalRounds`, `roundOutputs`, `continueRounds`, `endTurn`             | blob at node end                                           | `round.begin { round, total }` / `round.end { round, outcome, outputs }`                                      |
| reflection | partial generation of the current round                                                | the raw output file                                        | `output.pending { round, continuation, file, byteOffset, digest }` referencing the file as an artifact        |
| reflection | `compileFailureContext`, `unresolvedCompileRejection`                                  | blob                                                       | `round.end.compile { verdict, feedback }`                                                                     |
| workflow   | script, args, files, journal                                                           | KV `workflow-script-<hash>` (whole-file rewrite per entry) | `run.start.script` + `child.launched { key, ordinal }` / `child.result { key }` (§6.5)                        |
| workflow   | display state, skip/retry control plane                                                | `execution.workflow` snapshot + in-memory map              | folded from `child.*` and `request.decided { action: skip \| retry }`                                         |
| subagent   | attempt sequence, attempt phase, result manifest, `lastCompletedTurn`                  | four KV rows                                               | `child.launched { attempt }` + the child's own `run.end` / `model.turn` rows                                  |
| subagent   | parent delivery of a turn                                                              | in-memory pending slot                                     | `followup.queued` on the parent, written in the same batch as the child's `run.end`                           |

Every "❌ not durable" line of the survey becomes a row; nothing is restored from memory,
a file, or a process-local registry. The five KV families (`flow_`, `workflow-script-`,
`stable-subagent-*`, `turn-state`, `child-*`) delete with the writers that own them.

### 6.2 One fold, three uses

`foldRunState` is a pure step function `(RunState, RunRow) => RunState` in `src/shared`
(PR1 note §4). It has three callers, and no fourth: `RunLedger.append` folds the batch it
just committed and returns the state; `RunLedger.load` restores the latest
`flow.snapshot` and folds the tail; the stepper folds from the start with `Stream.scan`
(§3.4). Because the loop only ever sees state produced by that function, "state at step
k" and "the state the loop had after step k" are the same value by construction. Neither
the fold nor the loop reads a clock, a credential, or the UI.

### 6.3 Resume: switch on the folded phase, never on memory

`Runs.launch({ kind: 'resume', id })` acquires the C5 claim, calls `RunLedger.load`,
restores every open `request.*` through `Requests.restore`, and starts the same unfold.
The step function switches on `s.phase` and the unsettled rows the fold reports; the
recovery table below is the [loop study][loop] §5 table stated in rows.

| Folded evidence                                                         | Action                                                                                                                                                        | Closes       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `turn.ready`, no `model.turn` for this turn                             | invoke the model (nothing external was admitted)                                                                                                              | C1           |
| `model.turn` present, calls unsettled, no `tool.intent` for a call      | dispatch it if parallel-safe **and** recorded parallel-safe (§6.7); otherwise synthesize `CANCELLED_CALL_ERROR`                                               | C1           |
| `tool.intent` present, no `tool.result`                                 | outcome unknown: `Requests.open({ kind: 'tool-outcome' })` asks re-run or skip; never re-run blindly                                                          | C1           |
| all calls settled, no paired `model.message` batch                      | build the paired follow-up messages from settlements (pairing preserved)                                                                                      | C1           |
| `request.opened` without `request.decided`                              | re-park on a fresh `Deferred` under the same `requestId`; a late decision for a run not parked is a follow-up                                                 | C4           |
| `followup.queued` without `followup.consumed`                           | it is in the queue; `drain` sees it; no re-attachment channel                                                                                                 | C3           |
| `model.turn` with a `continuation` whose covered prefix equals history  | reuse the anchor (no full resend); otherwise the package refuses the anchor and the invoker sends full history                                                | C6           |
| `background.submitted` without `background.observed`                    | observe the remote operation with the saved retrieval data and deadline; never resubmit                                                                       | contract 0.1 |
| `child.launched` without `child.result`                                 | consult the child's own aggregate: `run.end` present → adopt its result row; live claim held → attach and await; neither → new attempt row                    | C7, C9       |
| `output.pending` without `round.end`                                    | reconcile the file against the recorded `byteOffset`/`digest`: complete a matching partial write, skip a complete one, surface a conflict; never append twice | C15          |
| `round.end` with `compile.verdict = rejected` and no next `round.begin` | the next round's prepare reads the verdict as feedback (the current `compileFailureContext` promotion, now a row read)                                        |              |
| `run.end` present                                                       | not resumable; `LaunchRefused.finished` (keeps #11313 semantics; the un-rewound-cursor trap C13 cannot occur because there is no cursor)                      | C13          |
| claim held by a live owner (C5 + pid liveness)                          | `LaunchRefused.ownedElsewhere`; no lease file to go stale                                                                                                     | C14          |

Model-retry recovery keeps the proposal §2.3 permit rule: `authorized` without `started`
may be consumed once; `started` without a `model.turn` needs a new decision.

### 6.4 Persistence granularity is the design

The reason today's resume loses work is not the file format; it is that the commit
boundary is the node. The activity/append pairs of §5.2 and §5.3 put the boundary at
every external effect: one batch per committed response, one `tool.intent` before every
barrier call, one `tool.result` after every call, one batch per consumed follow-up batch,
one batch per round end. `flow.snapshot` is written once per turn or round as a base
point, so `load` reads one snapshot plus a short tail rather than the whole history, and
the O(n²) rewrites of both the flow blob (a `structuredClone` of the conversation per
node step) and the workflow checkpoint (a whole-file rewrite per journal entry) go away.
Append-only does not mean unbounded resident memory: the fold keeps message history by
reference to `model.*` rows, and the invoker reads the referenced rows when it prepares
a turn.

### 6.5 Coordination with `delegate_multi_agents` (workflow mode)

A workflow-script run is an ordinary run whose activities are child launches. What the
survey found must be preserved is preserved; what it found duplicated collapses.

| Concern                      | Today                                                                                                                   | Design                                                                                                                                                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and collision       | deterministic `deriveExecutionId({ checkpointId })`; relaunch while live → "already running" success-shaped result      | same deterministic `RunId`; `Runs.launch` returns `LaunchRefused.alreadyRunning { id }` and the tool renders the same message                                                                                                                                     |
| Script re-execution          | resume re-runs the script from the top; a changed script keeps the prior journal                                        | same: the script is deterministic over `agent()`; `run.start.script` records it; a resumed run re-executes with the prior child rows as the cache                                                                                                                 |
| Which calls short-circuit    | journal hit on the content key `journalKey(prompt, options, depFingerprint)`; `index` is only the last matched position | the fold's `children` map keyed by the same content key; `agent()` first asks the fold, then `Runs.launch`; a hit is `CACHED` in the view. Never a call ordinal (§7.10)                                                                                           |
| In-flight child at crash     | not journaled → re-run, unless the stable-attempt marker says `committed` with a manifest; ambiguous → fail closed      | `child.launched { key, attempt }` without `child.result` → §6.3's child row: adopt if the child's aggregate ended, await if live, else a new attempt; the four KV rows and `stableSubagentAttempt.ts` delete because the child's own `run.end` is the attestation |
| Failed or skipped calls      | never journaled; resume re-runs them (by design)                                                                        | preserved: `child.result { outcome: failed \| skipped }` is written for the view but the cache lookup ignores it, so resume re-runs exactly as today                                                                                                              |
| `parallel()`                 | realm-side `Promise.all` over thunks, cap 512; host-side one `PQueue` plus the child loop's own budget                  | realm-side unchanged (realm isolation); host side one session `Semaphore` shared with every child launch, so the two limiters that today must avoid compounding become one                                                                                        |
| Concurrency, cancel, timeout | `PQueue`, per-call `AbortController` cascading from a run-level one, `pTimeout` at teardown, a first-fault ledger       | `Semaphore.withPermits`, fiber interruption through the run scope (the sandbox bridge is a `FiberSet`, §3.4), `Effect.timeout` at scope close, `Cause` keeps the first fault                                                                                      |
| `skip()` / `retry()` control | in-memory map keyed by live child id, driven by `workflow.control` requests                                             | `request.decided { action: skip \| retry, key }` rows on the workflow run; the fold marks the call, the step function interrupts or relaunches; survives a crash                                                                                                  |
| Budget (`maxAgentCalls`)     | in-memory counter charged on physical launch after queue admission                                                      | folded from `child.launched` rows (cached hits are free, as today)                                                                                                                                                                                                |
| What the user sees           | `WorkflowExecutionSnapshot` published as `execution.workflow` events, re-seeded from meta on resume                     | the same board folded from `child.*` and `request.*` rows of the workflow run; no separate snapshot, no re-seeding                                                                                                                                                |
| Parent delivery              | child result persisted, then turn-state, then a follow-up enqueued (C7)                                                 | the child's `run.end` and the parent's `followup.queued` are one batch (two aggregates, one transaction, as `run.start` + `run.activate` are today)                                                                                                               |

The script sandbox, its determinism requirement, and the content-addressed key are the
product; everything around them was generic Promise runtime, and Effect owns it now.

### 6.6 The fifteen crash windows, closed

| #   | Window today                                        | Closed by                                                   |
| --- | --------------------------------------------------- | ----------------------------------------------------------- |
| C1  | whole tool-use turn is one step                     | per-activity rows (§6.4)                                    |
| C2  | in-memory record cache invisible to other readers   | no cache; `load` reads rows                                 |
| C3  | drained follow-ups held in a local                  | `followup.consumed` in the same transaction as the messages |
| C4  | approvals in an in-memory set                       | `request.*` rows + `Requests.restore`                       |
| C5  | usage recorded at cycle end                         | `model.turn.usage`                                          |
| C6  | continuation anchor lost on resume                  | `model.turn.continuation`                                   |
| C7  | child result persisted before parent delivery       | one batch across the two aggregates                         |
| C8  | best-effort turn-state write swallowed              | the row is the attestation; there is no turn-state          |
| C9  | committed marker lost → irreconcilable              | the child's `run.end` is the marker                         |
| C10 | journal ahead of the display snapshot               | one row feeds both the cache and the view                   |
| C11 | whole-checkpoint rewrite per entry                  | append-only rows                                            |
| C12 | skipped/failed calls re-run on resume               | preserved by design (§6.5), now visible in the view         |
| C13 | un-rewound cursor makes a completed run unresumable | no cursor; `run.end` decides                                |
| C14 | stale lease file blocks resume                      | `owner_id` + pid liveness only                              |
| C15 | partial output file can double-append               | `output.pending.byteOffset`/`digest` reconciliation         |

### 6.7 Re-execution replay and the two-permission rule

The third replay (rev 2 §6) stays: `runLayer` with `ModelInvoker.layerReplay(ledger)` and
`Tools.layerReplay(ledger)` re-runs the unchanged loop against committed `model.turn` and
`tool.result` rows, failing with `ReplayDiverged` on a request the ledger cannot answer.
It is what makes loop tests deterministic and lets a real run become a fixture. Two rules
from the peer surveys make it and resume sound: tool re-execution needs the recorded
**and** the current `parallelSafe` (Pi), and deltas are live-only with the committed
response as the replayable boundary (OpenCode V2).

## 7. Surface map (revision 2)

Each row: what exists, what it becomes, what deletes (measured by the surface's survey,
estimates marked ≈), and the boundary it lands on.

| #    | Surface                                             | Effect-native form                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Deletes                                                                                                                                                                                                                                                                                                                                     | Boundary                        |
| ---- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 7.1  | Flow engine `src/agent/node/`                       | deleted; two loops in `src/agent/runtime/loop/`; `RunLedger.append` is the only write                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 675 LoC                                                                                                                                                                                                                                                                                                                                     | none                            |
| 7.2  | Tool-use family (9 files, 2,704 LoC)                | `runToolUse` + `runTurn` (§5.2); round state is generator locals; WAITING is a returned outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | the node classes; bodies move                                                                                                                                                                                                                                                                                                               | none                            |
| 7.3  | Reflection family (11 files + `output/`)            | `runReflection` with `Effect.scoped` + `acquireRelease(openStage)` per round; output helpers behind `OutputPipeline`                                                                                                                                                                                                                                                                                                                                                                                                                                                             | the five-node fan-in, `RoundPersistedFlow` (270), `ResponseCycleFlow` (633)                                                                                                                                                                                                                                                                 | none                            |
| 7.4  | Model layer                                         | `ModelInvoker` (§5.4) over `packages/llm`; `ModelRoutes` at the session; `Ref<Selected>` + `Scope.fork` on `Run`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | ≈11,000 LoC deleted, ≈2,700 relocated, ≈950 blocked on the four package gaps                                                                                                                                                                                                                                                                | foreign edge in `packages/llm`  |
| 7.5  | Tool runner + tools                                 | `dispatch` (§5.3); `execute(): Effect`; `ToolCall` three fields; registry process-scoped, overlay per run                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | ≈420 LoC of prelude/ports/imports, `ToolFileInteractionContext.ts` 72, `ToolUseDispatchNode.ts` 607, ≈200 of `streamApprovalQueue.ts`, ≈120 across five approval entry points: **≈1,420**                                                                                                                                                   | none (kind (b) retired)         |
| 7.6  | Approvals, retry, ask_user, inquiry                 | `Requests` (§5.5); every decision a `decision.*` `RuntimeRequest` arm                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | the host-method route: ≈450 of `HostInteractions.ts`, `ToolEditApprovalController`'s pending map, CLI `park()` stubs (≈150 of `subscribeApprovals.ts`); host-specific preview code (`desktopToolEditApproval.ts` 125, `VscodeToolEditApprovalHost.ts` 196, `approvalAdapter.ts` 314) stays as UI                                            | host command enters at kind (a) |
| 7.7  | Trace, publication, view                            | `TraceEmitter` stays synchronous (the [findings][findings] §3 price a `PubSub` hub at ≥27 files for one gained property); stage stack → `Run.stage` reference; publication = `RunLedger.append`, one shape, awaited; one fold per question; redaction at the durable boundary only                                                                                                                                                                                                                                                                                               | `StreamLogStore` 380, `StreamSnapshotStore` 312, `executionMetaFromEvents` + callers ≈80, stage-scope machinery ≈70, publication bookkeeping ≈60, two of three redaction sites: **≈900**                                                                                                                                                    | none                            |
| 7.8  | Follow-ups                                          | `FollowUps` (§4 row 13): `followup.queued`/`followup.consumed` ledger rows (dedup by `deliveryId` unique key, crash-safe), one `Queue.unbounded` per run, `Runs.handle(id)` as the only liveness predicate; goal continuation is an ordinary producer; `view.queuedFollowUps` folds from the rows                                                                                                                                                                                                                                                                                | ≈720 LoC replaced by ≈80                                                                                                                                                                                                                                                                                                                    | none                            |
| 7.9  | Native delegation, `childRunLoop`, workflow scripts | one `Runs.launch(spec)` with `mode: 'inband' \| 'detached'` (the difference is four flags today); `Deferred<ChildResult>` replaces `onTurnSettled` + pending-delivery slots; `Semaphore.withPermits` replaces both concurrency limiters; `Effect.timeout` at scope close replaces `pTimeout`; `Cause` replaces the first-fault ledger; the agent-CLI/bash `childStream` variant stays a distinct spec, not a flag                                                                                                                                                                | `persistence.ts` 276, `checkpointKey.ts` 43, `stableSubagentAttempt.ts` 548, `childRunBudget.ts` 74, `childRunDelivery.ts` 36, `detachedChildRun.ts` 210: **≈1,190 deleted**; `childRunLoop.ts` 1,280 → ≈450, `inBandSubagentExecution.ts` 498 → ≈150, `runWorkflowScript.ts` 1,021 → ≈600: **≈1,600 collapsed**                            | none                            |
| 7.10 | Workflow-script checkpoints                         | ordinary child result rows under the already-derived `deriveExecutionId({ checkpointId, key, parentExecutionId })`, keyed by the **content-addressed** journal key (a call ordinal would re-execute every call after an inserted sibling, a product regression); the journal becomes the fold's `children` map (§6.5); the sandbox, `parallel()`'s realm-side `Promise.all`, the failure asymmetry, `maxAgentCalls`, dependency-identity refresh and the skip/retry control plane are preserved                                                                                  | the four-way duplication per `agent()` call; the KV `turn-state` row and its ordering semaphore ≈110                                                                                                                                                                                                                                        | none                            |
| 7.11 | Session tier                                        | `SessionHandle` becomes a thin record `{ id, roots, events, ledger, runs, view }` (≈120 LoC) plus the approval-policy value; `Runs` owns liveness and admission; `StreamStatusMachine`'s map deletes because `foldRunState` is the reader; `finalizeFailedRun`'s classification survives as a pure `Exit → TerminalRow`                                                                                                                                                                                                                                                          | `executionRegistry` 924, `executionLanes` 247, `waitingTermination` 240, `executionInteractionOwnership` 218, ≈300 of `ExecutionHandle`, ≈450 of `executionLease` (the file fence survives), ≈700 of `AgentRunLifecycle`, ≈700 of `SessionHandle`, ≈250 of `StreamStatusService`, ≈120 of `AgentLaunchContext`: **≈4,680** against ≈600 new | none                            |
| 7.12 | Hosts (CLI, extension, desktop)                     | each root builds one `Layer`, holds its `ManagedRuntime` in a local, runs one program per host entry with `runtime.runPromiseExit(program, { signal })`; the ≈12 runtime-touching `HostRequest` arms (`resume`, `runNew`, `runCompileFixer`, `exportTranscript`, `useOwnApiKey`, `toolEdit`, …) move to `RuntimeRequest` and are answered by `SessionRequests` for all three hosts; the CLI joins `SessionBridge` with an in-process port so `frameSubscription` is the one fold-to-UI path; the webview keeps its own fold runtime by design (the transport carries fold input) | ≈250 LoC each from `extensionHostRequests.ts` and `desktopHostRequests.ts`, most of `hostRunActions.ts` (472), the CLI's duplicate slash-command handlers, two of three CLI view adapters (≈700), the second `LifecycleHost` per extension activation, the `session.runPromise` field name collision                                        | kind (a)                        |
| 7.13 | SDK `packages/agent`                                | `Sessions` = `open`/`close`/`list` over `WorkspaceRoots`; `Run` = `Runs.launch` + `SessionEvents.aggregate(id, 0)` tail + `SessionView.changes` slice; `Requests.layerDenyAll` for headless; `admitTools`/`admitInput` stay as package policy; shape of the Promise root unchanged                                                                                                                                                                                                                                                                                               | `TRACE_HANDOVER_EVENTS` buffer, `admitted` deferred + sentinel, the `uninterruptibleMask`/`spawned`/`interruptLaunch` dance, the private subscription drain, `HEADLESS_HOST`: ≈160 of `sessions.ts`'s 538                                                                                                                                   | kind (c)                        |
| 7.14 | Tests                                               | the 13 engine tests pinned to the record format delete with it; the six behavior suites move to `it.effect` over the real `RunLedger` layer, `TestClock` for retry and cooling, `layerReplay` fixtures from real runs                                                                                                                                                                                                                                                                                                                                                            | none                                                                                                                                                                                                                                                                                                                                        | none                            |

Across the six surveys the deletion pattern is the same: a durable fact exists, and a
second in-memory structure holds the same fact because the durable one had no typed,
awaitable, per-run reader. `RunLedger`, `Runs` and `SessionEvents.aggregate` remove the
reason for all of them.

## 8. Effect version and API verification (corrected)

Pinned: `effect@4.0.0-rc.112` (released 2026-08-25). `effect@4.0.0-rc.113` was published
on 2026-09-10 with a patch-only changelog (cache fixes, `Effect.all` union inference, a
`Mime` module replacing the `mime` dependency, tool-approval retention in `Chat`); none
of the names below changed. Recommendation: move the whole package family (`effect`,
`@effect/vitest`, `@effect/platform-node`, `@effect/sql-sqlite-node`) to rc.113 in one
dependency PR, which is the [delivery plan][plan] §2 rule applied to a patch release.

**Correction to revision 1.** The local `effect-solutions` reference clone
(`~/.local/share/effect-solutions/effect`, commit `3a1128c7`, 2026-07-14) is at
`4.0.0-beta.98`, older than the pin, not newer. The names its guides show were renamed
before rc.108: `Schema.TaggedErrorClass` → `Schema.TaggedError`, `Schema.ErrorClass` →
`Schema.Error`, `Schedule.andThen` → `Schedule.concat`. `Effect.Service`,
`Schedule.both`, `Schedule.while` and `Effect.catchAll` exist in neither. Refresh the
clone before consulting it for code. Everything below was checked in
`node_modules/effect/dist/*.d.ts` at rc.112 and re-checked in the rc.113 tarball.

| Design use           | rc.112 / rc.113 API (verified)                                                                                                                                   | Note                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Service tags         | `Context.Service<Self, Shape>()(id)`; `Context.Reference(key, { defaultValue })`; `Context.ServiceClass`                                                         | `Effect.Service` does not exist; there is no `FiberRef` module                                                                               |
| Layers               | `Layer.effect`, `scoped`, `succeed`, `provide`, `provideMerge`, `mergeAll`, `fresh`, `launch`; `LayerMap`                                                        | values memoize by reference: never hoist the run layer                                                                                       |
| Runtime              | `ManagedRuntime.make`; `runPromiseExit(effect, { signal })` (`RunOptions.signal`); `runFork`                                                                     | none                                                                                                                                         |
| Forking              | `Effect.forkChild`, `forkScoped`, `forkIn(scope)`, `forkDetach`; `FiberMap.run/make/join`, `FiberSet`                                                            | `forkDaemon` is gone; `forkDetach` is the global-scope fork                                                                                  |
| Interruption         | `Effect.uninterruptibleMask`, `interruptibleMask`, `onInterrupt`, `onExit`, `ensuring`, `exit`; `Exit.hasInterrupts`; `Fiber.interrupt`                          | none                                                                                                                                         |
| Foreign cancellation | `Effect.tryPromise({ try: (signal) => …, catch })`, `Effect.promise((signal) => …)`, `Effect.abortSignal: Effect<AbortSignal, never, Scope>`                     | none                                                                                                                                         |
| Retry                | `Effect.retry({ while \| until \| times \| schedule })`, `Effect.retryOrElse`                                                                                    | the v3 predicate combinators are gone                                                                                                        |
| Schedules            | `Schedule.spaced`, `recurs`, `exponential`, `jittered`, `during`, `upTo`, `max`, `min`, `concat`, `addDelay`, `modifyDelay`, `passthrough`, `tap`                | `Schedule.both`/`while`/`andThen` absent: pipe `recurs` after the delay schedule, use `max`/`min` and `Effect.retry`'s `while`               |
| Timeouts             | `Effect.timeout`, `timeoutOption`, `timeoutOrElse`                                                                                                               | none                                                                                                                                         |
| Concurrency          | `Effect.forEach(xs, f, { concurrency, discard })`; `Semaphore.make/withPermits`; `PartitionedSemaphore`; `Latch.make/whenOpen/open/close/isOpen`                 | `Effect.makeSemaphore` is not the v4 name                                                                                                    |
| Coordination         | `Deferred.make/await/succeed/fail/interrupt`; `Queue.unbounded/bounded/offer/take/poll/takeBetween/end`; `PubSub.bounded/unbounded/subscribe`; `SubscriptionRef` | none                                                                                                                                         |
| Streams              | `Stream.fromAsyncIterable(iter, onError)`, `Stream.callback((queue) => …)`, `tap`, `filter`, `runLast`, `runFold`, `runForEach`, `toAsyncIterable`               | none                                                                                                                                         |
| Errors               | `Data.TaggedError(tag)<Fields>` (yieldable); `Effect.catch`, `catchTag`, `catchTags`, `catchCause`, `catchDefect`; `Cause.squash/pretty`                         | `Schema.TaggedError`/`Schema.Error` exist but §15 decision 8 keeps Zod; `Effect.catchAll` does not exist (`Effect.catch`, declared `catch_`) |
| Tracing              | `Effect.fn(name)(gen, ...pipeables)`, `Effect.withSpan`, `Effect.annotateLogs`                                                                                   | none                                                                                                                                         |
| Resources            | `Effect.acquireRelease`, `acquireUseRelease`, `addFinalizer`, `Effect.scoped`; `Scope.make/close/fork`                                                           | none                                                                                                                                         |
| Testing              | `@effect/vitest` `it.effect` / `it.live` / `it.layer`; `TestClock.adjust` from `effect/testing`                                                                  | matches AGENTS.md                                                                                                                            |
| Not adopted          | `effect/unstable/workflow`, `effect/unstable/ai`, `effect/unstable/eventlog`                                                                                     | present at the pin; rejected per PRD §13.C, the [findings][findings] §4, and §5.4                                                            |

## 9. Where the corpus disagrees, and the reading taken

Recommended options are taken and stated, per the owner's 2026-09-10 rule.

1. **One `run` aggregate** (one-run-model §3.1 over proposal §2.1). `RunLedger.load`
   reads one history; the tail read is the ordinary indexed read after the snapshot's
   `commit`.
2. **The per-run service is `Run`** (one-run-model §3.10 over `RunContext` and
   `AgentRun`).
3. **`flow.snapshot` stays** as C10's one sanctioned derived row, carrying only what rows
   already carry; the reflection state PR1 §2.6 could not fit becomes rows.
4. **`RunContext` ALS retires with the loops**; `workspaceRoots` waits for the filesystem
   ruling (injection §6 steps 6 and 10).
5. **Injection Q1:** adopt Effect's `FileSystem` + `Path`, with the [findings][findings]
   §2 gaps closed inside TeXRA's thin rooted-filesystem functions first.
6. **Injection Q2:** the three provision points in §3.1 are the topology.
7. **Injection Q3:** `ModelInvoker`, `FollowUps`, `OutputPipeline` sit outside `Run` at
   run lifetime; `ToolCall` at call lifetime; `ToolRegistry` at process lifetime;
   `ModelRoutes` at session lifetime. Each is independently substituted in an existing
   test.
8. **Injection Q4:** the dispatcher retires R1 kind (b).
9. **The lease keeps only its file fence** (ownership note F2), acquired inside
   `Layer.scoped(Run, …)` and released by its finalizer; `Runs` owns liveness.
10. **`Runs` and `Requests` are one implementation with two tags** (this revision, from
    the session survey): a run is either executing or parked, and `interrupt` must handle
    both states with one code path. Streamless requests (`askUserQuestion` without a
    stream) carry `Option<RunId>`.
11. **`SessionView` is a manifest row** (this revision): it already exists as a tag and
    is the only consumer of the view fold; revision 1's omission contradicted its own
    surface map.
12. **`p-queue`** is forbidden by AGENTS.md line 774; every remaining importer is in the
    deletion set or becomes a `Semaphore`.

## 10. Delivery: three slices, one atomic cut, four package gaps first

The [delivery plan][plan] §7 packages and the [injection note][injection] §6 steps order
the work; this section maps the revised design onto them. The one-run-model S1
(identity) precedes slice 3 because `RunLedger`'s aggregate arm needs `RunId`.

| Slice | Content                                                                                                                                                                                                                                                                                                                                                                                   | Deletes (symbols that cease to exist)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Rows                                                                                                                                                                                  | Alone?                          |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 0     | **Package gaps.** `packages/llm` gains hosted-tool definitions, an explicit upload operation, a `vscode-lm` factory, `retryAfterMs` on `ModelError`; the family moves to rc.113                                                                                                                                                                                                           | nothing yet; unblocks ≈950 LoC of slice 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | none                                                                                                                                                                                  | yes                             |
| 1     | **Run layer, `Runs`, `Requests`, `SessionView` row.** `Layer.scoped(Run, …)` inside `runAgent`; flip the `runner` seam at `AgentRunLifecycle.ts:479` to `Effect`; `Runs` as `FiberMap` over the existing admission rules; `Requests` over today's `approval.*` rows with one decision route; the ≈12 `HostRequest` arms move to `RuntimeRequest`                                          | `RunContext` ALS, `RunScope`, both `AsyncLocalStorage.bind` sites in `executeAgent.ts`, `HostInteractions.pending` and the seven request methods, `streamApprovalQueue.enqueue`, `executionLanes.ts`, `waitingTermination.ts`, `executionInteractionOwnership.ts`, the run `AbortController`, `forkDetach` at `AgentRunLifecycle.ts:541`, `hostRunActions.ts`                                                                                                                                                                                                                                                                                           | `new AbortController(` −3, `p-defer` −3, below-boundary `Effect.run*` −2, `async-mutex` → 0                                                                                           | yes (injection steps 6, part 7) |
| 2     | **Tool boundary.** `execute(): Effect`; `ToolCall` three fields; `ToolRegistry` process tag; 54 tools drop prelude and `runPromise`; bash's process-group release written explicitly                                                                                                                                                                                                      | `ToolFileInteractionContext` ALS, 14 `bind` sites, 62 `effectRuntime()` sites in `src/tools`, 7 `Ports` interfaces, `ITool.call(): Promise`, `SharedToolInjectionRegistry`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | the `src/tools/**/*Tool.ts` run allowance retires; the one new site in the dispatcher is a widening the ratchet refuses                                                               | **no**: lands inside slice 3    |
| 3     | **The atomic cut.** Engine + both loops + `dispatch` + `ModelInvoker` + `ModelRoutes` + `FollowUps` rows and queue + `OutputPipeline` + one child launch op + checkpoints as child rows + `RunLedger`/`foldRunState` with the §6.1 row vocabulary (PR1 note, first on the branch) + `layerReplay` for both invoker and tools + the CLI onto `SessionBridge` + SDK on the session services | `src/agent/node/**`, the node and flow classes, `ModelInvocationNode.ts`, `ModelRetryGate.ts`, `ModelCell.ts`, `helperModel.ts`, `IModelHandler` + `modelHandlers/**`, `ToolUseSessionLifecycle.ts`, `FollowUpQueue.ts`, `ToolUseFollowUpQueueManager.ts`, `workflowScript/persistence.ts`, `checkpointKey.ts`, `stableSubagentAttempt.ts`, `childRunBudget.ts`, `childRunDelivery.ts`, `detachedChildRun.ts`, `StreamLogStore.ts`, `StreamSnapshotStore.ts`, `StreamStatusService.ts`'s map, `executionRegistry.ts`, `provideAgentEngine`, the SDK handover buffer, `docs/architecture/2026-06-20-pocketflow-state.md`, AGENTS.md's PocketFlow section | `setServices()` → 0, `dep:@agent/node` → 0, `dep:@agent/modelHandlers` → 0, `p-retry` → 0, `p-map` → 0, `p-timeout` → 0, `p-queue` → ≈2, `catch:effect-importer` −4, `Effect.run*` −5 | no: one merge, stacked reviews  |

Slice 2 cannot land alone for the reason revision 1 gave: converting `execute()` moves
the run site from 54 tool files to the one dispatcher file, which is below the boundary,
and the ratchet refuses a file newly entering the row. Its mechanical parts (the
`ToolCall` service, the per-tool edits, the `bind` deletions) are reviewed first on the
integration branch and merge with slice 3.

Summed over the surveys, slice 3 removes on the order of 20,000 LoC (≈11,000 model,
≈4,700 session, ≈2,800 child dispatch, ≈1,400 tools, ≈900 trace and view, ≈720
follow-ups, ≈675 engine) and relocates ≈3,000 (compaction, media, reflection output
bodies), against roughly 1,500 LoC of new services and loops. The numbers are the
surveys' estimates; the PR that claims each row re-derives it.

Gates per slice are the [delivery plan][plan] §8 table. Slice 3 additionally runs the
six behavior suites the plan names, migrated to `it.effect` over the real `RunLedger`
layer, the proposal §2.3 crash-window cases behind a real process, and one replay
fixture per family recorded from a real run (§6, third row).

## 11. Collapse ledger

Everything the surveys found duplicated, and the one thing it becomes.

| Today                                                                                                               | Becomes                                                            |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| six liveness authorities + the `liveSessions` set                                                                   | `Runs` (`FiberMap` + C5 claim)                                     |
| three pending-request registries (interactions set, controller map, view list) and two decision routes              | `Requests` + `decision.*` arms                                     |
| two command vocabularies (`RuntimeRequest`, `HostRequest`) + CLI slash duplicates                                   | one `RuntimeRequest` for session operations                        |
| four folds over the same rows                                                                                       | two: the view fold and `foldRunState`                              |
| seven publication entry methods, four fire-and-forget                                                               | `RunLedger.append`, awaited                                        |
| three redaction sites                                                                                               | one, at the durable boundary                                       |
| five KV families (`flow_`, `workflow-script-`, `stable-subagent-*`, `turn-state`, `child-*`) beside the event table | rows on the run aggregate                                          |
| four durable records per workflow `agent()` call                                                                    | `child.launched` + `child.result`                                  |
| six child-launch entry paths, two primitives, in-band vs detached as four flags                                     | `Runs.launch(spec)` with `mode`; `childStream` as one spec variant |
| two concurrency limiters on child launches                                                                          | one session `Semaphore`                                            |
| three in-memory follow-up layers + a third resume channel                                                           | `followup.*` rows + one `Queue` per run                            |
| five retry layers on one model call (SDK, batch, gate, manual, auxiliary)                                           | `Effect.retry` + `ModelRoutes` + `Requests` (SDK stays at 0)       |
| five `AsyncLocalStorage` carriers + 13 `bind` re-entry sites                                                        | three services + two references                                    |
| 54 tool preludes, 7 `Ports` interfaces, 62 run sites in `src/tools`                                                 | `execute(): Effect`                                                |
| three CLI view adapters + `getUnsafe` pokes on hosts                                                                | one `SessionBridge` frame stream                                   |
| three `ManagedRuntime` owners (process global, SDK refcount, webview) reached through ≈300 `effectRuntime()` reads  | one per host root, in a local; the webview's is a root too         |
| two `LifecycleHost`s per extension activation                                                                       | one                                                                |
| the node graph, the cursor, the flow record, the round flow, the response-cycle fan-in                              | `Stream.unfold` over `turn` / `round`                              |

## 12. What this design refuses

- **A generic activity or step abstraction.** Two loops and one append do not justify
  an interpreter; the [findings][findings] §4 record what `unstable/workflow` would cost,
  and the same costs apply to any repo-owned equivalent. Replay (§6) is a layer swap, not
  an engine.
- **A `PubSub` behind the trace.** One gained property against seven adapter-owned ones
  and ≥27 files ([findings][findings] §3).
- **Effect Schema anywhere in the runtime.** Zod owns every payload (§15 decision 8).
- **Any adapter, shim, flag, or dual engine.** R1's second ruling and R10's struck
  clause. Slice 3 is atomic for exactly this reason.
- **A tag per class or per `Platform` port.** R2 and the delivery plan's negative;
  twenty tags is the reviewed count, and §4 says for each why it is a tag and not a
  value.
- **A per-call tool timeout, a `pipeline()` sandbox helper, or a call-ordinal checkpoint
  key.** None exists today; each would be new behavior or a regression dressed as a
  port.

## 13. Verified

- `main` at `c29238e6bd` surveyed by ten read-only passes (runtime internals; Effect
  adoption; the design corpus; six deep surface passes: hosts, session tier, child
  dispatch, model layer, tools and approvals, trace/view/follow-ups/SDK; and one pass over
  resume and replay end to end for both families, workflow scripts and subagents) with file:line
  citations reproduced in §1 and §7; counts are direct references, LoC figures are the
  surveys' measurements or estimates as marked.
- `Stream.unfold` (effectful step returning `[A, S] | undefined`), `Stream.scan`,
  `Stream.concat` and `FiberSet.makeRuntimePromise` (with `propagateInterruption`) were
  verified at rc.112 for §3.4.
- Every API in §8 was checked by grep against `node_modules/effect/dist/*.d.ts` at
  rc.112 and against the `effect@4.0.0-rc.113` tarball downloaded from npm on
  2026-09-10; the four absent names were confirmed absent in both, and the three renames
  were confirmed by comparing the beta.98 source in the local `effect-solutions` clone.
- `effect-solutions list` and `show basics services-and-layers error-handling
data-modeling testing config` were read; the reference clone's `ai-docs/src` and
  `cookbooks/schedule.md` were read for the service, resource, pubsub, stream and AI-tool
  patterns cited.
- Peer designs are cited from the [loop study][loop] and its pinned sources
  (OpenCode `337fd144`, Pi `9767ba27`, effect-agent `bedf7f8f`), not re-derived.
- No production code, data format, or public API changed.

[prd]: ./2026-08-26-effect-4-runtime-migration.md
[runtime]: ./2026-09-04-agent-runtime-on-effect.md
[substrate]: ./2026-09-03-persistence-substrate-decision.md
[plan]: ./2026-09-06-effect-runtime-delivery-plan.md
[injection]: ./2026-09-10-effect-native-injection-context-pipelines.md
[onerun]: ./2026-09-10-one-run-model.md
[pr1]: ./2026-09-08-pr1-run-ledger-foundation.md
[findings]: ./2026-09-08-effect-4-interface-findings.md
[loop]: ./2026-09-06-agent-loop-architecture-study.md
