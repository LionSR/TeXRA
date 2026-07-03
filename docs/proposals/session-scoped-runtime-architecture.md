# Session-scoped runtime architecture: facts, interactions, and status ownership

Status: proposal (2026-07-03). Companion to the diagnosis in
`tech-debt-audit-2026-07.md` (Part B1/B5 + appendix); this document is the
target design. It covers the event/logger chain, the approval/interaction RPC
machinery, stream status, and the execution registries — and how all of them
couple to the UI backends.

## 1. Diagnosis: one root cause, many symptoms

Every debt found in the deep dives reduces to the same defect: **run facts,
host interactions, and status live on process-global singletons while the UI
backends are per-window**, and the gap is bridged by per-run patches and
defensive guards instead of ownership.

The evidence, condensed (file:line references in the audit appendix):

**Genuine cross-session leaks (live bugs in multi-window desktop):**

- L1. `getDefaultStreamLogStore()` is process-global and last-writer-wins
  (`ProgressViewState.ts:153` calls `setDefaultStreamLogStore(this.streamLogs)`
  per window; `runTrace.ts:34` defaults to it). A run's transcript appends to
  whichever window's store was constructed last.
- L2. Desktop re-emits every progress event onto the shared process `bus`
  (`desktopAgentExecution.ts:811`) and every window's backend subscribes to
  that same bus (`:295`). Window A's run events mutate window B's
  `ProgressViewState` (ghost streams, badge churn).
- L3. `StreamStatusService` is one shared instance: every window's
  `ExecutionRegistry` subscribes to its global `onDidChange`
  (`executionRegistry.ts:161`), and one window's delete-all calls
  `StreamStatusService.clearAll` (`ProgressViewState.ts:344`), resetting every
  window's streams.

**Structural duplication held together by guards:**

- Three request/response mechanisms for the same job: (i) platform-port +
  host-local promise maps (toolEdit/bash), (ii) `BasePromiseCoordinator`
  show/resolve event pairs + `RunCoordinatorBridge` id index
  (plan/proposal/retry), (iii) `ApprovalRequestHandler.pending/delivered`
  backend replay registry — a third copy of pending state kept solely for
  webview-reload redisplay.
- The same fact emitted in two vocabularies: terminal outcome
  (`ResultEvent` at `AgentRunLifecycle.ts:83` vs `updateStreamStatus` +
  `terminalStatus` at `StreamStatusService.ts:76`); usage three ways
  (`UsageMonitor.ts:170` bus, `:182` trace, `ResultEvent.usage`).
- STOPPED written by two subsystems (registry stop path, lifecycle arms),
  coordinated only by STOPPED-wins guards; UI backends write status through an
  `emit:false` backdoor for restart repair (`ProgressEventHandler.ts:469,621`)
  because the design gives them no legitimate voice.
- The bus's 1000-event pre-subscription buffer exists only because the sink
  subscribes lazily to a process-global emitter; it is a symptom, not a
  feature.
- Session invariants enforced by comments, not types: the per-session
  subscription binder reads the process-static streamId-keyed
  `ToolUseFollowUpQueue` (`SessionHandle.ts:99-104`); `handles`
  (executionId-keyed) and `InterruptRegistry` (streamTabId-keyed) must be
  populated in tandem or a stream is discoverable but uninterruptible.

