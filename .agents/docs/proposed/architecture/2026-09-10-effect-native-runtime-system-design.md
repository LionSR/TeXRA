---
created: 2026-09-10
status: proposed
revision: 4
---

# The Effect-native agent runtime: one system across every surface

**Recommendation:** finish the runtime as one Effect program tree built from native
`Context.Service` tags, `Layer` composition, and `Context.Reference` values, not as a
set of converted files. The tree has four scopes (process, session, run, call), twenty
tags across them (`FileSystem` + `Path` count as one platform service, provided together by
`@effect/platform-node`), two `Effect.fn` loops driven by `Stream.unfold`, one durable append,
and one place where a fiber's `Exit` becomes a run outcome. Every surface that touches a
run today (the flow engine, both flow families, the tool runner, model handlers,
follow-ups, approvals, child dispatch, workflow scripts, the trace, the view, the three
hosts, the SDK) is mapped below to its position in that tree, to the layer that provides
it, and to the pinned Effect API it uses. The run is replayable along its flow: the step
vocabulary is the graph, one pure fold gives the state at any step, and replay is a layer
swap.

**Revision 4 (2026-09-11)** re-verifies the note against main at `047c88cf6e` (anchors re-checked against the merge base `0eb57310b8`) and the
Effect pin at `4.0.0-rc.113`, and takes a reading on each of the 26 review threads left
on PR #12210 (§14 maps thread to section). Three things changed underneath revision 3:
the one-run-model S1 landed (#12222: branded `RunId`, every `execution*`/`stream*`
module renamed `run*`, `StreamTabId` gone), the Effect family moved to rc.113 with
vitest 5 (#12257), and a run of "1.0 clean slate" PRs deleted or shrank files the note
cited. Revision 2 (2026-09-10) followed six deep read-only passes over the surfaces;
revision 3 (same day) made replay, persistence and resume the central section (§6),
added the native pipeline (§3.4), the ownership table (§2.1) and the collapse ledger
(§11). Peer designs (OpenCode V2, Pi's harness, effect-agent) are cited from the [loop
study][loop] rather than re-derived.

This document does not restate the rules or the rows. The [migration PRD][prd] §7 owns
R1 to R10, the [runtime proposal][runtime] §2.1 owns the row vocabulary and §2.3 the
fold and resume rules, the [substrate decision][substrate] §6.1 owns C1 to C10, the
[injection note][injection] §5 owns the carrier manifest, and the [one run
model][onerun] §3.10 owns the names. Where those documents disagree, §9 says which
reading this design takes and why.

## 1. Verified starting point (`main` at `047c88cf6e`, 2026-09-11)

Counts are direct references measured on this commit unless stated; "was" gives the
revision 3 figure at `c29238e6bd` where it moved.

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Consequence                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 510 files import `effect` (was 526); 467 `Effect.fn`, 350 `Effect.gen`, 243 `Stream.`, 149 `Deferred.`, 142 `Scope`/`Effect.scoped` (non-test); 18 `Context.Service` tags in 14 files; **two** `ManagedRuntime.make` (`sessionLayer.ts:769`, `webviewSessionLayer.ts:80`, one per host root); two `LayerMap.make` (`sessionLayer.ts:525`, `leanServerPool.ts:144`); **one** `Semaphore.make` (`memoryFileSystem.ts:302`) plus 14 `makeUnsafe`. `PubSub`, `Context.Reference`: zero.                               | The idiom is established. What is missing is the runtime's own program tree and the layers that compose it.                                                                                    |
| The one-run-model S1 landed (#12222): `RunId` is a branded Zod type (`src/shared/schemas/identifiers.ts:9-14`), `StreamTabId` has zero references, and ~30 runtime modules are renamed `run*` (`runRegistry.ts`, `runLanes.ts`, `RunHandle.ts`, `RunStatusService.ts`, `runApprovalQueue.ts`, `RunSnapshotStore.ts`, `runLease.ts`, `inBandSubagentRun.ts`, `childRun.ts`). #12246 landed one event vocabulary and one terminal fact; #12249 one tool-call status; #12215 one approval decision vocabulary.       | The identity and vocabulary prerequisites of §10 are banked. Two of the renamed files carry names this design also uses (`RunHandle`, `RunStatusService`); §4 row 7 says which replaces which. |
| The Effect spine of a run stops at one line: `runFlowWithLifecycle`'s `runner` is `(handle, lifecycle) => Promise<AgentRuntimeFlowResult>` (`AgentRunLifecycle.ts:458-461`). Below it: `src/agent/node/` (675 LoC), `implementations/flows/**` (8,301 LoC; two files import `effect` only to call `effectRuntime()`), `ModelInvocationNode.ts` (845), `modelHandlers/**` (21,058).                                                                                                                                | The run layer is provided at that line; the code below it is the deletion set.                                                                                                                 |
| Tools: 54 `protected execute()` methods and 51 registry entries under `src/tools`; 62 `effectRuntime()` sites there. About 35 tools' `execute` is nothing but an `AsyncLocalStorage.bind` prelude plus `runPromise` (≈250 lines); 7 `Ports` interfaces exist only to type that capture. The single `.call()` site is `ToolUseDispatchNode.ts:314`.                                                                                                                                                                | Tool bodies are Effect; the runner is not. Converting the runner deletes ≈420 LoC of prelude and retires R1 boundary kind (b).                                                                 |
| `packages/llm` (9,736 LoC after #12229/#12232, six `Model` factories) defines the Effect-typed model contract: `prepareTurn`/`streamTurn`/`generateTurn`/`background.*` return `Effect`/`Stream`; the terminal `completed` event carries a `TurnResult` validated by `TurnResultSchema` (`turn.ts:1402-1438`); `ModelError extends Data.TaggedError` (`:1593`). Two production importers, neither on the run path. No factory for `vscode-lm`; no hosted-tool definitions; inline media only.                     | `ModelInvoker` is written over `packages/llm`. Four capabilities must be written into the package before the handlers can retire (§5.4).                                                       |
| Liveness has **six** authorities: `RunRegistry.handles`, `RunStatusService`'s in-memory phase map, `RunHandle.terminalState`, `RunLanes.live`, the `ownedLeases` process map plus claim files (`runLease.ts:126`), and `event_sequence.owner_id`. A seventh registry, the module-global `liveSessions` set (`SessionHandle.ts:752`), sits beside the `Sessions` `LayerMap`.                                                                                                                                       | One session service owns "is this run live and who may write" (§4 row 7). About 4,500 LoC of arbitration ceases to exist (§7.11).                                                              |
| Human waits: seven request kinds go through one `enqueue` that creates a `new Promise` and adds to an in-memory `pending` set; the extension and desktop attachments implement one of the six optional methods each (`HostInteractions.ts:365-381`), and `dispatch` auto-cancels a request whose method is missing (`:901`). Six of seven kinds already decide through the fold plus `decision.*` arms of `RuntimeRequest`; tool-edit approval takes a second, 13-hop route through a controller.                 | One route for every kind (§5.5). The auto-cancel hazard (#12083) disappears by construction.                                                                                                   |
| Hosts: `effectRuntime()`/`run*` sites number 128 (CLI, 43 files), 97 (extension, 23), 99 (desktop, 18). A typed, shared command vocabulary exists (`RuntimeRequest`, 13 arms, one handler `SessionRequests.handle`). A second vocabulary (`HostRequest`, 41 arms) is dispatched three different ways, and the CLI re-implements its runtime subset as slash commands.                                                                                                                                             | The hosts already share a view path (extension and desktop) and a command vocabulary; the cut is to finish both (§7.12).                                                                       |
| Four folds run over the same rows: `sessionFold` (1,913 LoC, the view), `createTranscriptFold` (instantiated twice, once inside the view and once in `StreamLogStore`, now 294 LoC after #12242), `RunSnapshotStore` (294), `runMetaFromEvents` (`RunKVStore.ts:197`). Redaction runs at three sites. Publication has seven entry methods, four fire-and-forget through `schedulePublication` (`SessionHandle.ts:612`).                                                                                           | One fold per question (one-run-model R1): the view fold and the run-state fold. Three private folds delete (§7.7).                                                                             |
| Follow-ups: three in-memory layers (`FollowUpQueue` + `p-defer`, a per-run lease map with a 1,000-entry dedup set and tombstones, `ToolUseSessionLifecycle`); **zero durable queue rows**. A crash loses every queued follow-up. Resume re-attaches through a third channel (`drainedFollowUps` + `takePendingFollowUps`, 26 sites each).                                                                                                                                                                         | Follow-ups become ledger rows plus one `Queue` per run (§7.8).                                                                                                                                 |
| Child dispatch: six entry paths, two launch primitives, one driver (`childRunLoop.ts`, 1,214 LoC). In-band and detached differ by four flags. A workflow `agent()` call is recorded four times (script journal, child result row, stable-attempt marker, workflow snapshot). Cancellation is an `AbortController` cascade attached to handles, not interruption. `childRunDelivery.ts` was already deleted (#12240).                                                                                              | One launch operation with a `mode`; checkpoints become child result rows keyed by the existing content-addressed journal key with a physical run id per attempt (§7.9, §7.10).                 |
| Resume today: the whole tool-use turn is **one** persisted step, written when `ToolUseCycleNode.post` returns (`persistedFlow.ts:363-372`); a crash mid-turn re-runs tools that already ran. Not restored: round state, in-flight tool results, pending approvals, queued follow-ups, the provider continuation anchor, current-turn usage. Reflection's only mid-round checkpoint is the partial output file. There is no stepper or scrubber in any host. Fifteen crash windows are enumerated in §6.6.         | Persistence at the activity boundary, not the turn boundary, is the whole difference (§6). Every item in the "state needed to resume" table (§6.1) gets a row.                                 |
| SDK: `packages/agent/src/effect/sessions.ts` (533) re-implements admission (an `admitted` `Deferred`, a two-window interrupt dance, a 512-event trace handover buffer with warn-and-drop) because no typed per-run launch or durable tail is available underneath.                                                                                                                                                                                                                                                | The SDK becomes the same session services plus Promise rendering; ≈160 LoC of `sessions.ts` deletes (§7.13).                                                                                   |
| Effect pin: `4.0.0-rc.113` for `effect`, `@effect/vitest`, `@effect/platform-node`, `@effect/sql-sqlite-node`; vitest 5 (#12257). 92 suites import `@effect/vitest` (52 moved by #12214). Ratchet rows: `platform()` 49/102, `setServices()` 6/6, `new AbortController(` 11/12, `p-queue` 11, `p-defer` 3, `p-retry` 3, `p-map` 1, `p-timeout` 1, `async-mutex` 1, below-boundary `Effect.run*` 11/27, `catch:effect-importer` 8/10, `dep:@agent/node` 25/27, `dep:@agent/modelHandlers` 8/26; knip baseline 234. | §10 says which rows each slice drives to zero; §11 lists every collapse and marks the ones already banked.                                                                                     |

## 2. The fiber tree

Effect's structured concurrency gives the runtime its lifetime model for free if the
fork sites are chosen deliberately. Every later section places itself in this tree.

```text
process scope            ManagedRuntime (one per host root; disposal registered into LifecycleHost, R6)
└─ session scope         Sessions LayerMap entry (exists: sessionLayer.ts:525)
   │                       Database, SessionEvents, RunLedger, SessionView, Runs, ModelRoutes, WorkspaceRoots
   ├─ run fiber  ───────  Runs.launch: FiberMap.run(runs, runId, program)   [forkIn session scope]
   │  │                    Layer.effect(Run)(acquireRun(launch)) provided around the program; Run owns
   │  │                    identity, the model selection Ref + its Scope.fork, trace, policy, overlay tools
   │  ├─ turn / round       plain Effect.gen inside runToolUse / runReflection (no fiber)
   │  │  ├─ model call      ModelInvoker.invoke on the calling fiber: `model.attempt` row, then the provider
   │  │  │                  Stream consumed with Stream.tap (deltas to trace); its terminal `completed`
   │  │  │                  event is the TurnResult; AbortSignal only inside Effect.tryPromise
   │  │  ├─ dispatch        parallel-safe segment = Effect.forEach({ concurrency: 4 }), results appended in
   │  │  │  │                call order once the segment settles
   │  │  │  └─ tool call      one child fiber per call; Effect.provideService(ToolCall, …);
   │  │  │                     cancel = interrupt that fiber; bash additionally kills its process group
   │  │  │                     from a release action (the one named exception)
   │  │  └─ wait            FollowUps.wait / Requests.open: Deferred.await on the calling fiber; the run
   │  │                      PARKS here (phase `waiting`), it does not return
   │  └─ settlement         Effect.onExit at the root: terminal rows appended under the claim;
   │                        Scope closes (finalizers: trace detach, model scope)
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
- **A waiting run stays in its fiber.** `waiting` is a durable phase (`flow.step
waiting`), not a returned outcome: the loop parks on `FollowUps.wait` or
  `Requests.open` inside its scope, a follow-up wakes it, a stop interrupts it, and a
  restart re-parks it from the fold. `RunOutcome` is the terminal subset of the phase
  vocabulary (one-run-model §3.3). Revision 3 returned `waiting` from the root program,
  which would have finalized the run's scope and resources; that is withdrawn.
- **In-band delegation awaits; it does not parent.** `Runs.launch` returns
  `{ id, result: Deferred<ChildResult>, interrupt }`. An in-band caller yields
  `Deferred.await(result).pipe(Effect.onInterrupt(() => handle.interrupt))`: because the
  child is a session-scoped entry and not a child fiber, the parent's interruption reaches
  it only through that explicit hook, and only for `mode: 'inband'`; a detached child
  outlives its parent by definition. A detached child's delivery to its parent is **part of the
  child's terminal transaction**: `Runs` appends the child's `run.end` and the parent's
  `followup.queued` in one cross-aggregate batch (as `run.start` + `run.activate` are one
  batch today), then completes the `Deferred`. Revision 3 offered the follow-up from a
  parent-side fork after the await, which reopened crash window C7; withdrawn.
- **The child strategy contract drops its `AbortSignal` parameters.** Today
  `launch(ports, signal)` and `runTurn(followUps, ports, signal)` (`childRunLoop.ts`)
  carry a signal that a `ChildRunInterruptible` controller aborts. `Fiber.interrupt` on
  a map entry only becomes the cancel path once those parameters are gone.
- **No `forkDetach` survives in the runtime.** Five sites exist today: `AgentRunLifecycle.ts:520`
  (the `onRun` host callback), `childRunLoop.ts:1119` and `:1198` (child cost commit and
  launch), `detachedChildRun.ts:180`, and the SDK's launch. The first becomes
  `forkIn(sessionScope)`; the others delete with their files (§7.9, §7.13).
- **Interruption is the only cancellation.** `RunScope.signal`, the run
  `AbortController` (`AgentLaunchContext.ts:492`), `linkAbortSignals`, the per-call
  signal field (which is the run signal passed through, with 20 of 21 tool-side readers
  being pure forwarding), and the workflow-script controller cascade all delete. Foreign
  SDKs get a signal from `Effect.tryPromise((signal) => …)`; `Effect.abortSignal` covers
  a long-lived foreign object. Bash's process-group teardown (`execUtils.ts:207-375`) is
  preserved as the release of an `Effect.acquireRelease` around the spawn.
- **Interrupting a barrier tool does not settle it.** A non-parallel-safe call that
  already has a `tool.intent` row and is interrupted mid-adapter is left **unsettled**:
  no `cancelled` row is fabricated, and resume meets an intent without a result, which is
  the outcome-unknown path (proposal §2.3). Only calls whose non-execution is provable
  (parallel-safe, or never dispatched) settle as `CANCELLED_CALL_ERROR`.
- **Masks are small.** The one uninterruptible region per activity is the append handoff
  (`Effect.uninterruptibleMask((restore) => …)` with preparation under `restore`).

Peer confirmation, from the [loop study][loop] §3: OpenCode V2's runner is an
`Effect.fn` while loop with no step cursor, tool settlement under `uninterruptibleMask`,
and a durable input inbox promoted at safe boundaries; Pi's harness commits the
assistant operation intent before provider I/O and settles interrupted results from
recorded frames. Both are this tree. OpenCode starts tools while the stream is still
open; this design commits the validated `TurnResult` first (contract 0.1).

### 2.1 Ownership: one owner per fact, one writer per row

Every fact has exactly one owning service, that service is the only writer of the rows
that carry it, and everyone else reads the fact through the fold or the service's tag,
never through a second structure. A row's **shape** belongs to its owner; the
**transaction** that carries it may be another owner's batch when atomicity demands it
(the child's terminal batch carrying the parent's `followup.queued` is the one case, and
`FollowUps.row(...)` is the pure builder `Runs` calls). The table is normative.

| Fact or resource                                | Owner (tag)                  | Lifetime | Writes                                                                                                                     | Readers                                                                    | Replaces                                                                                        |
| ----------------------------------------------- | ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| the process runtime                             | the host root (a local)      | process  | none                                                                                                                       | host entries only                                                          | `processRuntime.ts` global, SDK refcount, `effectRuntime()` reads                               |
| which sessions exist                            | `Sessions` (`LayerMap`)      | process  | none                                                                                                                       | hosts, SDK                                                                 | the `liveSessions` set                                                                          |
| committed rows, their order, the C6 transaction | `SessionEvents`              | session  | every row, on behalf of the callers below                                                                                  | `SessionView`, `RunLedger`, hosts' tails, the SDK                          | `schedulePublication`, four fire-and-forget publish methods                                     |
| run state (the fold)                            | `RunLedger`                  | session  | `flow.snapshot`                                                                                                            | the loops (via `append`/`load`), the stepper                               | `persistedFlow.ts`, `RunSnapshotStore`, `runMetaFromEvents`, `RunStatusService`'s map           |
| run liveness, admission, the C5 claim           | `Runs`                       | session  | `run.start`, `run.end`, `child.launched`, `child.result`, and the parent `followup.queued` inside a child's terminal batch | hosts (`interrupt`, `handle`), tools (`launch`), `FollowUps` (is it live?) | the six authorities in §1, `runRegistry`, `runLanes`, `RunHandle.ts`, `runLease.ts`             |
| pending human decisions                         | `Requests`                   | session  | `request.opened`, `request.decided`                                                                                        | the view (pending = opened without decided), the parked fiber              | `HostInteractions.pending`, `runApprovalQueue`, the controller's map                            |
| per-route cooling and probing                   | `ModelRoutes`                | session  | none (in-memory `Latch` + version `Ref` per route)                                                                         | `ModelInvoker`                                                             | `ModelRetryGate`, `SessionHandle.modelRetries`                                                  |
| the view                                        | `SessionView`                | session  | none (a fold)                                                                                                              | every renderer, through `changes`                                          | `StreamLogStore`, `getUnsafe` pokes                                                             |
| workspace roots                                 | `WorkspaceRoots`             | session  | none                                                                                                                       | filesystem functions                                                       | `workspaceRoots.ts` ALS                                                                         |
| run identity, policy, trace, stage stack        | `Run`                        | run      | none                                                                                                                       | everything under the run                                                   | `RunContext` ALS, `RunScope`, `AgentCore`                                                       |
| the selected model and its resources            | `Run.model` (`Ref` + scope)  | run      | none                                                                                                                       | `ModelInvoker`                                                             | `ModelCell`                                                                                     |
| model attempts, results, usage, continuation    | `ModelInvoker`               | run      | `model.attempt`, `model.turn`, `model.compaction`, `background.*`                                                          | the loop                                                                   | `ModelInvocationNode`, handler mutable state, `recordCycleMetrics`, `UsageMonitor`'s live reads |
| tool calls and their settlement                 | `dispatch` (in the loop)     | run      | `tool.intent`, `tool.result` (incl. duplicate and skipped settlements), paired `model.message`                             | the loop, the fold                                                         | `ToolUseDispatchNode`                                                                           |
| the base tool registry                          | `ToolRegistry`               | process  | none                                                                                                                       | `dispatch`                                                                 | lazy singleton, `SharedToolInjectionRegistry`                                                   |
| the run's overlay tools and end-of-turn latch   | `Run.overlay`, `Run.endTurn` | run      | none                                                                                                                       | `dispatch`, `submit_output`                                                | per-run overlay construction in `runToolUseFlow.ts`                                             |
| queued input                                    | `FollowUps`                  | run      | `followup.queued`, `followup.consumed` (+ the `model.message` rows of a consumed batch)                                    | the loop (`wait`/`drain`), the view                                        | three in-memory layers, `updateQueuedFollowUps`                                                 |
| phase coordinates and round facts               | the loop                     | run      | `flow.step`, `round.begin`, `round.end`, `output.pending`                                                                  | the fold, the stepper                                                      | the cursor, `RoundPersistedFlow`                                                                |
| reflection output artifacts                     | `OutputPipeline`             | run      | none (writes files; facts go through the loop's `round.end`)                                                               | the loop                                                                   | four manager objects                                                                            |
| per-call context                                | `ToolCall`                   | call     | none                                                                                                                       | the tool body                                                              | `ToolFileInteractionContext` ALS                                                                |
| token deltas                                    | `Run.trace` (synchronous)    | run      | none durable                                                                                                               | renderers, live only                                                       | unchanged (§7.7)                                                                                |
| shutdown                                        | `LifecycleHost`              | process  | none                                                                                                                       | the runtime's disposal registers into it                                   | unchanged (R6)                                                                                  |

There is no file lease in this table. The [ownership note][lease] F2 leaves the lease one
unique job, fencing `RunKVStore` checkpoint files, and slice 3 moves every one of those
writes into SQLite; the lease, its ALS re-entrancy set, its claim files and their
stale-lease refusals (`runLease.ts`, 633 LoC) delete at that cutover, and the database
claim (C5) is the only write authority. Revision 3 kept a "file fence" on `Run`; the
reviewers were right that it would have fenced nothing.

## 3. Layers: how the tree is composed

Native `Context.Service` tags are only useful if the layers that provide them compose,
and composability is what makes replay (§6) a layer swap rather than a mode flag.

### 3.1 The layer graph

```ts
// process root, one per host (packages/{cli,desktop,extension,agent}/src)
const processLayer = Layer.mergeAll(
  Secrets.layer(adapters.secrets),
  AppState.layer(adapters.state),
  NodeFileSystem.layer,
  NodePath.layer, // @effect/platform-node, injection Q1
  SetupPlatform.layer(adapters.setup),
  ToolRegistry.layer, // 51 singleton tools + injections (§4 row 2)
  LogSink.layer(adapters.log),
  FetchHttpClient.layer,
);

// session, one LayerMap entry per workspace root (exists: sessionLayer.ts:481-525)
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
// one model selection across runs, because Layer values memoize by reference).
// rc.113: Layer.effect excludes Scope from the effect's requirements, so a scoped
// acquisition IS Layer.effect; there is no Layer.scoped.
const runLayer = (launch: LaunchInput) =>
  Layer.mergeAll(
    ModelInvoker.layer,
    FollowUps.layer,
    OutputPipeline.layer,
  ).pipe(Layer.provideMerge(Layer.effect(Run)(acquireRun(launch))));

// call-local: not a layer, a subtree provision
tool
  .call(input)
  .pipe(Effect.provideService(ToolCall, { callId, instruction, hooks }));
```

Three provision points and one subtree provision, exactly as the [injection
note][injection] §3.1 fixes; no fourth. The arrows are `Layer.provideMerge`: a shorter
lifetime is built from a longer one, never the reverse (R3). Each host root holds its
`ManagedRuntime` in a local, and `processRuntime.ts`'s throwing global accessor deletes
when the last of the 398 `effectRuntime()` reads is gone. `FollowUps.layer` is
`Layer.effect` over the folded `RunState`: it seeds the run's `Queue` with every
`followup.queued` row that has no `followup.consumed`, so a resumed run finds its
durable input in the queue without a re-attachment channel.

### 3.2 What composability buys, concretely

| Substitution                  | Layer swapped                                                              | Who uses it                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Headless SDK                  | `Requests.layerDenyAll` for `Requests`                                     | `packages/agent` (replaces the `HEADLESS_HOST` stub, `sessions.ts:206`)                                        |
| Webview renderer              | `SessionView.layer` over a `SessionInputs` fed by frames instead of SQLite | `webviewSessionLayer.ts` already does this; it is the finished native root the injection note names            |
| Replay from the ledger        | `ModelInvoker.layerReplay(ledger)`, `Tools.layerReplay(ledger)`            | §6: the viewer's stepper, deterministic tests, "re-run this turn with the recorded I/O"                        |
| Test clock                    | `it.effect` provides `TestClock`; retry schedules advance without sleeping | `ModelInvoker`'s automatic retry, `ModelRoutes`' cooling                                                       |
| Fake model, fake tools        | `Layer.succeed(ModelInvoker, …)`, `Layer.succeed(ToolRegistry, …)`         | every loop test; today these need `createFakePlatform` plus `setServices()` plus an ALS frame                  |
| Process-scoped vs. run-scoped | `ToolRegistry` (process) + `Run.overlay` (run value)                       | the base registry is a singleton of stateless instances (`registry.ts:76-78`); only `submit_output` is per run |

The rule for whether something is a tag or a value (R2) still applies. Agent definition,
prompt, setting, initial state, and every per-visit local remain plain arguments. Twenty
tags is the reviewed count.

### 3.3 `Context.Reference` for the one defaulted ambient value

Effect 4 has no `FiberRef`; `Context.Reference(key, { defaultValue })` is the
request-scoped value with a default, read without a layer and overridden per subtree
with `Effect.provideService`. One carrier becomes a reference: the trace stage stack,
held on `Run` and keyed per run so cross-trace inheritance cannot recur. Revision 3
listed a second (the lease maintenance set); it deletes with the lease (§2.1).
Everything else that was ambient becomes a service whose absence fails to compile.

### 3.4 The pipeline, natively

A run is a stream of durable rows and the states they fold to. Effect's stream
primitives express that directly, and the loops become the step function of an unfold
rather than a hand-written driver around one:

```ts
// The loop as a pipeline. `turn` is the Effect.fn of §5.2; it appends its rows through
// RunLedger.append and returns the folded state, so every emitted element is a committed
// state. A turn that must wait parks INSIDE `turn` (FollowUps.wait); the unfold stops only
// on a terminal phase. rc.113: unfold's step is effectful and returns `[A, S] | undefined`.
export const runToolUse = (start: ToolUseStart) =>
  Stream.unwrap(
    loadOrInit(start).pipe(
      // loadOrInit is effectful (RunLedger.load or the initial append); unfold's seed is the plain state it yields
      Effect.map((initial) =>
        Stream.unfold(initial, (s) =>
          isTerminal(s.phase)
            ? Effect.succeed(undefined)
            : turn(s).pipe(Effect.map((next) => [next, next] as const)),
        ),
      ),
    ),
  ).pipe(Stream.runLast, Effect.map(outcomeOf));

// Inspect: the same fold over the persisted rows, one state per row, no execution.
export const statesAt = (rows: Stream.Stream<RunRow>) =>
  rows.pipe(Stream.scan(emptyRunState, foldRunStep));

// Observe: history then tail with an explicit cursor, so a row committed between the two
// reads is neither missed nor duplicated. `aggregate` returns the rows and the last commit
// it saw; `tail` starts strictly after that commit.
export const observe = (events: SessionEvents, id: RunId) =>
  Stream.unwrap(
    events
      .aggregate(id, 0)
      .pipe(
        Effect.map(({ rows, lastCommit }) =>
          Stream.concat(Stream.fromIterable(rows), events.tail(id, lastCommit)),
        ),
      ),
  );
```

Three consequences:

- **R4 is satisfied, not bent.** There is still no graph, cursor, node or flow record;
  `Stream.unfold` is a while loop whose state after each step is observable to any
  subscriber. The same `turn` runs under `Effect.fn` in tests and under the unfold in
  production.
- **Deltas and rows are two streams with one consumer model.** Token deltas are
  `Stream.tap` inside `ModelInvoker.invoke` (live-only); rows are what `observe` yields.
  A renderer merges `observe` with the delta stream; the ledger never sees a delta.
- **The workflow-script sandbox bridge is a fiber set, not a global runtime.** The
  script's `agent()` global is `FiberSet.makeRuntimePromise` (rc.113, with
  `propagateInterruption`) scoped to the workflow run: every Promise the sandbox awaits
  is a fiber the run owns, interrupted when the run's scope closes. That is the one
  legitimate Effect-to-Promise crossing inside the runtime (a `node:vm` realm is a
  foreign edge in R1's sense), and it replaces `effectRuntime().runPromise` at
  `WorkflowScriptTool.ts:605` and the per-call `AbortController` cascade.

## 4. Service manifest

Twenty tags across four lifetimes; §2.1 says which fact each owns. Each row names the
shape a program yields, what it deletes, and the surveys' measured LoC (re-measured on
`047c88cf6e`). Ids follow `@texra/<area>/<Name>`. Where a name below already exists on
main for a structure this design replaces (`RunHandle`, `RunStatusService`), the row says
so; the new value takes the name when the old class deletes in the same cut.

| #   | Tag                                                                                    | Lifetime | Shape (yielded API)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Deletes                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `Secrets`, `AppState`, `SetupPlatform`, `LogSink`, `FileSystem` + `Path`, `HttpClient` | process  | per [injection note][injection] §5 rows 1 to 4, 13 to 15                                                                                                                                                                                                                                                                                                                                                                                                                                   | `platform()` reads; `processRuntime.ts` once every root holds its runtime in a local                                                                                                                                                                                                                   |
| 2   | `@texra/tools/ToolRegistry`                                                            | process  | `base: MapToolRegistry` (51 singleton instances), `injections: readonly ToolInjection[]`                                                                                                                                                                                                                                                                                                                                                                                                   | `getDefaultToolRegistry` lazy singleton, `SharedToolInjectionRegistry` mutable array (`toolInjection.ts:34`)                                                                                                                                                                                           |
| 3   | `@texra/session/Database`                                                              | session  | exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | none                                                                                                                                                                                                                                                                                                   |
| 4   | `@texra/session/SessionEvents`                                                         | session  | exists; landed 2026-09-13 as one inbox and one consumer fiber rather than a `Semaphore(1)` plus a `FiberSet`: `publish` (awaited batch), `exclusive` (read-then-append as one job), `detach` (synchronous enqueue for the trace subscriber), `settle` (drain what is detached); every writer of the log, the run ledger included, is a job on it, so commit order is enqueue order; `aggregate(id, from): Effect<{ rows, lastCommit }>` and `tail(id, afterCommit): Stream` still proposed | `SessionHandle.schedulePublication` + `publications` + `settlePublications` (`:612-631`); the four fire-and-forget publish methods become awaited appends                                                                                                                                              |
| 5   | `@texra/session/RunLedger`                                                             | session  | `append(rows): Effect<RunState, LedgerRefused>`, `load(runId): Effect<RunState \| null, LedgerRefused>`; both fold with `foldRunState` ([PR1 note][pr1] §3). One aggregate per run (banked by #12222).                                                                                                                                                                                                                                                                                     | `persistedFlow.ts` (517), `FlowRecord`, `flow_<id>` KV writes, the preservation ladder (`runToolUseFlow.ts:619-664`), `RunSnapshotStore.ts` (294), `runMetaFromEvents` and its callers, KV `turn-state`, `RunStatusService.ts`'s in-memory map (322)                                                   |
| 6   | `@texra/session/SessionView`                                                           | session  | exists (`SessionView.ts:42`): `ref: SubscriptionRef<SessionView>`, `changes: Stream`; the only consumer of `sessionFold.ts`                                                                                                                                                                                                                                                                                                                                                                | `StreamLogStore.ts` (294) and its second `createTranscriptFold`; the six `SubscriptionRef.getUnsafe` pokes on hosts become `changes` readers                                                                                                                                                           |
| 7   | `@texra/session/Runs`                                                                  | session  | `launch(spec): Effect<RunHandle, LaunchRefused>` where `RunHandle = { id, result: Deferred<ChildResult>, interrupt }` (the value replaces today's `RunHandle.ts` class, 351); `interrupt(runId)`; `handle(runId): Option<RunHandle>`; backed by `FiberMap<RunId>` and the ledger's C5 claims. **One implementation also provides tag 8.**                                                                                                                                                  | `runRegistry.ts` (896), `runLanes.ts` (247), `waitingTermination.ts` (215), `runInteractionOwnership.ts` (195), `RunHandle.ts` (351), `runLease.ts` (633, whole), the `liveSessions` set, `provideAgentEngine`, `childRunBudget.ts` (74), `detachedChildRun.ts` (191)                                  |
| 8   | `@texra/session/Requests`                                                              | session  | `open(req, { policy, bypassed }): Effect<RequestDecision, LedgerRefused, Scope>`, `openDetached(req): Effect<RequestId, LedgerRefused>` (inquiry), `decide(id, decision): Effect<void, UnknownRequest \| LedgerRefused>`, `restore(runState)`; one prompt at a time per run via `Semaphore.withPermits(1)` with the bypass re-check inside the permit                                                                                                                                      | the six `HostInteractions` request methods + `enqueue`/`dispatch`/`settleRequest`/`settleRetry`/`pending` (≈450 of 997), `runApprovalQueue.ts` `enqueue` (≈200 of 366), the CLI `park()` stubs, `ToolEditApprovalController`'s second pending map, `p-defer` there                                     |
| 9   | `@texra/session/ModelRoutes`                                                           | session  | `withRoute(wire, model)(effect)`: cooling and probing per route key, two nested scopes, a version `Ref` per route for the staleness re-check                                                                                                                                                                                                                                                                                                                                               | `ModelRetryGate.ts` (337) and `SessionHandle.modelRetries` (`:226,293`); session-scoped because the gate coordinates credential failures across concurrent runs (a run-scoped latch would recreate the retry herd)                                                                                     |
| 10  | `@texra/session/WorkspaceRoots`                                                        | session  | exists; widened per injection §5 row 5                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `workspaceRoots.ts` ALS (after the filesystem ruling)                                                                                                                                                                                                                                                  |
| 11  | `@texra/agent/Run`                                                                     | run      | `id: RunId`, `identity: RunIdentity` (exists, `runIdentity.ts`), `parent`, `agent`, `workingDirectory`, `policy`, `model: Ref<Selected>` with `Scope.fork` per selection (`swap = Scope.close(old) *> Ref.set(new)`), `trace`, `stage: Context.Reference`, `workspace` (tracker, work plan), `overlay: readonly ITool[]`, `endTurn: Latch`, `scope`                                                                                                                                        | `RunContext` ALS (47 readers), `RunScope`, `AgentCore`, `BaseFlowContextInit`, `ModelCell.ts` (140), `AgentLaunchContext.ts`'s rollback ladder and `linkAbortSignals`, both `AsyncLocalStorage.bind` sites in `executeAgent.ts`, `Flow.setServices()`                                                  |
| 12  | `@texra/agent/ModelInvoker`                                                            | run      | `prepare(request): Effect<ResolvedTurn, ModelError>`, `invoke(turn): Effect<TurnResult, ModelFailure \| LedgerRefused>` (appends `model.attempt` before I/O), `count(turn)`, `submit(turn): Effect<RemoteOperation, ModelFailure \| LedgerRefused>` (commits the handle before returning), `observe(op)`                                                                                                                                                                                   | `ModelInvocationNode.ts` (845), `helperModel.ts` (99), `auxiliaryRetry.ts` (42), `p-retry`, `IModelHandler` and `src/agent/modelHandlers/**` (21,058) once §5.4's four gaps are closed in `packages/llm`                                                                                               |
| 13  | `@texra/agent/FollowUps`                                                               | run      | `wait: Effect<Option<Batch>>` (`Queue.take`; `None` when the queue is ended at run end), `drain: Effect<Option<Batch>>` (`Queue.poll`), `row(...)` (pure builder of `followup.queued`), `consume(batch): Effect<RunState, LedgerRefused>` (one C6 transaction: `followup.consumed` + `model.message` rows + `turn.ready`); the layer seeds the queue from the fold                                                                                                                         | `ToolUseFollowUpQueueManager.ts` (347), `FollowUpQueue.ts` (164), `ToolUseSessionLifecycle.ts` (93), the `drainedFollowUps`/`takePendingFollowUps` re-attachment (`resumeRun.ts:447-453`, four `executeAgent.ts` sites), the four `updateQueuedFollowUps` publishers, the goal-continuation race check |
| 14  | `@texra/agent/OutputPipeline`                                                          | run      | `produce(state): Effect<OutputFacts, OutputError>`, `reconcile(pending)`                                                                                                                                                                                                                                                                                                                                                                                                                   | the four stateful managers in `ReflectionServices.ts`; three `effectRuntime().runPromise` boundaries in reflection nodes                                                                                                                                                                               |
| 15  | `@texra/agent/ToolCall`                                                                | call     | `{ callId, instruction, hooks }` (three fields; `tracker`, `trace`, `workPlan` are run-lifetime and live on `Run`; the signal is the fiber; there is no `attempt` because dispatch never retries a tool)                                                                                                                                                                                                                                                                                   | `ToolFileInteractionContext.ts` (72), its 35 reader sites, the 7 `Ports` interfaces, 14 `AsyncLocalStorage.bind` sites in tools                                                                                                                                                                        |

## 5. The two programs

### 5.1 Signatures

```ts
export const runToolUse: (start: ToolUseStart) => Effect.Effect<
  RunOutcome, // terminal phases only: 'completed' | 'cancelled' | 'halted'   (data, R7)
  RunFailure, // LedgerRefused | ModelFailure | ToolsRefused                    (typed, R7)
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

Success carries every terminal product outcome, including the ones that arrive today as
thrown sentinels. `waiting` is not among them: a waiting run is parked, not finished
(§2). Error carries expected operational failures that end the attempt, each a
`Data.TaggedError` with Zod-typed fields and no SDK object; `LedgerRefused` (the claim was
lost, C5) is the one every writer can raise, and nothing below the root catches it,
because a run that has lost its claim may not write again. Interruption is interruption:
the root's `Effect.onExit` turns `Exit.hasInterrupts` into the `cancelled` terminal row.
Defects are never caught below the root.

### 5.2 A turn, with its one mask

```ts
const runTurn = Effect.fn('toolUse.turn')(function* (s: RunState) {
  const ledger = yield* RunLedger;
  const model = yield* ModelInvoker;
  const followUps = yield* FollowUps;

  if (s.phase === 'waiting') {
    const batch = yield* followUps.wait; // parks the fiber; a stop interrupts it here
    if (Option.isNone(batch))
      return yield* ledger.append([runEnd(s, 'cancelled')]); // queue ended: terminal phase, the unfold stops
    s = yield* followUps.consume(batch.value);
  } else {
    const queued = yield* followUps.drain;
    if (Option.isSome(queued)) s = yield* followUps.consume(queued.value);
  }

  s = yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const prepared = yield* restore(model.prepare(request(s)));
      const turn = yield* restore(model.invoke(prepared)); // appends model.attempt first, model.turn on success
      return yield* ledger.append([
        ...compactionRows(turn),
        step('response.ready'),
      ]);
    }),
  );

  if (s.pendingCalls.length === 0)
    return yield* ledger.append([snapshot(s), step(nextPhase(s))]);
  s = yield* dispatch(s.pendingCalls, s); // returns the state AFTER its own appends
  return yield* ledger.append([
    pairedFollowUpMessages(s),
    snapshot(s),
    step('turn.end'),
  ]);
});
```

`dispatch` returns the folded `RunState` after its per-call appends, so the snapshot is
built from the state that already contains the settlements; revision 3 built it from the
pre-dispatch state, which the [PR1 note][pr1] §4.4 reconciliation would reject as stale.

### 5.3 Dispatch: three combinators, not one

`ToolUseDispatchNode` (609 LoC) carries four product contracts: barriers, parallel-safe
segments, duplicate fan-out with its reset windows, result order, and the absence of
fail-fast sibling interruption.

```ts
const dispatch = Effect.fn('tools.dispatch')(function* (calls, state) {
  const { overlay, endTurn } = yield* Run;
  const { base } = yield* ToolRegistry;
  const fs = yield* FileSystem.FileSystem;
  const ledger = yield* RunLedger;
  const registry = overlayRegistry(base, overlay);
  let s = state;

  // partition() keeps today's partitionDuplicateCalls windows: read signatures reset at every
  // barrier, unsafe signatures reset after a different mutation. Duplicate primaries live on
  // the segment, never on the whole response.
  for (const segment of partition(calls)) {
    if (endTurn.isOpen) {
      // rc.113: a boolean, not an Effect
      s = yield* ledger.append(segment.calls.map((c) => skippedResult(c))); // skipped calls are settled rows too
      continue;
    }
    if (segment.barrier) {
      const call = segment.calls[0];
      yield* ledger.append([intent(call)]); // tool.intent at the dispatch site
      const exit = yield* registry
        .get(call.name)
        .call(call.input)
        .pipe(
          Effect.provideService(ToolCall, callContext(call, s)),
          Effect.exit,
        );
      if (Exit.hasInterrupts(exit)) return yield* Effect.interrupt; // intent stays unsettled: outcome unknown
      const settlement = yield* settle(fs, call, exit); // captures attachment bytes BEFORE the row
      s = yield* ledger.append([result(call, settlement), end(call)]);
      continue;
    }
    // parallel-safe: run concurrently, settle in call order, one batch per segment
    const exits = yield* Effect.forEach(
      segment.primaries,
      (call) =>
        registry
          .get(call.name)
          .call(call.input)
          .pipe(
            Effect.provideService(ToolCall, callContext(call, s)),
            Effect.exit,
          ),
      { concurrency: MAX_PARALLEL_TOOL_CALLS },
    );
    const settled = yield* Effect.forEach(segment.primaries, (call, i) =>
      settle(fs, call, exits[i]),
    );
    s = yield* ledger.append([
      ...segment.primaries.flatMap((call, i) => [
        result(call, settled[i]),
        end(call),
      ]),
      ...segment.duplicates.map((d) =>
        duplicateResult(d, settled[segment.primaryIndex(d)]),
      ), // duplicateOf rows
    ]);
  }
  return s;
});
```

- **`Effect.forEach` with `concurrency`** replaces `PQueue` for the parallel-safe
  segment only. Each body ends in `Effect.exit`, so a tool failure is a settlement and
  cannot interrupt siblings. The one thing that can fail the segment is the ledger
  refusing the append, and that is correct: a run whose claim is gone must stop writing.
- **Settlement rows are appended in call order, one batch per segment,** after the
  segment settles. Concurrent completion order never reaches the ledger, so replay folds
  the same intermediate states as the live run. A crash mid-segment loses only
  parallel-safe results, which re-run by rule.
- **Duplicates and skipped calls are rows.** A duplicate gets its own `tool.result` with
  `duplicateOf`; a call skipped after `endTurn` gets a `skipped` settlement. Every
  `tool_use` in the response has a settlement row before the paired message is built.
- **Duplicate windows are the existing ones.** `partition` reuses the
  `partitionDuplicateCalls` contract (`read A; mutate A; read A` runs the second read).
- **`Latch.isOpen`** replaces the `TurnEnded` throw-and-catch; the current partition
  settles before the short-circuit.
- **Attachments are captured before the row.** `settle` reads attachment bytes through
  `FileSystem` and encodes them, or a durable omission reason, into the settlement; the
  row never points at a mutable workspace path.
- **No per-call timeout.** None exists today (`SdkToolCall` has no `timeout`), and
  `src/tools/timeouts.ts` is a per-HTTP-request deadline that stays as it is.
- **Cancellation.** A parallel-safe call interrupted mid-flight settles as
  `CANCELLED_CALL_ERROR` (provably re-runnable). A barrier call with a `tool.intent`
  does not: dispatch propagates the interruption and leaves the intent unsettled (§2).
  Bash's `executeCommand` keeps its process-group kill as the release of an
  `Effect.acquireRelease` around the spawn.

The tool contract is one line in `src/tools/core/base.ts`:
`protected abstract execute(input: T): Effect.Effect<ToolResult, never, ToolCall | Run>`
(requirements narrowed per tool), with `call()` an `Effect.fn` that Zod-validates and
maps `ZodError` to the existing diagnostics. Per tool the change is deleting the
prelude and the `runPromise`; ≈9 lines each across 54 tools. That retires R1 boundary
kind (b) and answers injection Q4.

### 5.4 Model invocation

`packages/llm` already produces the completed turn: the terminal `completed` event of
`streamTurn` carries a `TurnResult` validated by `TurnResultSchema` (`turn.ts:1402-1438`).
`ResolvedTurn` is the prepared invocation (contract 0.1 row 2), so `invoke` takes the
output of `prepare`. The attempt is durable **before** provider I/O.

```ts
const invoke = Effect.fn('model.invoke')(function* (turn: ForegroundTurn) {
  const run = yield* Run;
  const routes = yield* ModelRoutes;
  const ledger = yield* RunLedger;

  const attempt = (selected: Selected) =>
    Effect.gen(function* () {
      const attemptId = yield* nextAttemptId; // minted inside, so every retry gets its own row
      yield* ledger.append([modelAttempt(turn, selected, attemptId)]); // identity + prepared digest, before any I/O
      return yield* selected.model.streamTurn(turn).pipe(
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
      );
    });

  // automatic batch: rc.113 Retry.Options take while, times and schedule together
  const automatic = (selected: Selected) =>
    attempt(selected).pipe(
      Effect.retry({
        while: isAutoRetryable,
        times: maxAttempts - 1,
        schedule: Schedule.spaced(retryWait),
      }),
    );

  // manual admission: each authorized attempt re-reads the selection, which the decision may have changed
  let result = yield* automatic(yield* Ref.get(run.model)).pipe(Effect.either);
  while (Either.isLeft(result) && isUserRetryable(result.left)) {
    const decision = yield* (yield* Requests).open(
      retryRequest(result.left),
      policy,
    );
    if (decision.action !== 'retry')
      return yield* new RetryDeclined({ cause: result.left });
    yield* applySelection(run, decision); // Kimi-Code -> personal, or any credential change: Scope.close(old) *> Ref.set(new)
    result = yield* attempt(yield* Ref.get(run.model)).pipe(Effect.either); // one authorized attempt
  }
  if (Either.isLeft(result)) return yield* Effect.fail(result.left);
  yield* ledger.append([modelTurnRow(result.right)]); // usage attributed once, here
  return result.right;
});
```

What the surveys and the review fixed:

- **The attempt is a row before I/O.** `model.attempt` carries the invocation identity
  and the prepared request's digest; a background submission adds the accepted
  operation handle before observation. Resume meeting an attempt without a `model.turn`
  is the outcome-unknown path that the proposal's `pendingRetry` permit rules govern; it
  never blindly resubmits.
- **Retry layers.** Provider SDK retries are already clamped to zero on both the
  handlers and the package. The automatic batch is `Effect.retry` with `while`, `times`
  and `schedule` together (rc.113 `Retry.Options`), which reproduces `p-retry`'s
  fixed-interval batch exactly. The manual loop is `Requests.open({ kind: 'retry' })`
  with the proposal's `authorized` → `started` rule; the `model.attempt` row is the
  `started` mark. Each authorized attempt re-reads `run.model`, so the Kimi-Code to
  personal-credential fallback (`ModelInvocationNode.ts:225-264`) is an ordinary
  selection change applied before the attempt, never a closure over a stale selection.
- **The route gate is a session service** (`ModelRoutes`, row 9): two nested route
  scopes, a `Ref<version>` per route for the staleness re-check the current gate does
  (`ModelRetryGate.ts:158,245`), a `Latch` per route for cooling, one probe fiber.
- **Usage is one row.** `model.turn` carries the package's `UsageSchema` object, the
  resolved wire and usage routes, cost, response time, provider response id, returned
  model, and the continuation anchor bound to the covered history prefix.
- **Four gaps in `packages/llm` gate the handler retirement:** hosted tools (web search
  and fetch; `ToolDefinitionSchema` admits only local functions; ≈400 LoC of handler code
  has no home), media uploads (`InputPartSchema` is inline base64 only; ≈1,360 LoC of
  attachment code relocates), compaction (≈1,320 LoC of mechanism moves into the loop as
  ledger rows; the `updatedMessages` backchannel dies), and a `vscode-lm` `Model`
  factory (546 LoC of handler with no package counterpart). `ModelError` also needs
  `retryAfterMs`.
- **Net:** of ≈23,000 LoC in handlers, node, gate, cell and factory, roughly 11,000
  deletes outright, 2,700 relocates, and 950 is blocked on the four gaps.

### 5.5 Human requests

Every wait on a person is `Requests.open`, and every decision arrives as a `decision.*`
arm of the existing `RuntimeRequest` vocabulary (13 arms, one handler); #12215's
`approvalDecision.ts` already gives both GUI hosts one decision vocabulary. The second
route (a host attachment method plus a controller's pending map, 13 hops for tool-edit
approval) deletes.

```ts
const open = Effect.fn('requests.open')(function* (
  req: OpenRequest,
  opts: { policy; bypassed },
) {
  const ledger = yield* RunLedger;
  const short = decideTexraApproval(opts); // allow/deny without a row, as every kind does today
  if (short) return short;
  return yield* perRun(req.runId).withPermits(1)(
    // one prompt at a time per run
    Effect.gen(function* () {
      if (yield* bypassedNow(req)) return autoApprove(req); // re-checked inside the permit (runApprovalQueue.ts semantics)
      const gate = yield* Deferred.make<RequestDecision>();
      pending.set(req.requestId, gate); // the waiter exists BEFORE the row is visible
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => pending.delete(req.requestId)),
      );
      const state = yield* ledger.append([requestOpened(req)]);
      const already = decidedIn(state, req.requestId); // a decision that raced the append
      return already ?? (yield* Deferred.await(gate));
    }),
  );
});
```

The tool survey found one contract revision 1 lost, kept here: the policy short-circuit
before any row is written, and the per-run serialization with the bypass re-checked at
dispatch time. The review found a second, fixed above: the `Deferred` is registered
before the row is published, and the folded state returned by the append is consulted
for a decision that raced it, so a fast host or another process cannot decide a request
that has no waiter. `decide` appends `request.decided` and completes the gate; a decision
for a run that is not parked is a follow-up (one-run-model §3.7).

Three carve-outs are named rather than forced through `open`:

- **External inquiry** does not park the run: `openDetached` writes the row and returns;
  the answer arrives through `FollowUps.offer`, which retires the separate continuation
  module.
- **Manual model retry** carries its credential selection in the decision; the invoker
  applies it before the authorized attempt (§5.4).
- **Tool-edit approval** folds the user's edited content into the result
  (`finalizeApprovalResult`); that fold and each kind's rejection-to-`ToolResult` mapping
  stay tool-side.

Until the `request.*` arms land, the same service writes today's `approval.requested` and
`approval.resolved` rows. `tool-outcome` is proposed vocabulary from the runtime proposal
§2.3, not an existing kind.

## 6. Replay, persistence and resume

This is the section the design exists for. The row vocabulary is the [runtime
proposal][runtime] §2.1's, extended by exactly the rows the resume survey and the review
showed are missing; the fold and resume rules are §2.3's.

### 6.1 Every item of resume state becomes a row

| Family     | State item                                                                             | Today                                                      | Row                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| all        | replay coordinate (`nextNodeId`, `lastAction`)                                         | `flow_<id>.json` cursor                                    | `flow.step { phase, round?, turn }`; the phase names are the [loop study][loop] §4 table                        |
| all        | config, meta, lineage                                                                  | run KV                                                     | `run.start { agent, identity: RunIdentity, parent, mode }` (exists)                                             |
| all        | ownership                                                                              | lease file + `owner_id`                                    | `owner_id` claim (C5) only; the lease deletes                                                                   |
| all        | base point for the fold                                                                | whole `shared` blob per node step                          | `flow.snapshot` per turn or round (C10's one derived row)                                                       |
| tool-use   | the admitted model call                                                                | nothing until the response                                 | `model.attempt { attemptId, invocation identity, prepared digest }`; `background.accepted { handle, deadline }` |
| tool-use   | `messages`                                                                             | blob, at cycle end                                         | `model.turn` (assistant, byte-exact `TurnResult`) + `model.message` (user, tool results) per activity           |
| tool-use   | `modelId`, compatibility key, continuation anchor (`previous_response_id`, sent count) | blob; anchor **not persisted**                             | `model.turn.continuation` bound to the covered history prefix (contract 0.1)                                    |
| tool-use   | in-flight tool batch, partial results, duplicates, skips                               | in memory                                                  | `tool.intent` (barrier calls) + `tool.result` per call incl. `duplicateOf` and `skipped` settlements            |
| tool-use   | pending approvals, retry permit                                                        | in-memory set                                              | `request.opened` / `request.decided`; `model.attempt` is the `started` mark                                     |
| tool-use   | queued and drained follow-ups                                                          | in-memory array + local                                    | `followup.queued { deliveryId }` / `followup.consumed`; the run's `Queue` is seeded from these on layer build   |
| tool-use   | usage of the current turn                                                              | accumulator, at cycle end                                  | `model.turn.usage`                                                                                              |
| tool-use   | `shouldSkipCycle`, `lastError`, `userCancelledRetry`, `structured`                     | blob                                                       | `flow.step` phase (`turn.ready` vs `waiting`), `run.end { outcome, error }`, `tool.result` of `submit_output`   |
| reflection | `currentRound`, `totalRounds`, `roundOutputs`, `continueRounds`, `endTurn`             | blob at node end                                           | `round.begin { round, total }` / `round.end { round, outcome, outputs }`                                        |
| reflection | partial generation of the current round                                                | the raw output file                                        | `output.pending { round, continuation, file, byteOffset, digest }` referencing the file as an artifact          |
| reflection | `compileFailureContext`, `unresolvedCompileRejection`                                  | blob                                                       | `round.end.compile { verdict, feedback }`                                                                       |
| workflow   | script, args, files, journal                                                           | KV `workflow-script-<hash>` (whole-file rewrite per entry) | `run.start.script` + `child.launched { key, attempt, runId }` / `child.result { key, attempt, outcome }` (§6.5) |
| workflow   | display state, skip/retry control plane                                                | `execution.workflow` snapshot + in-memory map              | folded from `child.*` and `request.decided { action: skip \| retry, key }`                                      |
| subagent   | attempt sequence, attempt phase, result manifest, `lastCompletedTurn`                  | four KV rows                                               | `child.launched { attempt, runId }` + the child's own `run.end` / `model.turn` rows                             |
| subagent   | parent delivery of a turn                                                              | in-memory pending slot                                     | `followup.queued` on the parent, in the child's terminal batch                                                  |

Every "not durable" line of the survey becomes a row; nothing is restored from memory, a
file, or a process-local registry. The five KV families (`flow_`, `workflow-script-`,
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
restores every open `request.*` through `Requests.restore`, builds the run layer (which
seeds `FollowUps` from the fold), and starts the same unfold. The step function switches
on `s.phase` and the unsettled rows the fold reports.

| Folded evidence                                                           | Action                                                                                                                                                                                          | Closes           |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `turn.ready`, no `model.attempt` for this turn                            | invoke the model (nothing external was admitted)                                                                                                                                                | C1               |
| `model.attempt` without `model.turn`                                      | outcome unknown: the provider may have accepted or charged; `Requests.open({ kind: 'retry' })` decides a new attempt; never resubmit implicitly                                                 | C1, contract 0.1 |
| `background.accepted` without a result                                    | observe the remote operation with the saved handle and deadline; never resubmit                                                                                                                 | contract 0.1     |
| `model.turn` present, calls unsettled, no `tool.intent` for a call        | dispatch it if parallel-safe **and** recorded parallel-safe (§6.7); otherwise synthesize `CANCELLED_CALL_ERROR`                                                                                 | C1               |
| `tool.intent` without `tool.result`                                       | outcome unknown: `Requests.open({ kind: 'tool-outcome' })` asks re-run or skip; never re-run blindly                                                                                            | C1               |
| all calls settled (incl. duplicates and skips), no paired `model.message` | build the paired follow-up messages from the settlement rows                                                                                                                                    | C1               |
| `request.opened` without `request.decided`                                | re-park on a fresh `Deferred` under the same `requestId`; a late decision for a run not parked is a follow-up                                                                                   | C4               |
| `followup.queued` without `followup.consumed`                             | it is in the seeded queue; `wait`/`drain` see it                                                                                                                                                | C3               |
| `model.turn` with a `continuation` whose covered prefix equals history    | reuse the anchor (no full resend); otherwise the package refuses the anchor and the invoker sends full history                                                                                  | C6               |
| `child.launched` without `child.result`                                   | consult the child's own aggregate: `run.end` present → adopt its result row; live claim held → attach and await; neither → a new `child.launched` with `attempt + 1` and a new physical `runId` | C7, C9           |
| `output.pending` without `round.end`                                      | reconcile the file against the recorded `byteOffset`/`digest`: complete a matching partial write, skip a complete one, surface a conflict; never append twice                                   | C15              |
| `round.end` with `compile.verdict = rejected` and no next `round.begin`   | the next round's prepare reads the verdict as feedback                                                                                                                                          |                  |
| `run.end` present                                                         | not resumable; `LaunchRefused.finished` (keeps #11313 semantics; a workflow retry is a **new** physical run, §6.5)                                                                              | C13              |
| claim held by a live owner (C5 + pid liveness)                            | `LaunchRefused.ownedElsewhere`; no lease file to go stale                                                                                                                                       | C14              |

Model-retry recovery keeps the proposal §2.3 permit rule: a `request.decided { retry }`
without a following `model.attempt` may be consumed once; a `model.attempt` without a
`model.turn` needs a new decision.

### 6.4 Persistence granularity is the design

The reason today's resume loses work is not the file format; it is that the commit
boundary is the node. The activity/append pairs of §5.2 to §5.4 put the boundary at every
external effect: one `model.attempt` before every provider call, one batch per committed
response, one `tool.intent` before every barrier call, one settlement batch per dispatch
segment in call order, one batch per consumed follow-up batch, one batch per round end.
`flow.snapshot` is written once per turn or round as a base point, so `load` reads one
snapshot plus a short tail, and the O(n²) rewrites of both the flow blob and the workflow
checkpoint go away. Append-only does not mean unbounded resident memory: the fold keeps
message history by reference to `model.*` rows, and the invoker reads the referenced rows
when it prepares a turn.

### 6.5 Coordination with `delegate_multi_agents` (workflow mode)

A workflow-script run is an ordinary run whose activities are child launches. What the
survey found must be preserved is preserved; what it found duplicated collapses.

| Concern                       | Today                                                                                                                                         | Design                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and collision        | deterministic `deriveExecutionId({ checkpointId })`; relaunch while live → "already running" success-shaped result                            | same deterministic `RunId` for the workflow run; `Runs.launch` returns `LaunchRefused.alreadyRunning { id }` and the tool renders the same message                                                                                                                                                                   |
| Script re-execution           | resume re-runs the script from the top; a changed script keeps the prior journal                                                              | same: the script is deterministic over `agent()`; `run.start.script` records it; a resumed run re-executes with the prior child rows as the cache                                                                                                                                                                    |
| Which calls short-circuit     | journal hit on the content key `journalKey(prompt, options, depFingerprint)`                                                                  | the fold's `children` map keyed by the same content key; `agent()` asks the fold first, then `Runs.launch`; a hit is `CACHED` in the view. Never a call ordinal (§7.10)                                                                                                                                              |
| Physical identity per attempt | `stableAttemptExecutionId(logicalId, attempt)`: attempt 0 is the logical id, later attempts derive from it                                    | kept exactly: the content key is the logical identity, `child.launched { key, attempt, runId }` records a **distinct physical `RunId` per attempt**, so a retry after a failed child never collides with that child's `run.end`                                                                                      |
| In-flight child at crash      | not journaled → re-run, unless the stable-attempt marker says `committed` with a manifest; ambiguous → fail closed                            | `child.launched` without `child.result` → §6.3's child row: adopt if the child's aggregate ended, await if live, else a new attempt; `stableSubagentAttempt.ts` (541) and the four KV rows delete because the child's own `run.end` is the attestation                                                               |
| Failed or skipped calls       | never journaled; resume re-runs them (by design)                                                                                              | preserved: `child.result { outcome: failed \| skipped }` is written for the view but the cache lookup ignores it, so resume re-runs exactly as today, under a new attempt id                                                                                                                                         |
| `parallel()`                  | realm-side `Promise.all` over thunks, cap 512; host side one `PQueue` plus the child loop's own budget                                        | realm-side unchanged (realm isolation); host side keeps **two bounds with two meanings**: the session's detached-turn budget (`Semaphore`, acquired around a detached child's turn only, so an in-band child inherits its parent's slot and cannot deadlock a limit of one) and the script's own fan-out `Semaphore` |
| Concurrency, cancel, timeout  | `PQueue`, per-call `AbortController` cascading from a run-level one, `pTimeout` at teardown, a first-fault ledger                             | `Semaphore.withPermits`, fiber interruption through the run scope (the sandbox bridge is a `FiberSet`, §3.4), `Effect.timeout` at scope close, `Cause` keeps the first fault                                                                                                                                         |
| `skip()` / `retry()` control  | in-memory map keyed by live child id, driven by `workflow.control` requests                                                                   | `request.decided { action: skip \| retry, key }` rows on the workflow run; the fold marks the call, the step function interrupts or relaunches; survives a crash                                                                                                                                                     |
| Budget (`maxAgentCalls`)      | in-memory counter charged on physical launch after queue admission                                                                            | folded from `child.launched` rows (cached hits are free, as today)                                                                                                                                                                                                                                                   |
| What the user sees            | `WorkflowExecutionSnapshot` published as `execution.workflow` events, re-seeded from meta on resume; one `WORKFLOW_CALL_STATUS` enum (#12249) | the same board folded from `child.*` and `request.*` rows of the workflow run; no separate snapshot, no re-seeding                                                                                                                                                                                                   |
| Parent delivery               | child result persisted, then turn-state, then a follow-up enqueued (C7)                                                                       | the child's `run.end` and the parent's `followup.queued` are one batch across two aggregates, appended by `Runs` in the child's terminal transaction; the child's `Deferred` completes after the commit                                                                                                              |

The script sandbox, its determinism requirement, and the content-addressed key are the
product; everything around them was generic Promise runtime, and Effect owns it now.

### 6.6 The fifteen crash windows, closed

| #   | Window today                                        | Closed by                                                                           |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| C1  | whole tool-use turn is one step                     | per-activity rows (§6.4), `model.attempt` before I/O                                |
| C2  | in-memory record cache invisible to other readers   | no cache; `load` reads rows                                                         |
| C3  | drained follow-ups held in a local                  | `followup.consumed` in the same transaction as the messages; queue seeded from rows |
| C4  | approvals in an in-memory set                       | `request.*` rows + `Requests.restore`; waiter registered before the row             |
| C5  | usage recorded at cycle end                         | `model.turn.usage`                                                                  |
| C6  | continuation anchor lost on resume                  | `model.turn.continuation`                                                           |
| C7  | child result persisted before parent delivery       | one batch across the two aggregates, in the child's terminal transaction            |
| C8  | best-effort turn-state write swallowed              | the row is the attestation; there is no turn-state                                  |
| C9  | committed marker lost → irreconcilable              | the child's `run.end` is the marker                                                 |
| C10 | journal ahead of the display snapshot               | one row feeds both the cache and the view                                           |
| C11 | whole-checkpoint rewrite per entry                  | append-only rows                                                                    |
| C12 | skipped/failed calls re-run on resume               | preserved by design (§6.5), now visible in the view, under a new attempt id         |
| C13 | un-rewound cursor makes a completed run unresumable | no cursor; `run.end` decides; retries get new physical ids                          |
| C14 | stale lease file blocks resume                      | the lease is deleted; `owner_id` + pid liveness only                                |
| C15 | partial output file can double-append               | `output.pending.byteOffset`/`digest` reconciliation                                 |

### 6.7 Re-execution replay and the two-permission rule

The third replay stays: `runLayer` with `ModelInvoker.layerReplay(ledger)` and
`Tools.layerReplay(ledger)` re-runs the unchanged loop against committed `model.turn` and
`tool.result` rows, failing with `ReplayDiverged` on a request the ledger cannot answer.
It is what makes loop tests deterministic and lets a real run become a fixture. Two rules
from the peer surveys make it and resume sound: tool re-execution needs the recorded
**and** the current `parallelSafe` (Pi), and deltas are live-only with the committed
response as the replayable boundary (OpenCode V2).

## 7. Surface map

Each row: what exists, what it becomes, what deletes (measured by the surface's survey
and re-measured on `047c88cf6e`; estimates marked ≈), and the boundary it lands on.

| #    | Surface                                             | Effect-native form                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Deletes                                                                                                                                                                                                                                                                                                                       | Boundary                        |
| ---- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 7.1  | Flow engine `src/agent/node/`                       | deleted; two loops in `src/agent/runtime/loop/`; `RunLedger.append` is the only write                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 675 LoC                                                                                                                                                                                                                                                                                                                       | none                            |
| 7.2  | Tool-use family (9 files, ≈2,700 LoC)               | `runToolUse` + `runTurn` (§5.2); round state is generator locals; a waiting run parks inside the turn (§2)                                                                                                                                                                                                                                                                                                                                                                                                                                | the node classes; bodies move                                                                                                                                                                                                                                                                                                 | none                            |
| 7.3  | Reflection family (11 files + `output/`)            | `runReflection` with `Effect.scoped` + `acquireRelease(openStage)` per round; output helpers behind `OutputPipeline`                                                                                                                                                                                                                                                                                                                                                                                                                      | the five-node fan-in, `RoundPersistedFlow` (270), `ResponseCycleFlow` (633)                                                                                                                                                                                                                                                   | none                            |
| 7.4  | Model layer                                         | `ModelInvoker` (§5.4) over `packages/llm`; `ModelRoutes` at the session; `Ref<Selected>` + `Scope.fork` on `Run`                                                                                                                                                                                                                                                                                                                                                                                                                          | ≈11,000 LoC deleted, ≈2,700 relocated, ≈950 blocked on the four package gaps                                                                                                                                                                                                                                                  | foreign edge in `packages/llm`  |
| 7.5  | Tool runner + tools                                 | `dispatch` (§5.3); `execute(): Effect`; `ToolCall` three fields; registry process-scoped, overlay per run                                                                                                                                                                                                                                                                                                                                                                                                                                 | ≈420 LoC of prelude/ports/imports, `ToolFileInteractionContext.ts` 72, `ToolUseDispatchNode.ts` 609, ≈200 of `runApprovalQueue.ts`, ≈120 across five approval entry points: **≈1,420**                                                                                                                                        | none (kind (b) retired)         |
| 7.6  | Approvals, retry, ask_user, inquiry                 | `Requests` (§5.5); every decision a `decision.*` `RuntimeRequest` arm; `approvalDecision.ts` (#12215) is the decision vocabulary                                                                                                                                                                                                                                                                                                                                                                                                          | the host-method route: ≈450 of `HostInteractions.ts`, `ToolEditApprovalController`'s pending map, CLI `park()` stubs (≈150 of `subscribeApprovals.ts`, now 714); host-specific preview code (`desktopToolEditApproval.ts` 120, `VscodeToolEditApprovalHost.ts` 196, `approvalAdapter.ts` 299) stays as UI                     | host command enters at kind (a) |
| 7.7  | Trace, publication, view                            | `TraceEmitter` stays synchronous (the [findings][findings] §3 price a `PubSub` hub at ≥27 files for one gained property); stage stack → `Run.stage` reference; publication = `RunLedger.append`, one shape, awaited; one fold per question; redaction at the durable boundary only                                                                                                                                                                                                                                                        | `StreamLogStore` 294, `RunSnapshotStore` 294, `runMetaFromEvents` + callers ≈80, stage-scope machinery ≈70, publication bookkeeping ≈60, two of three redaction sites: **≈800**                                                                                                                                               | none                            |
| 7.8  | Follow-ups                                          | `FollowUps` (§4 row 13): `followup.queued`/`followup.consumed` ledger rows (dedup by `deliveryId` unique key, crash-safe), one `Queue.unbounded` per run seeded from the fold, `Runs.handle(id)` as the only liveness predicate; goal continuation is an ordinary producer; `view.queuedFollowUps` folds from the rows                                                                                                                                                                                                                    | ≈700 LoC replaced by ≈80                                                                                                                                                                                                                                                                                                      | none                            |
| 7.9  | Native delegation, `childRunLoop`, workflow scripts | one `Runs.launch(spec)` with `mode: 'inband' \| 'detached'` (the difference is four flags today); `Deferred<ChildResult>` completed after the child's terminal batch replaces `onTurnSettled` + pending-delivery slots; two `Semaphore`s with distinct meanings replace `PQueue` + `childRunBudget` (§6.5); `Effect.timeout` at scope close replaces `pTimeout`; `Cause` replaces the first-fault ledger; the agent-CLI/bash `childRun.ts` variant stays a distinct spec, not a flag                                                      | `persistence.ts` 276, `checkpointKey.ts` 43, `stableSubagentAttempt.ts` 541, `childRunBudget.ts` 74, `detachedChildRun.ts` 191: **≈1,125 deleted** (`childRunDelivery.ts` already gone, #12240); `childRunLoop.ts` 1,214 → ≈450, `inBandSubagentRun.ts` 524 → ≈150, `runWorkflowScript.ts` 1,021 → ≈600: **≈1,560 collapsed** | none                            |
| 7.10 | Workflow-script checkpoints                         | ordinary child result rows keyed by the **content-addressed** journal key with a physical `RunId` per attempt (a call ordinal would re-execute every call after an inserted sibling); the journal becomes the fold's `children` map (§6.5); the sandbox, `parallel()`'s realm-side `Promise.all`, the failure asymmetry, `maxAgentCalls`, dependency-identity refresh and the skip/retry control plane are preserved                                                                                                                      | the four-way duplication per `agent()` call; the KV `turn-state` row and its ordering semaphore ≈110                                                                                                                                                                                                                          | none                            |
| 7.11 | Session tier                                        | `SessionHandle` becomes a thin record `{ id, roots, events, ledger, runs, view }` (≈120 LoC) plus the approval-policy value; `Runs` owns liveness and admission; `RunStatusService`'s map deletes because `foldRunState` is the reader; `finalizeFailedRun`'s classification survives as a pure `Exit → TerminalRow`; the lease deletes whole                                                                                                                                                                                             | `runRegistry` 896, `runLanes` 247, `waitingTermination` 215, `runInteractionOwnership` 195, `RunHandle.ts` 351, `runLease.ts` 633, ≈700 of `AgentRunLifecycle` (839), ≈650 of `SessionHandle` (953), ≈250 of `RunStatusService` (322), ≈120 of `AgentLaunchContext` (646): **≈4,500** against ≈600 new                        | none                            |
| 7.12 | Hosts (CLI, extension, desktop)                     | each root builds one `Layer`, holds its `ManagedRuntime` in a local, runs one program per host entry with `runtime.runPromiseExit(program, { signal })`; the runtime-touching `HostRequest` arms (`resume`, `runNew`, `runCompileFixer`, `exportTranscript`, `useOwnApiKey`, `toolEdit`, …) move to `RuntimeRequest` and are answered by `SessionRequests` for all three hosts; the CLI joins `SessionBridge` with an in-process port so `frameSubscription` is the one fold-to-UI path; the webview keeps its own fold runtime by design | ≈250 LoC each from `extensionHostRequests.ts` (840) and `desktopHostRequests.ts` (771), most of `hostRunActions.ts` (443), the CLI's duplicate slash-command handlers, two of three CLI view adapters (≈700), the second `LifecycleHost` per extension activation, the `session.runPromise` field name collision              | kind (a)                        |
| 7.13 | SDK `packages/agent`                                | `Sessions` = `open`/`close`/`list` over `WorkspaceRoots`; `Run` = `Runs.launch` + `observe` (§3.4, history then tail with a cursor); `Requests.layerDenyAll` for headless; `admitTools`/`admitInput` stay as package policy; shape of the Promise root unchanged                                                                                                                                                                                                                                                                          | `TRACE_HANDOVER_EVENTS` buffer, `admitted` deferred + sentinel, the `uninterruptibleMask`/`spawned`/`interruptLaunch` dance, the private subscription drain, `HEADLESS_HOST`: ≈160 of `sessions.ts`'s 533                                                                                                                     | kind (c)                        |
| 7.14 | Tests                                               | the 13 engine tests pinned to the record format delete with it; the six behavior suites move to `it.effect` over the real `RunLedger` layer (52 kernel suites already moved, #12214), `TestClock` for retry and cooling, `layerReplay` fixtures from real runs; a slice-3 suite that `vi.mock`s a repo module drops to the slow tier under the `pure-tier-kernel-suites` ratchet (AGENTS.md "Test tiers")                                                                                                                                 | none                                                                                                                                                                                                                                                                                                                          | none                            |

Across the surveys the deletion pattern is the same: a durable fact exists, and a second
in-memory structure holds the same fact because the durable one had no typed, awaitable,
per-run reader. `RunLedger`, `Runs` and `SessionEvents.aggregate` remove the reason for
all of them.

## 8. Effect version and API verification

Pinned since #12257: `effect`, `@effect/vitest`, `@effect/platform-node` and
`@effect/sql-sqlite-node` at `4.0.0-rc.113`, vitest 5, `@effect/platform-node-shared`
held to rc.113 by a workspace override. `effect@4.0.0-rc.114` has a GitHub release
(patch-only) but no npm package at the time of writing; the family moves when it lands.
rc.113 changed two things this design touched: `Effect.try`/`tryPromise` callbacks are no
longer contextually typed from the surrounding annotation (annotate them), and the
standard Node child-process spawner now waits for process groups on scoped release
(#8018), which makes the repo-side `nodeChildProcessSpawner.ts` (304 LoC, one consumer)
a deletion candidate.

The local `effect-solutions` reference clone (`~/.local/share/effect-solutions/effect`,
2026-07-14) is at `4.0.0-beta.98`, **older** than the pin. The names its guides show were
renamed before rc.108: `Schema.TaggedErrorClass` → `Schema.TaggedError`,
`Schema.ErrorClass` → `Schema.Error`, `Schedule.andThen` → `Schedule.concat`.
`Effect.Service`, `Schedule.both`, `Schedule.while`, `Effect.catchAll` and
`Layer.scoped` exist in neither. Refresh the clone before consulting it for code.
Everything below was checked in the rc.113 `dist/*.d.ts`.

| Design use           | rc.113 API (verified)                                                                                                                                                                          | Note                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Service tags         | `Context.Service<Self, Shape>()(id)`; `Context.Reference(key, { defaultValue })`; `Context.ServiceClass`                                                                                       | `Effect.Service` does not exist; there is no `FiberRef` module                                                                 |
| Layers               | `Layer.effect(Tag)(effect)` with `Exclude<R, Scope>` (scoped acquisition), `succeed`, `provide`, `provideMerge`, `mergeAll`, `fresh`, `launch`; `LayerMap`                                     | **`Layer.scoped` does not exist**; revision 3 listed it as verified in error                                                   |
| Runtime              | `ManagedRuntime.make`; `runPromiseExit(effect, { signal })` (`RunOptions.signal`); `runFork`                                                                                                   | none                                                                                                                           |
| Forking              | `Effect.forkChild`, `forkScoped`, `forkIn(scope)`, `forkDetach`; `FiberMap.run/make/join`, `FiberSet.makeRuntimePromise` (`propagateInterruption`)                                             | `forkDaemon` is gone; `forkDetach` is the global-scope fork                                                                    |
| Interruption         | `Effect.uninterruptibleMask`, `interruptibleMask`, `onInterrupt`, `onExit`, `ensuring`, `exit`, `interrupt`; `Exit.hasInterrupts`; `Fiber.interrupt`                                           | none                                                                                                                           |
| Foreign cancellation | `Effect.tryPromise({ try: (signal) => …, catch })`, `Effect.promise((signal) => …)`, `Effect.abortSignal: Effect<AbortSignal, never, Scope>`                                                   | none                                                                                                                           |
| Retry                | `Effect.retry({ while?, until?, times?, schedule? })` (all four combinable), `Effect.retryOrElse`                                                                                              | the v3 predicate combinators are gone; `Schedule.recurs(n)` is a constructor, not a pipeable (use `times`, or `Schedule.upTo`) |
| Schedules            | `Schedule.spaced`, `recurs`, `exponential`, `jittered`, `during`, `upTo`, `max([...])`, `min([...])`, `concat`, `addDelay`, `modifyDelay`, `passthrough`, `tap`                                | `Schedule.both`/`while`/`andThen` absent                                                                                       |
| Timeouts             | `Effect.timeout`, `timeoutOption`, `timeoutOrElse`                                                                                                                                             | none                                                                                                                           |
| Concurrency          | `Effect.forEach(xs, f, { concurrency, discard })`; `Semaphore.make/withPermits`; `PartitionedSemaphore`; `Latch.make/whenOpen/open/close`, `Latch.isOpen: boolean`                             | `Effect.makeSemaphore` is not the v4 name; `Latch.isOpen` is synchronous                                                       |
| Coordination         | `Deferred.make/await/succeed/fail/interrupt`; `Queue.unbounded/bounded/offer/take/poll: Effect<Option<A>>/takeBetween/end`; `PubSub.*`; `SubscriptionRef`                                      | `Queue.take` fails with the end signal when the queue is ended; model "no more input" as `Option`                              |
| Streams              | `Stream.unfold(s, step: S => Effect<[A, S] \| undefined>)`, `scan`, `concat`, `unwrap`, `fromAsyncIterable`, `callback`, `tap`, `filter`, `runLast`, `toAsyncIterable`, `catchDefect` (rc.113) | none                                                                                                                           |
| Errors               | `Data.TaggedError(tag)<Fields>` (yieldable); `Effect.catch`, `catchTag`, `catchTags`, `catchCause`, `catchDefect`; `Either`, `Cause.squash/pretty`                                             | `Schema.TaggedError`/`Schema.Error` exist but §15 decision 8 keeps Zod; `Effect.catchAll` does not exist                       |
| Tracing              | `Effect.fn(name)(gen, ...pipeables)`, `Effect.withSpan`, `Effect.annotateLogs`                                                                                                                 | none                                                                                                                           |
| Resources            | `Effect.acquireRelease`, `acquireUseRelease`, `addFinalizer`, `Effect.scoped`; `Scope.make/close/fork`                                                                                         | none                                                                                                                           |
| Testing              | `@effect/vitest` `it.effect` / `it.live` / `it.layer`; `TestClock.adjust` from `effect/testing`                                                                                                | vitest 5 since #12257                                                                                                          |
| Not adopted          | `effect/unstable/workflow`, `effect/unstable/ai`, `effect/unstable/eventlog`                                                                                                                   | present at the pin; rejected per PRD §13.C, the [findings][findings] §4, and §5.4                                              |

## 9. Where the corpus disagrees, and the reading taken

Recommended options are taken and stated, per the owner's 2026-09-10 rule.

1. **One `run` aggregate, one word.** Banked by #12222 and #12246; no longer a reading.
2. **The per-run service is `Run`**, and the session service is `Runs`; the design's
   `RunHandle` value replaces the `RunHandle.ts` class of the same name, and `RunLedger`
   plus the fold replace `RunStatusService`.
3. **`flow.snapshot` stays** as C10's one sanctioned derived row, carrying only what rows
   already carry; the reflection state PR1 §2.6 could not fit becomes rows.
4. **`RunContext` ALS retires with the loops**; `workspaceRoots` waits for the filesystem
   ruling (injection §6 steps 6 and 10).
5. **Injection Q1 — RULED twice.** Revision 4 recommended adopting Effect's `FileSystem` +
   `Path`. On 2026-09-11 the owner declined it for now (#12247; measured 7.1–9.7× slower
   `readDirectory`, no `lstat`, no working core layer — [injection note][injection] §9). On
   2026-09-13 the owner ruled for candidate B after all (#12073 R-1): `Platform` shrinks
   onto the Effect-native services — #12364, #12372, #12373, #12374 landed; slices 4b
   onward convert the filesystem consumers, the fs port last. Carrier 5 (`workspaceRoots`)
   and the `inScope` re-entry on `AgentRun`/`ToolCall` retire with those slices, keeping
   thin TeXRA helpers wherever `lstat` type bits or typed directory walks are load-bearing.
6. **Injection Q2:** the three provision points in §3.1 are the topology.
7. **Injection Q3:** `ModelInvoker`, `FollowUps`, `OutputPipeline` sit outside `Run` at
   run lifetime; `ToolCall` at call lifetime; `ToolRegistry` at process lifetime;
   `ModelRoutes` at session lifetime.
8. **Injection Q4:** the dispatcher retires R1 kind (b).
9. **The file lease is deleted at the KV cutover**, not kept as a fence (ownership note
   F2 read to its conclusion; revision 3 had it backwards). The database claim is the
   only write authority.
10. **`Runs` and `Requests` are one implementation with two tags**: a run is either
    executing or parked, and `interrupt` must handle both states with one code path.
    Streamless requests carry `Option<RunId>`.
11. **`SessionView` is a manifest row**: it already exists as a tag and is the only
    consumer of the view fold.
12. **`waiting` is a phase, not an outcome** (one-run-model §3.3; the review's reading).
13. **`p-queue`** is forbidden by AGENTS.md (the bullet is now at line 825); every
    remaining importer is in the deletion set or becomes a `Semaphore`.

## 10. Delivery: three slices, one atomic cut, four package gaps first

The [delivery plan][plan] §7 packages and the [injection note][injection] §6 steps order
the work. The one-run-model S1 (identity) has landed, so nothing gates `RunLedger`'s
aggregate arm.

**Amendment, 2026-09-13 (what landed).** Slice 3 was written as one atomic cut and slice 2
as "cannot land alone". In practice the cut landed as five reviewed merges on `main` —
#12287 (PR1, ledger foundation), #12314 (both loops, PocketFlow deleted), #12320 (L3, the
model-handler hierarchy retired onto the llm `Model`), #12329 (PR3+PR4, one request
protocol, the phase as a fold, one child protocol; its squash carries the post-cutover sweep
#12338 and review rounds 6–7) — and slice 2 landed **last and alone** as #12337 (54 tool
executors return Effects, `ToolCall` service, `ToolFileInteractionContext` deleted), which the
ratchet admitted because the dispatcher already carried the run site. Not landed from the
slice tables: `Runs`/`Requests` as tags (§7.11's ≈4,500 LoC session tier: `runRegistry.ts`,
`RunHandle.ts`, `runLanes.ts`, `waitingTermination.ts`, `runApprovalQueue.ts` survive),
`followup.*` rows + the seeded `Queue` (§7.8; `FollowUpQueue.ts` still imports `p-defer`),
the SDK on session services (§7.13), and **the file lease** — `runLease.ts` survived the
KV cutover it was pinned to (§9 item 9; lease note D1), so its deletion is now its own
item under #12082. `ModelRetryGate` remains the automatic retry owner inside
`ModelInvoker` (AGENTS.md "Run loop architecture") pending its Effect rewrite.

| Slice | Content                                                                                                                                                                                                                                                                                                                                                                                                                              | Deletes (symbols that cease to exist)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Rows                                                                                                                                                                                  | Alone?                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 0     | **Package gaps.** `packages/llm` gains hosted-tool definitions, an explicit upload operation, a `vscode-lm` factory, `retryAfterMs` on `ModelError`. (The rc.113 move is done, #12257; rc.114 follows when npm has it.)                                                                                                                                                                                                              | nothing yet; unblocks ≈950 LoC of slice 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | none                                                                                                                                                                                  | yes                             |
| 1     | **Run layer, `Runs`, `Requests`, `SessionView` row.** `Layer.effect(Run)(acquireRun)` inside `runAgent`; flip the `runner` seam at `AgentRunLifecycle.ts:458` to `Effect`; `Runs` as `FiberMap` over the existing admission rules; `Requests` over today's `approval.*` rows with one decision route; the runtime-touching `HostRequest` arms move to `RuntimeRequest`                                                               | `RunContext` ALS, `RunScope`, both `AsyncLocalStorage.bind` sites in `executeAgent.ts`, `HostInteractions.pending` and the six request methods, `runApprovalQueue.enqueue`, `runLanes.ts`, `waitingTermination.ts`, `runInteractionOwnership.ts`, the run `AbortController`, `forkDetach` at `AgentRunLifecycle.ts:520`, `hostRunActions.ts`                                                                                                                                                                                                                                                                                                  | `new AbortController(` −3, `p-defer` 3 → 0 (row deleted), below-boundary `Effect.run*` −2, `async-mutex` → 0                                                                          | yes (injection steps 6, part 7) |
| 2     | **Tool boundary.** `execute(): Effect`; `ToolCall` three fields; `ToolRegistry` process tag; 54 tools drop prelude and `runPromise`; bash's process-group release written explicitly                                                                                                                                                                                                                                                 | `ToolFileInteractionContext` ALS, 14 `bind` sites, 62 `effectRuntime()` sites in `src/tools`, 7 `Ports` interfaces, `ITool.call(): Promise`, `SharedToolInjectionRegistry`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | the `src/tools/**/*Tool.ts` run allowance retires; the one new site in the dispatcher is a widening the ratchet refuses                                                               | **no**: lands inside slice 3    |
| 3     | **The atomic cut.** Engine + both loops + `dispatch` + `ModelInvoker` + `ModelRoutes` + `FollowUps` rows and seeded queue + `OutputPipeline` + one child launch op with per-attempt ids + checkpoints as child rows + `RunLedger`/`foldRunState` with the §6.1 row vocabulary (PR1 note, first on the branch) + `layerReplay` for invoker and tools + the CLI onto `SessionBridge` + SDK on the session services + the lease deleted | `src/agent/node/**`, the node and flow classes, `ModelInvocationNode.ts`, `ModelRetryGate.ts`, `ModelCell.ts`, `helperModel.ts`, `IModelHandler` + `modelHandlers/**`, `ToolUseSessionLifecycle.ts`, `FollowUpQueue.ts`, `ToolUseFollowUpQueueManager.ts`, `workflowScript/persistence.ts`, `checkpointKey.ts`, `stableSubagentAttempt.ts`, `childRunBudget.ts`, `detachedChildRun.ts`, `StreamLogStore.ts`, `RunSnapshotStore.ts`, `RunStatusService.ts`, `RunHandle.ts`, `runRegistry.ts`, `runLease.ts`, `provideAgentEngine`, the SDK handover buffer, `docs/architecture/2026-06-20-pocketflow-state.md`, AGENTS.md's PocketFlow section | `setServices()` → 0, `dep:@agent/node` → 0, `dep:@agent/modelHandlers` → 0, `p-retry` → 0, `p-map` → 0, `p-timeout` → 0, `p-queue` → ≈2, `catch:effect-importer` −4, `Effect.run*` −5 | no: one merge, stacked reviews  |

Slice 2 cannot land alone: converting `execute()` moves the run site from 54 tool files
to the one dispatcher file, which is below the boundary, and the ratchet refuses a file
newly entering the row. Its mechanical parts are reviewed first on the integration
branch and merge with slice 3.

Summed over the surveys and re-measured, slice 3 removes on the order of 19,500 LoC
(≈11,000 model, ≈4,500 session, ≈2,700 child dispatch, ≈1,400 tools, ≈800 trace and
view, ≈700 follow-ups, ≈675 engine) and relocates ≈3,000 (compaction, media, reflection
output bodies), against roughly 1,500 LoC of new services and loops. The numbers are
estimates; the PR that claims each row re-derives it.

Gates per slice are the [delivery plan][plan] §8 table. Slice 3 additionally runs the
six behavior suites the plan names, migrated to `it.effect` over the real `RunLedger`
layer, the proposal §2.3 crash-window cases behind a real process, and one replay fixture
per family recorded from a real run (§6.7).

## 11. Collapse ledger

Everything the surveys found duplicated, and the one thing it becomes. Rows marked
**banked** have landed on `main` (re-marked 2026-09-13 against #12337).

| Today                                                                                                  | Becomes                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StreamTabId` + `ExecutionId` + `RunId`, `execution*`/`stream*` names                                  | one branded `RunId`, one word (**banked**, #12222)                                                                                                                                                                                                 |
| four run-event vocabularies, two terminal facts                                                        | one `sessionEvent.ts` vocabulary, one `run.end` (**banked**, #12246)                                                                                                                                                                               |
| several tool-call and workflow-call status enums                                                       | `TOOL_CALL_STATUS`, `WORKFLOW_CALL_STATUS` (**banked**, #12249)                                                                                                                                                                                    |
| per-host approval decision shapes                                                                      | `approvalDecision.ts` (**banked**, #12215); `Requests` finishes the route                                                                                                                                                                          |
| six liveness authorities + the `liveSessions` set                                                      | `Runs` (`FiberMap` + C5 claim)                                                                                                                                                                                                                     |
| three pending-request registries (interactions set, controller map, view list) and two decision routes | `request.opened`/`request.decided` rows (**banked**, #12329); `Requests` tag open                                                                                                                                                                  |
| two command vocabularies (`RuntimeRequest` 13 arms, `HostRequest` 41) + CLI slash duplicates           | one `RuntimeRequest` for session operations                                                                                                                                                                                                        |
| four folds over the same rows                                                                          | two: the view fold and `foldRunState`                                                                                                                                                                                                              |
| seven publication entry methods, four fire-and-forget                                                  | `RunLedger.append`, awaited                                                                                                                                                                                                                        |
| three redaction sites                                                                                  | one, at the durable boundary                                                                                                                                                                                                                       |
| five KV families beside the event table                                                                | rows on the run aggregate (**banked**, #12329)                                                                                                                                                                                                     |
| two ownership authorities (lease file, `owner_id`)                                                     | `owner_id` (the lease deletes)                                                                                                                                                                                                                     |
| four durable records per workflow `agent()` call                                                       | landed as `child.turn` on the run aggregate plus `workflow.script`/`workflow.journal` on a `workflow-checkpoint` aggregate (#12329); the single `child.launched`/`child.result` pair this row proposed is **not** what shipped — design delta open |
| six child-launch entry paths, two primitives, in-band vs detached as four flags                        | `Runs.launch(spec)` with `mode`; `childRun.ts` as one spec variant                                                                                                                                                                                 |
| two concurrency limiters with entangled meanings on child launches                                     | two `Semaphore`s with distinct meanings; in-band inherits                                                                                                                                                                                          |
| three in-memory follow-up layers + a third resume channel                                              | `followup.*` rows + one seeded `Queue` per run                                                                                                                                                                                                     |
| five retry layers on one model call (SDK, batch, gate, manual, auxiliary)                              | `Effect.retry` + `ModelRoutes` + `Requests` (SDK stays at 0)                                                                                                                                                                                       |
| five `AsyncLocalStorage` carriers + 13 `bind` re-entry sites                                           | three services + one reference                                                                                                                                                                                                                     |
| 54 tool preludes, 7 `Ports` interfaces, 62 run sites in `src/tools`                                    | `execute(): Effect` (**banked**, #12337)                                                                                                                                                                                                           |
| three CLI view adapters + `getUnsafe` pokes on hosts                                                   | one `SessionBridge` frame stream                                                                                                                                                                                                                   |
| three `ManagedRuntime` owners reached through 398 `effectRuntime()` reads                              | one per host root, in a local; the webview's is a root too                                                                                                                                                                                         |
| two `LifecycleHost`s per extension activation                                                          | one                                                                                                                                                                                                                                                |
| the node graph, the cursor, the flow record, the round flow, the response-cycle fan-in                 | `Stream.unfold` over `turn` / `round` (**banked**, #12314)                                                                                                                                                                                         |

## 12. What this design refuses

- **A generic activity or step abstraction.** Two loops and one append do not justify an
  interpreter; the [findings][findings] §4 record what `unstable/workflow` would cost.
  Replay (§6) is a layer swap, not an engine.
- **A `PubSub` behind the trace.** One gained property against seven adapter-owned ones
  and ≥27 files ([findings][findings] §3).
- **Effect Schema anywhere in the runtime.** Zod owns every payload (§15 decision 8).
- **Any adapter, shim, flag, or dual engine.** R1's second ruling and R10's struck
  clause. Slice 3 is atomic for exactly this reason.
- **A tag per class or per `Platform` port.** R2 and the delivery plan's negative; twenty
  tags is the reviewed count.
- **A per-call tool timeout, a `pipeline()` sandbox helper, a call-ordinal checkpoint
  key, or a kept file lease.** None earns its place; each would be new behavior, a
  regression dressed as a port, or a second authority.

## 13. Verified

- `main` at `047c88cf6e` re-surveyed on 2026-09-11 (every cited path checked for
  existence, rename and LoC; the §1 counts re-measured), on top of the ten read-only
  passes of revisions 1 to 3 (runtime internals; Effect adoption; the design corpus; six
  deep surface passes; resume and replay end to end).
- Every API in §8 was checked by grep against the `effect@4.0.0-rc.113` `dist/*.d.ts`
  (the installed pin since #12257) and against the rc.114 tarball; `Layer.scoped`'s
  absence, `Schedule.recurs`'s constructor signature, `Latch.isOpen: boolean`,
  `Queue.poll: Effect<Option<A>>`, `Retry.Options` combining `while`/`times`/`schedule`,
  `Layer.effect`'s `Exclude<R, Scope>`, and `FiberSet.makeRuntimePromise` were read from
  the declarations.
- The 26 review threads on PR #12210 were each read and answered by a change in this
  revision or an explicit reading (§14).
- Peer designs are cited from the [loop study][loop] and its pinned sources, not
  re-derived.
- No production code, data format, or public API changed.

## 14. Revision 4 log: review threads to sections

| Finding (reviewer)                                                                                                                          | Taken?  | Where                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------- |
| `Semaphore.make` is not zero; two `ManagedRuntime.make`; `LayerMap.make` at :544                                                            | yes     | §1 row 1 (anchors re-measured to `:525`, `:769`)      |
| `runOne` can fail with `LedgerRefused`, so `forEach` fails fast                                                                             | yes     | §5.1, §5.3 (a lost claim must stop dispatch)          |
| `Schedule.recurs` is a constructor                                                                                                          | yes     | §5.4 (`Effect.retry({ while, times, schedule })`), §8 |
| `Latch.isOpen` is a boolean                                                                                                                 | yes     | §5.3, §8                                              |
| `Layer.scoped` does not exist                                                                                                               | yes     | §3.1, §8, §10                                         |
| `Requests.open`/`decide` error channels omit `LedgerRefused`                                                                                | yes     | §4 row 8                                              |
| `FollowUps` shapes vs `Queue.poll`/`take`                                                                                                   | yes     | §4 row 13, §5.2 (`Option<Batch>`)                     |
| snapshot built from pre-dispatch state                                                                                                      | yes     | §5.2 (`dispatch` returns `RunState`)                  |
| duplicate tracking across barriers                                                                                                          | yes     | §5.3 (segment-scoped, existing windows)               |
| request waiter registered after the row is visible                                                                                          | yes     | §5.5                                                  |
| route gate must be session-scoped                                                                                                           | already | §4 row 9 (revision 3)                                 |
| `waiting` as a returned outcome finalizes the run                                                                                           | yes     | §2, §3.4, §5.1, §5.2                                  |
| model attempt not recorded before provider I/O                                                                                              | yes     | §5.4, §6.1, §6.3                                      |
| interrupted barrier tool fabricates `cancelled`                                                                                             | yes     | §2, §5.3                                              |
| file lease should retire with the KV cutover                                                                                                | yes     | §2.1, §9 item 9, §10                                  |
| attachments captured after the `tool.result` row                                                                                            | yes     | §5.3 (`settle` before the row)                        |
| duplicate and skipped settlements not persisted                                                                                             | yes     | §5.3, §6.1                                            |
| follow-ups not rehydrated into the fresh queue                                                                                              | yes     | §3.1, §4 row 13, §6.3                                 |
| model not rebound after a manual retry selection                                                                                            | yes     | §5.4                                                  |
| detached child delivery outside the child's terminal transaction                                                                            | yes     | §2, §2.1, §6.5                                        |
| history-then-tail without a cursor                                                                                                          | yes     | §3.4, §4 row 4                                        |
| one semaphore breaks in-band slot inheritance                                                                                               | yes     | §6.5, §7.9, §11                                       |
| parallel settlements committed in completion order                                                                                          | yes     | §5.3 (call-order batch per segment)                   |
| retried workflow children need per-attempt run ids                                                                                          | yes     | §6.1, §6.3, §6.5                                      |
| in-band child not interrupted when its parent stops (rev 4 review)                                                                          | yes     | §2                                                    |
| `nextAttemptId()` evaluated once across automatic retries (rev 4 review)                                                                    | yes     | §5.4                                                  |
| ended follow-up queue leaves the unfold spinning on `waiting` (rev 4 review)                                                                | yes     | §5.2                                                  |
| `forkDetach`, `Semaphore.makeUnsafe` and `LayerMap.make` counts; merge-base anchors; the tag count; the `Stream.unfold` seed (rev 4 review) | yes     | §1, §2, §3.4, §7.11, §10                              |

## 15. Revision 5 log (2026-09-13): reconciliation against `main` at #12337

| Correction                                                                                                    | Where           |
| ------------------------------------------------------------------------------------------------------------- | --------------- |
| Q1 was ruled against adoption 23 minutes after revision 4's last commit; §9 item 5 said the opposite          | §9 item 5       |
| Slice 3 landed as five merges, slice 2 last and alone; the lease survived the KV cutover                      | §10 amendment   |
| Five more collapse rows are banked                                                                            | §11             |
| Row counts in §1 are stale by a factor (`platform()` 19/41, six rows deleted, pin rc.115); re-measure at HEAD | §1 (not edited) |

[prd]: ./2026-08-26-effect-4-runtime-migration.md
[runtime]: ../../implemented/architecture/2026-09-04-agent-runtime-on-effect.md
[substrate]: ./2026-09-03-persistence-substrate-decision.md
[plan]: ./2026-09-06-effect-runtime-delivery-plan.md
[injection]: ./2026-09-10-effect-native-injection-context-pipelines.md
[onerun]: ../../implemented/architecture/2026-09-10-one-run-model.md
[pr1]: ./2026-09-08-pr1-run-ledger-foundation.md
[findings]: ./2026-09-08-effect-4-interface-findings.md
[loop]: ./2026-09-06-agent-loop-architecture-study.md
[lease]: ./2026-09-10-execution-ownership-lane-and-lease.md