**What is already right (build on it, don't replace it):**

- `SessionHandle` is a real composition root (owns per-session
  interrupts/executions/coordinators/subscriptions) with the
  `defaultSession()` aliasing strategy proven by the 7d migration.
- The 12-variant `AgentEvent` trace is a clean one-way fact stream with
  per-run subscribers; `conversationProgressHub` proves the trace→bus
  projection pattern; `AgentExecutionHandle` already carries `trace`,
  `result`, `coordinators`.
- `runFlowWithLifecycle` + `RUN_OUTCOME_PROJECTION` is a working
  single-writer terminal transition.
- Emit discipline holds: zero raw `bus.emit` in VS Code-free zones.
- The logger is done: 308 lines, one sink boundary, two entry points that
  converge.

## 2. Target architecture: three planes, one owner each

The design keeps three fundamentally different kinds of traffic apart, gives
each exactly one owner, and scopes all three to the `SessionHandle`:

```
                        ┌──────────────────────────────────────────────┐
                        │              SessionHandle                   │
                        │  (one per VS Code window / CLI process /     │
                        │   desktop BrowserWindow — already exists)    │
                        │                                              │
  agent core            │  PLANE 1  session.events  (facts, one-way)  │      hosts
  (VS Code-free)        │  ───────────────────────────────────────►   │
                        │     · per-run AgentTrace auto-forwarded      │  projector per window
  flows / tools ──────► │     · session facts (goal, inquiry, …)      │  ► ProgressViewState
  lifecycle    ──────►  │     · status transitions (see plane 3)      │  ► StreamSnapshotStore
                        │                                              │  ► CLI renderer
                        │  PLANE 2  session.interactions (RPC, await) │  ► status bar, badges
  tools ─── await ────► │  ◄───────────────────────────────────────   │
                        │     · Promise-returning request methods      │  one implementation
                        │     · one pending registry (replayable)      │  per host
                        │     · resolve requires the session           │
                        │                                              │
                        │  PLANE 3  session.runs + session.status     │
                        │     · RunTable (handles, waiters, stop)      │
                        │     · StreamStatusMachine (single writer,    │
                        │       named causes, rules inside)            │
                        │     · session.followUps, session.transcripts │
                        └──────────────────────────────────────────────┘
```

Rules of the architecture (each replaces a family of today's guards):

1. **Facts flow one way.** Core emits onto plane 1; hosts subscribe;
   subscribers never mutate core state in response to a fact (commands go
   through planes 2/3 APIs).
2. **Requests are awaited calls, not event pairs.** Anything with a reply is a
   method on `session.interactions`. Events are never used as RPC.
3. **Status has one writer with named causes.** Every transition — lifecycle,
   user stop, restart repair, tab delete — is a call into the status machine
   that names its cause; the machine owns STOPPED-wins/preserve rules.
4. **Nothing run- or session-scoped lives on a process global.** Process-wide
   surfaces are limited to: the `Platform` ports, an explicit `liveSessions`
   list for cross-session aggregation, and true app signals (below).

### Plane 1 — `session.events`: one fact hub, session-scoped

A typed multicast hub constructed with the session (therefore before any run
— this deletes the bus buffer by construction, not by re-implementing it):

```ts
type SessionEvent =
  | { scope: 'run'; streamId: StreamTabId; event: AgentEvent } // forwarded traces
  | { scope: 'session'; event: SessionFact }; // non-run facts

interface SessionEventHub {
  emit(event: SessionEvent): void; // internal producers only
  subscribe(sub: (e: SessionEvent) => void): () => void;
}
```

- **Run facts** stay `AgentEvent` on the run's `TraceEmitter` — the SDK
  contract is unchanged. `SessionHandle.attachRunTrace` (which already
  forwards `result` to `onResult`) generalizes: it forwards the _whole_ trace
  into the hub, tagged with the streamId, attached inside
  `buildAgentLaunchContext` immediately after `createRunTrace` and **before**
  the first emit (today's hub attach happens after `setActiveStream`, which is
  why the buffer exists).
- **`AgentEvent` gains three arms** for facts that are genuinely run lifecycle
  but currently bus-only: `status` (emitted by plane 3's machine — subsumes
  `updateStreamStatus`, including non-terminal transitions and
  `terminalStatus`, ending the terminal dual-emit) and `child.activity`
  (subagent/process registration and progress — subsumes
  `updateActiveSubagents` / `updateActiveProcesses` / `setParentStream`,
  emitted by the session's RunTable which, being session-owned, emits into its
  own session's hub; no parent-trace lookup gymnastics). `updateProcessOutput`
  becomes a `process.output` arm carried on the owning run's trace via the
  per-process handle's parent stream.
- **`SessionFact`** is the new, previously missing surface for facts emitted
  outside any run: `goalStateChanged` from the Goal tab,
  `inquiryThreadUpdated` on async inquiry resume, `clearMissingOutputs` from
  the command palette, command-path `updateQueuedFollowUps`, host-driven
  `setActiveStream`. Today these fall through `emitRuntimeEvent` to the
  process bus; here they are first-class session facts.
- **Usage becomes single-emit**: `UsageMonitor` emits only the trace `usage`
  event; the sidebar totals are a projector concern. `ResultEvent.usage`
  remains as the run summary (that is aggregation, not duplication).
- **Log lines are unchanged**: `log` events on the trace, fanned to the
  channel sink and the transcript recorder. That is one fact with two
  subscribers — correct under rule 1, not duplication.

**Consumers.** Each window's `ProgressEventHandler` becomes a _projector_
subscribing to its own session's hub — same handler bodies, same
`ProgressViewState`/`WebviewUpdater` machinery, different (and correctly
scoped) feed. The CLI renderer, `StreamSnapshotStore`, the extension status
bar, and file decorations subscribe the same way. This directly fixes L2 and
L3's fan-out half. Deliberately **per-host** projectors: this preserves the
coupling audit's rejection of a single shared CLI/webview reducer
(`agent-runtime-ui-coupling-audit.md:76`) — hosts keep their own persistence,
race handling, and derived UI state; what they share is the correctly-scoped,
well-typed feed (and, per audit B2, an optional per-tool display-model layer
on top). The webview transcript-delta path
(`StreamLogStore.onChange → WebviewBridge`) stays as-is — it is already a
correctly-directed store-to-view channel; it just gains a correctly-scoped
store (below).

**What remains process-global**: a small `AppSignals` emitter for the 10
genuinely app-scoped events (`extensionDeactivating`, `toolAvailabilityChanged`,
`workspaceFilesWritten`, GitHub subscription churn, `githubTokenInvalid`).
These are about the process, not a session; naming them stops the bus from
being the junk drawer that made its taxonomy illegible.

`ProgressEventPayloads` and the bus survive during migration as a projection
target (extension byte-identical via `defaultSession()`), and are deleted at
the end — not redefined.

### Plane 2 — `session.interactions`: one interaction port

One session-scoped port subsumes all three RPC mechanisms:

```ts
interface HostInteractions {
  // One method per interaction kind; all return promises, all accept
  // { timeoutMs?, signal? }. Payload/decision types are the existing ones.
  requestToolEditApproval(
    req: ToolEditApprovalRequest,
    o?: ReqOpts,
  ): Promise<ToolEditApprovalResult>;
  requestBashApproval(
    req: BashApprovalRequest,
    o?: ReqOpts,
  ): Promise<BashApprovalResult>;
  requestPlanApproval(
    req: PlanApprovalRequest,
    o?: ReqOpts,
  ): Promise<PlanApprovalResult>;
  requestProposal(
    req: AgentProposalRequest,
    o?: ReqOpts,
  ): Promise<ProposalResult>;
  requestRetry(req: RetryRequest, o?: ReqOpts): Promise<RetryDecision>;
  askUserQuestion(
    req: UserQuestionRequest,
    o?: ReqOpts,
  ): Promise<UserQuestionResult>;
  openExternalInquiry(req: InquiryRequest): Promise<InquiryThreadHandle>; // durable, thread-shaped

  // The single pending registry (replaces coordinator maps + host promise
  // maps + ApprovalRequestHandler.pending/delivered):
  pending(): readonly PendingInteraction[]; // host re-display on reload
  resolve(requestId: string, result: unknown): boolean; // any surface, first-wins
  cancelForStream(streamId: StreamTabId, cause: 'stopped' | 'deleted'): void;
}
```

Design points, grounded in the RPC trace:

- **The show/resolve event pairs become an implementation detail** of the
  default webview-backed implementation (it may keep posting the same
  payloads to the same panels). They leave the public contract. The CLI
  implements the port directly on its modal queue — deleting the
  `installTuiApprovals` monkey-patch of `host.emit`, which is the clearest
  sign the current contract is wrong.
- **Tool-edit keeps its port shape** — the trace showed it is not a pure
  decision (the extension host opens a live diff editor, captures in-place
  user edits, treats tab-close as reject). That is precisely why the port
  belongs to the _host_: `requestToolEditApproval` returns the existing rich
  `ToolEditApprovalResult` (`appliedContent`/`userPatch`), and mid-flight
  actions (openDiff, preview, latexdiff) are internal to the host
  implementation, reachable from its own UI. The existing
  `ToolEditApprovalPort` + per-run handler override collapses into this —
  the port is per-session, so the per-run override patch (added for
  multi-window) becomes unnecessary.
- **Resolution requires the session.** Today proposals resolve through the
  process-global `runCoordinatorBridge` import and tool-edits through
  module-global maps — any surface, no session needed, which is exactly what
  makes multi-window fragile. `session.interactions.resolve(id, result)` is
  the only door; surfaces that today import the bridge get the session
  instead (they all have one in reach — desktop already does this).
- **One pending registry, replay built in.** `pending()` is the reload
  redisplay source (`replayPendingPrompts` reads it instead of a third copy);
  the first-wins `isSettled` semantics move inside. External inquiry stays
  thread-shaped and durable — it is the one interaction that is a
  conversation, not a decision, and the port returns a handle rather than
  pretending otherwise.
- **Serialization scope becomes per-session** (the `PQueue{concurrency:1}` in
  `streamApprovalQueue` is currently process-wide). One prompt at a time _per
  session_ is the behavior users actually want in multi-window; noted as a
  deliberate behavior change.
- `BasePromiseCoordinator`'s internals (pDefer + pTimeout + replace-pending +
  first-wins) are the right mechanics — they become the port's shared request
  bookkeeping instead of one of three competing systems.

### Plane 3 — `session.runs` + `session.status`: one table, one state machine

**`RunTable`** (the renamed `ExecutionRegistry` core, clusters A+C+D — which
the dissection showed are one cohesive object) keeps tracking, waiters, and
stop/kill. Changes:

- **The interrupt capability moves onto the handle.** `IInterruptible` is
  registered via `session.runs.get(streamId).attachInterrupt(cb)` (flows and
  background bash both already have the stream's handle in reach). One index;
  the discoverable-but-uninterruptible state and the untested two-map pairing
  invariant become unrepresentable. `InterruptRegistry` (34 lines) is
  deleted.
- **Follow-up routing closes its race.** `getToolUseFollowUpTarget` +
  `appendFollowUp` fuse into `session.runs.deliverFollowUp(streamId, item)`,
  which re-checks liveness and enqueues-or-appends in one synchronous tick —
  the decision-then-act window disappears rather than being guarded.
- **`session.followUps`** is a per-session instance of the follow-up queue —
  still streamId-keyed, because a queue must outlive runs to serve WAITING
  streams; that is a stream-level concept and stays one. The binder↔queue
  keying invariant becomes internal to one object instead of a cross-module
  comment. Same move for `session.transcripts` (per-session `StreamLogStore`;
  the `StreamSnapshotStore` sidecars stay a separate format per audit A6 and
  get the same session scoping): `createRunTrace` takes the store from the
  launching session, deleting `getDefaultStreamLogStore` and fixing L1.
- The two read-only methods (`requestManualCompaction`,
  follow-up-target queries where still needed externally) are exposed via
  narrow `Pick<>` interfaces, the pattern the repo already uses twice.

**`StreamStatusMachine`** replaces the shared `StreamStatusService` with a
session-owned machine whose API is transitions-with-causes, not a settable
map:

```ts
type TransitionCause =
  | 'lifecycle' // runFlowWithLifecycle: RUNNING, terminal projection
  | 'wait'
  | 'resume' // ToolUseWaitNode, resumeQueuedToolUse
  | 'user-stop' // RunTable stop path *requests*; machine writes
  | 'restart-repair' // host recovery: RUNNING→WAITING/ERROR after reload
  | 'admission' // tryAcquire / releaseIfInitializing (launch saga)
  | 'clear'; // tab delete / delete-all (this session only)

interface StreamStatusMachine {
  transition(
    streamId: StreamTabId,
    to: StreamStatus,
    cause: TransitionCause,
    terminalStatus?: ExecutionStatus,
  ): boolean; // false = rejected by rules
  get(streamId: StreamTabId): StreamStatus | undefined;
  tryAcquire(streamId: StreamTabId): boolean; // admission lock, unchanged
}
```

- **The rules move inside**: STOPPED-wins, `shouldPreserveOnCompletion`,
  stale-handle guards become the machine's transition table instead of
  call-site checks in the registry and lifecycle. Illegal transitions return
  `false`; today's scattered guards are deleted.
- **The `emit:false` backdoor becomes a named cause.** Restart repair and
  ghost hydration are legitimate host-authored transitions — the current
  design just has no vocabulary for them. `cause: 'restart-repair'` gives the
  UI backend its voice _through the front door_, and every transition emits a
  `status` event on the session hub (no silent writes, no split between
  "emitting" and "non-emitting" mutations).
- **One writer for STOPPED**: the RunTable stop path calls
  `transition(…, 'user-stop')`; the lifecycle calls
  `transition(…, 'lifecycle')`; the machine arbitrates. The dual-write
  coordination problem becomes one function.
- **Session-scoped, with explicit aggregation**: cross-session reads (the only
  legitimate use of today's sharing) go through the existing
  `liveSessions`-style aggregation, mirroring `getAllActiveExecutionIds()`.
  One window's delete-all can no longer sweep another window's streams (L3);
  the RunTable subscribes to _its own session's_ machine, so window A's
  status changes stop firing window B's waiters.

**Bag/context unification** (the split-brain fix, mechanical per the DI
audit): the launch context builds one frozen `RunScope` — identity
(streamId/executionId), `session`, `trace`, `workingDirectory`, model config
accessor — and both access paths carry _the same object_: the ALS
`RunContext` holds it, and flow service bags hold a reference to it instead
of copying 7–8 fields. Adding the trace to `RunScope` also closes the gap the
projector analysis found (ALS callers today can never reach the trace). Nodes
declare narrowed interfaces over it; the `{...this.services}` wholesale
spreads are replaced by explicit selection.

## 3. What each existing artifact becomes

| Today                                                                        | Becomes                                                                                                                    |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ProgressEventBus` (54 keys) + 1000-event buffer                             | Migration-period projection target; deleted at end. Buffer never reimplemented.                                            |
| `ProgressEventPayloads` run-fact keys (22)                                   | `AgentEvent` (existing + `status`, `child.activity`, `process.output` arms) and `SessionFact`                              |
| show/resolve pairs + bypass toggles (22 keys)                                | Internal to `HostInteractions` implementations; bypass state is port-owned                                                 |
| App-lifecycle keys (10)                                                      | `AppSignals` (small, explicitly process-scoped emitter)                                                                    |
| `emitRuntimeEvent`                                                           | `runScope.trace.*` (in-run) / `session.events.emit` (host-path); the three-way fallback resolution disappears              |
| `BasePromiseCoordinator` + 3 coordinators + `RunCoordinatorBridge`           | `HostInteractions` request bookkeeping + pending registry                                                                  |
| `platform().toolEditApproval` + per-run handler override + host promise maps | The session's `HostInteractions` implementation                                                                            |
| `ApprovalRequestHandler.pending/delivered` + `replayPendingPrompts`          | `session.interactions.pending()` + host redisplay                                                                          |
| `StreamStatusService` (shared singleton)                                     | `session.status` (`StreamStatusMachine`); cross-session reads via explicit aggregation                                     |
| `ExecutionRegistry`                                                          | `session.runs` (`RunTable`); E/F behind `Pick<>`; constructor `onDidChange` bridge → subscription to own session's machine |
| `InterruptRegistry`                                                          | deleted — capability lives on the run handle                                                                               |
| `ToolUseFollowUpQueue` (static)                                              | `session.followUps` instance                                                                                               |
| `getDefaultStreamLogStore` (last-writer-wins)                                | `session.transcripts`, threaded into `createRunTrace`                                                                      |
| `conversationProgressHub`, `terminalResultToast`                             | First-class projector subscribers on `session.events` (the pattern, generalized)                                           |
| `installTuiApprovals` emit monkey-patch (CLI)                                | CLI `HostInteractions` implementation                                                                                      |
| STOPPED-wins / preserve / stale-handle guards                                | `StreamStatusMachine` transition table                                                                                     |
| `UsageMonitor` dual emit                                                     | Single trace `usage` emit; sidebar totals are a projector                                                                  |

Invariants that become true _by construction_ (each currently held by a guard,
a comment, or luck): no event exists before its subscriber (hub is built with
the session); a pending interaction always has exactly one settlement path and
survives webview reload from one registry; a live stream is always
interruptible if discoverable; a status transition always has a cause and is
always observed; a run's transcript always lands in its session's store; one
window's actions never mutate another window's runtime state.

## 4. Migration (each stage shippable; extension byte-identical throughout)

The `defaultSession()` aliasing strategy from the 7d migration carries every
stage: the extension keeps one default session, so wiring changes are
invisible to it while desktop/CLI gain correctness.

1. **Hub + projection of the easy seven.** Add `SessionEventHub` +
   `attachRunTrace` generalization (attach before first emit). Project the
   seven drop-in run-facts (`updateTodos`, `updatePlan`, `updateStreamUsage`
   single-emit, `addOutputFiles`, `updateMissingOutputs`,
   `updateCompileFailures`, `goalPaused`) via the `conversationProgressHub`
   pattern onto the bus. Nothing downstream changes.
2. **Status machine.** Introduce `StreamStatusMachine` per session wrapping
   the shared instance's data; move guards into the transition table; convert
   `emit:false` writers to `restart-repair`/`clear` causes; add the `status`
   trace arm and make `updateStreamStatus` a projection. RunTable stop path
   switches from writing to requesting.
3. **Session facts + registry facts.** `SessionFact` channel for the non-run
   emitters; `child.activity`/`process.output` arms; `session.transcripts`
   and `session.followUps` instances (fixes L1; deletes the static queue and
   the binder invariant comment).
4. **Interactions port.** Introduce `HostInteractions` per session; implement
   for CLI first (deletes the monkey-patch and exercises the contract), then
   desktop (deletes the per-window handler plumbing), then extension.
   Coordinators/bridge/pending-registries fold in; resolution surfaces switch
   to `session.interactions.resolve`.
5. **Projector switchover + deletion.** Point each window's
   `ProgressEventHandler`, `StreamSnapshotStore`, CLI renderer, and the
   scattered frontend `bus.on` consumers at their session's hub (fixes L2/L3
   fan-out). Delete `ProgressEventPayloads` run-fact/RPC keys, the buffer,
   `emitRuntimeEvent`'s fallback chain, `InterruptRegistry`, and the
   `RunContext`/bag field copies (RunScope lands here or with 2).

Stages 1–2 are low-risk and deliver the single-writer status + single-emit
facts immediately; 3–4 are where multi-window desktop becomes actually
correct; 5 is the payoff deletion.

## 5. Rejected alternatives

- **Collapse the bus into the trace** (the naive fix): rejected — 22 keys are
  bidirectional RPC and 10 are app-scoped; a trace has no reply channel and
  no home for non-run facts. The bus's real successor is three surfaces, not
  one.
- **Keep event-pair RPC but unify the coordinators**: rejected — it preserves
  the wrong contract (fire-and-forget events simulating calls), keeps
  resolution possible without a session, and keeps three pending registries
  needing three replay paths.
- **Split `ExecutionRegistry` into lifecycle/follow-up/compaction services**:
  rejected — the dissection showed tracking+waiters+stop are one cohesive
  object (stop reads the map; every mutation notifies; status re-enters
  synchronously). Only the two read-only methods lift out.
- **Per-run follow-up mailboxes on the handle**: rejected — queues must
  outlive runs to serve WAITING streams across restarts; the queue is
  stream-scoped by nature and session-owned by residence.
- **A global event bus with session-id filtering**: rejected — filtering
  re-implements scoping at every consumer and keeps the leak class alive;
  ownership is the fix, not routing metadata.
- **New process-wide `setX` ports for the missing trace access**: rejected —
  the DI cleanup direction is fewer ambient globals, not more; `RunScope`
  carries the trace instead.
