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
- **`AgentEvent` gains two arms** for facts that are genuinely run lifecycle
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
  invariant become unrepresentable. `InterruptRegistry` (35 lines) is
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
map — and whose vocabulary is the **trimmed** one from the status census
below, so the machine ships with 5 public values instead of inheriting
today's 7:

```ts
/** Public per-stream phase. Absence (undefined) = idle/no stream. */
type StreamPhase = 'running' | 'waiting' | RunOutcome;
//                                         ^ 'completed' | 'cancelled' | 'failed'
//   Terminal phases ARE the outcome — no terminalStatus side-channel.

/** Display-only refinement of 'running'; never branched on by logic. */
type StreamSubstate = 'starting' | 'resuming';

type TransitionCause =
  | 'lifecycle' // runFlowWithLifecycle: running, terminal outcome
  | 'wait'
  | 'resume' // ToolUseWaitNode, resumeQueuedToolUse
  | 'user-stop' // RunTable stop path *requests*; machine writes 'cancelled'
  | 'restart-repair' // host recovery: running→waiting/failed after reload
  | 'clear'; // tab delete / delete-all (this session only)

interface StreamStatusMachine {
  transition(
    streamId: StreamTabId,
    to: StreamPhase,
    cause: TransitionCause,
    substate?: StreamSubstate,
  ): boolean; // false = rejected by the transition table
  get(streamId: StreamTabId): StreamPhase | undefined;
  /** Admission lock: reserves the stream (internal state, not a phase).
   *  Surfaces to the UI as running+substate:'starting'. */
  tryAcquire(streamId: StreamTabId): boolean;
  releaseIfReserved(streamId: StreamTabId): void;
}
```

- **The rules move inside**: cancelled-wins (today's STOPPED-wins),
  `shouldPreserveOnCompletion`, stale-handle guards become the machine's
  transition table instead of call-site checks in the registry and
  lifecycle. Illegal transitions return `false`; today's scattered guards
  are deleted.
- **The `emit:false` backdoor becomes a named cause.** Restart repair and
  ghost hydration are legitimate host-authored transitions — the current
  design just has no vocabulary for them. `cause: 'restart-repair'` gives the
  UI backend its voice _through the front door_, and every transition emits a
  `status` event on the session hub (no silent writes, no split between
  "emitting" and "non-emitting" mutations).
- **One writer for cancellation**: the RunTable stop path calls
  `transition(…, 'cancelled', 'user-stop')`; the lifecycle calls
  `transition(…, outcome, 'lifecycle')`; the machine arbitrates. The
  dual-write coordination problem becomes one function — and because the
  stop path must now _name_ the outcome, the census-discovered bug where
  direct stops emit STOPPED with no `terminalStatus` (leaving CLI history
  entries `unknown`/mis-resumable) becomes unrepresentable.
- **Session-scoped, with explicit aggregation**: cross-session reads (the only
  legitimate use of today's sharing) go through the existing
  `liveSessions`-style aggregation, mirroring `getAllActiveExecutionIds()`.
  One window's delete-all can no longer sweep another window's streams (L3);
  the RunTable subscribes to _its own session's_ machine, so window A's
  status changes stop firing window B's waiters.

### Status model: two axes, five public values (census-backed trim)

A value-level census of every producer and non-display consumer of the 7
`StreamStatus` values, plus a census of the sibling vocabularies, showed the
run-status cluster needs exactly **two axes**: _liveness_ (`running`,
`waiting`) and _outcome_ (`completed`, `cancelled`, `failed`). Everything
else is a projection, a sentinel, or a display hint:

| Today                                                              | Census verdict                                                                                                                                                                                          | In the new model                                                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `RUNNING`                                                          | Load-bearing (restart recovery, thinking indicator, pills)                                                                                                                                              | `running`                                                                                                                                |
| `WAITING`                                                          | Load-bearing — irreducible `terminal ∧ inFlight` oddball (follow-up routing, eviction, `shouldSkipWait`, focus/notify)                                                                                  | `waiting`                                                                                                                                |
| `STOPPED`                                                          | Two outcomes in one value; split carried out-of-band by `terminalStatus`, which the dominant direct-stop paths **omit** (`executionRegistry.ts:622,740,761`, `RetryState.ts:288`)                       | `completed` \| `cancelled` — outcome is the phase                                                                                        |
| `ERROR`                                                            | Load-bearing (sole injective terminal)                                                                                                                                                                  | `failed`                                                                                                                                 |
| `RESUMING`                                                         | Redundant-with-RUNNING: one producer, and its only value-specific branch (`executionRegistry.ts:416`) has downstream behavior identical to the WAITING branch; all guards go through the `active` trait | `running` + `substate:'resuming'`                                                                                                        |
| `INITIALIZING`                                                     | Internal lock: one producer (`tryAcquire`), one consumer (its own compensating release); nothing else branches on it                                                                                    | machine-internal reservation, shown as `running` + `substate:'starting'`                                                                 |
| `READY`                                                            | Equals `undefined` — the service deletes the map key; no registry consumer can ever read it; survives only as the emitted "cleared" signal and frontend default props                                   | deleted; `clear` emits an explicit cleared event; frontends default on `undefined`                                                       |
| `ExecutionStatus` (`completed/interrupted/error`)                  | Strict bijection of `RunOutcome`; kept alive only as the on-disk `terminalStatus` encoding (already a permissive `z.string()` with defensive readers)                                                   | deleted; write `RunOutcome`, read-shim legacy `interrupted→cancelled`, `error→failed`                                                    |
| `EndGroupStatus` (`error/stopped`)                                 | Byte-identical to the terminal `StreamStatus` projection; no consumer needs a third value; completed groups already render as neutral "stopped"                                                         | deleted as a stored vocabulary; derived helper `failed→'error'`, else `'stopped'` where the 2-value shape must survive (CLI JSON compat) |
| `TaskGroupStatus`                                                  | Named `StreamStatus` subset                                                                                                                                                                             | derived from `StreamPhase`                                                                                                               |
| `ActiveChildInfo.status` / `ExecutionStatusInfo.status` (stringly) | `StreamStatus` widened to `string` for badge wire format + process-exit text                                                                                                                            | `StreamPhase \| string` (exit text), documented                                                                                          |
| `TaskState`                                                        | **Not a status** — agent config (model, category, files); misnamed                                                                                                                                      | rename to `TaskConfig` when touched                                                                                                      |
| `ToolStatus`, `GoalStatus`, PR/CI states, `LogLevel`               | Orthogonal subjects (tool call, user goal, GitHub, severity)                                                                                                                                            | unchanged                                                                                                                                |

The `STREAM_STATUS_TRAITS` table collapses into four derived predicates over
5 values (`isActive = running`, `isInFlight = running \|\| waiting`,
`isTerminal = outcome ∈ RunOutcome \|\| waiting` — with WAITING's deliberate
`terminal ∧ inFlight` oddball preserved as today, `isLiveElapsed = running`),
and `RUN_OUTCOME_PROJECTION` shrinks from a three-column table to the single
derived group-end helper. The machine's transition table over 5 phases × 6
causes is small enough to be exhaustively unit-tested, which was the point
of the trim.

**Bag/context unification** (the split-brain fix, mechanical per the DI
audit): the launch context builds one frozen `RunScope` — identity
(streamId/executionId), `session`, `trace`, `workingDirectory`, model config
accessor — and both access paths carry _the same object_: the ALS
`RunContext` holds it, and flow service bags hold a reference to it instead
of copying 7–8 fields. Adding the trace to `RunScope` also closes the gap the
projector analysis found (ALS callers today can never reach the trace). Nodes
declare narrowed interfaces over it; the `{...this.services}` wholesale
spreads are replaced by explicit selection.

### Run descriptor: what "task state" becomes (census-backed)

An end-to-end census of the `setTaskState` subsystem found that `TaskState`
is agent **config** (a discriminated `AgentConfig` + a fully-derived
`activeFiles` projection, `agentConfigToTaskState.ts:20-26`), misnamed as
state — and that the event carrying it has quietly become a **second
run-start signal**: `handleSetTaskState` (`ProgressEventHandler.ts:362-392`)
piggy-backs five run-start side effects (clear hints, ensure stream state,
reset finished-child counters, prune interrupt handles, O(N) tab-metadata
rebuild) onto a config write, so run-start is currently spread across three
uncoordinated events (`setActiveStream`, status→RUNNING, `setTaskState`).
Three more defects: the same `AgentConfig` is persisted **twice** by
different subsystems (`meta.json.taskState` raw vs the execution store's
`config.json` normalized — drift by construction); `meta.json` stores it as
`z.unknown()` with no schema version, and two of the three read paths drop a
failed parse **silently** (tab loses its config, resume becomes impossible);
and a mid-run `switchModel` never re-emits it (`runToolUseFlow.ts:214-259`),
so the persisted model — and therefore the tab footer and any rerun — goes
stale.

Target design:

- **One immutable, versioned `RunDescriptor`** (rename of `TaskConfig`)
  emitted exactly once per run as a `run.start` arm on the run's trace:
  identity (executionId, streamId, parent), category discriminant, and the
  config. `activeFiles` is deleted as stored data — derived at render time
  from the config's file arrays, as it already is at write time.
- **One config persistence.** The descriptor references the execution
  store's `config.json` (by executionId) instead of `meta.json` carrying a
  second raw copy; `meta.json.taskState` becomes a read-shimmed legacy field
  with a `schemaVersion` going forward, and parse failures surface instead
  of silently unresuming the stream.
- **Run-start side effects move to the run-start transition.** The counter
  resets, hint clears, and metadata rebuild belong to the status machine's
  `→ running` transition (plane 3), where "a new run started on this stream"
  is a first-class fact — the config event only persists config. This also
  unblocks re-emitting config mid-run: `switchModel` emits a config-update
  fact without nuking per-run counters, fixing the stale-model bug.
- Consumers rebind mechanically: board cards (`buildStreamInfo`), setup
  proposal / history restore (`buildMainViewState` derives output-active
  from `config.outputFiles`), resume (`retrieveSessionResumeData`
  discriminates on the descriptor's category), CLI `StreamSlice`, and the
  pack/clean matcher (`findWorkflowStreamsMatching`).

### Transcript structure: typed stages, one round encoding

The grouping refactor documented in `progress-grouping-refactor.md` has
mostly **landed** (verified: per-trace stage scope R1, orphan re-rooting R2,
usage stage-id R4, and the inert `Task:` stage is gone — that PRD is now
stale and should be marked superseded; the one residue is the module
channel logger in `executeAgent.ts:65-66`). The stage layer is clean and
already the canonical spine. What remains is that a single fact — "round N
of M" — is emitted in **three unsynchronized encodings** with three
consumers:

1. `r<N>` **stage labels** (`runReflectionFlow.ts:266`) → transcript group
   headers, with the extension **regex-sniffing the label**
   (`/^r\d+$/`, `TaskGroupList.ts:292`);
2. `ExecutionProgress.currentRound/totalRounds` **counters**
   (`executeAgent.ts:165-169` → `ExecutionHandle`) → the orchestrator's
   subagent status line;
3. `conversationProgress` **domain events** (`executeAgent.ts:179-231`) →
   the StreamHeader badge and the CLI run-progress line — each encoding
   counting differently (0-indexed stage vs `conversationTurns = round+1`).

Target design:

- **Stages become typed.** `StageStartEvent` gains
  `kind: 'run' | 'round' | 'phase' | 'session'` and, for rounds,
  `index`/`total` — the round is self-describing; the label regex and the
  string protocol die. Tool-use turns emit `kind:'round'` stages too,
  unifying both agent categories under one structure.
- **Encoding #2 is deleted** — the subagent status line derives round
  progress from the child's round stage (via the hub) instead of a parallel
  registry counter; `ExecutionProgress.currentRound/totalRounds` and
  `createRoundProgressCallback` go away.
- **Encoding #3 shrinks to what stages can't carry**: `toolCallCount` (a
  genuine counter, not a structural fact). The round half of
  `conversationProgress` is deleted once the StreamHeader badge and the CLI
  progress line read `index/total` from the round stage.
- **Group-end status derives from `RunOutcome`** (the §"Status model"
  2-value helper), removing the `defaultStatus` guessing in
  `StageHandleImpl`; the crash-repair scan (`endRunningGroups`) stays as the
  single fallback closer.
- **Resume re-materializes the round stage** from the persisted
  `shared.currentRound` (which remains the loop's source of truth), so a
  resumed transcript continues at `r<N>`, not `r0`.
- Known lift: the CLI transcript deliberately renders a **flat timeline**
  and ignores GROUP rows today. It does not need to grow a tree to drop
  encodings #2/#3 — it only needs to read the typed round-stage events for
  its status line; flat rendering stays.

### Persistence and resume: one facade, one resumability rule (census-backed)

A store-by-store audit of the persistence/restore/resume layer found the
same disease as the event layer — the same fact written to several stores by
several owners, and the same decision re-derived per host — plus two
outright bugs:

- **Deleting a tab orphans its executions forever.** `clearStream`
  (`ProgressViewState.ts:325-326`) deletes `streamLogs/` + `streamData/`
  but never the backing `executions/{id}/` (config, meta, conversation,
  flow record). There is **no retention policy and no orphan GC anywhere**;
  kept `flow_*.json` records double as phantom "resumable" markers for
  streams that no longer exist. Goal-store entries leak the same way
  (extension tab-delete never calls `forget`; only CLI history-delete
  does).
- **A crash renders as success in CLI history.** Resumability is re-derived
  in **five places with different predicates** — bare flow-record existence
  (`detectWaitingStreams.ts:33`), a schema-parsing variant
  (`SessionResumeRetrieval.ts:120`), a `terminalStatus` gate that only the
  CLI applies (`history.ts:292-311`, which also defaults a missing terminal
  write to `'completed'`), and a status-based rule on desktop
  (`desktopStreamSnapshot.ts:145`). The hosts genuinely disagree about
  which runs are resumable.
- **Crash repair is duplicated per host and self-inconsistent.** Extension
  and desktop each orchestrate their own restart repair in different orders
  (desktop carries a full duplicate in its `catch` arm,
  `desktopAgentExecution.ts:754-797`); `endRunningGroups` can only write
  `'error'` groups while `resetRunningTasksToError` repairs the same stream
  to WAITING, and `terminalStatus` is never rewritten — so one crash yields
  a resumable stream with a red transcript and a stale outcome, three
  artifacts with three answers.
- **Four durable copies of the run's content.** Todos ×3 (KV projection,
  `workPlan.json`, flow-record shared), conversation ×2 (flow record is
  what resume actually reads; `conversation.json` is a display-only
  duplicate rewritten **every node step**), output files ×2, description
  ×2, agentConfig ×2 (the RunDescriptor finding). `PersistedFlow`
  `structuredClone`s and rewrites the whole shared blob per step
  (`persistedFlow.ts:182-183`), and desktop's `streams.json` rewrites the
  whole rail file on every status tick.
- **Silent-drop reads.** `readValidated` is `.nullable().catch(null)`
  (`ExecutionKVStore.ts:182`); unparseable transcript entries and
  `taskState` parses are dropped with no signal — corruption is invisible
  and manifests as "resume does nothing". `ExecutionMeta`, `FlowRecord`,
  and `meta.json` have no `schemaVersion` (unlike snapshots and the
  desktop rail, which do this right); and the flow-record legacy-shape
  migration is implemented twice (`nodes/types.ts:113` and
  `SessionResumeRetrieval.ts:66`), while the pre-KV `index.json`
  migration still runs on the hot path years past its data.

Target design (extends plane 3's `session.transcripts`; honors audit A6 —
formats stay separate, ownership unifies):

- **`session.stores` facade with atomic lifecycle.** One owner for the
  stream's durable footprint: tab-delete removes `streamLogs` +
  `streamData` + `executions/{id}` + goal entries together; a startup sweep
  GCs orphans against the live stream set. Retention becomes a policy hook
  instead of "never".
- **One ownership rule per fact.** Flow record = resume SSOT;
  `streamData/` = display sidecars; `executions/config.json` = config. The
  `conversation.json`/`todos.json` KV projections and the
  `meta.json.taskState` raw copy are deleted (the RunDescriptor references
  config by executionId).
- **One `deriveResumability(executionId) → {resumable, cause}`** consumed
  by all five call sites. With terminal statuses as `RunOutcome` (§Status
  model), the CLI's gate stops disagreeing with the runtime, and a missing
  terminal write derives `failed`-after-crash instead of `'completed'`.
- **One `repairAfterRestart(session)` primitive** shared by extension and
  desktop: status via the `restart-repair` cause, transcript group closure,
  and outcome rewrite happen together, so the three artifacts cannot
  disagree. Repaired-to-WAITING streams get neutral group closure, not
  forced `'error'`.
- **Loud reads, versioned writes.** `schemaVersion` on `ExecutionMeta`,
  `FlowRecord`, and `meta.json`; parse failures on the resume path surface
  as warnings instead of silently degrading; the duplicated legacy-shape
  migration collapses into `migrateSharedState` as the single
  implementation, and the pre-KV `index.json` migration is retired behind a
  one-time marker.
- **Write hygiene.** Desktop rail writes debounced like the transcript
  store; the flow record's unbounded `nodes[]` history moves to
  append-delta or capped retention (it is a step log, not resume state).

## 3. What each existing artifact becomes

| Today                                                                                   | Becomes                                                                                                                             |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `ProgressEventBus` (54 keys) + 1000-event buffer                                        | Migration-period projection target; deleted at end. Buffer never reimplemented.                                                     |
| `ProgressEventPayloads` run-fact keys (22)                                              | `AgentEvent` (existing + `status`, `child.activity`, `process.output` arms) and `SessionFact`                                       |
| show/resolve pairs + bypass toggles (22 keys)                                           | Internal to `HostInteractions` implementations; bypass state is port-owned                                                          |
| App-lifecycle keys (10)                                                                 | `AppSignals` (small, explicitly process-scoped emitter)                                                                             |
| `emitRuntimeEvent`                                                                      | `runScope.trace.*` (in-run) / `session.events.emit` (host-path); the three-way fallback resolution disappears                       |
| `BasePromiseCoordinator` + 3 coordinators + `RunCoordinatorBridge`                      | `HostInteractions` request bookkeeping + pending registry                                                                           |
| `platform().toolEditApproval` + per-run handler override + host promise maps            | The session's `HostInteractions` implementation                                                                                     |
| `ApprovalRequestHandler.pending/delivered` + `replayPendingPrompts`                     | `session.interactions.pending()` + host redisplay                                                                                   |
| `StreamStatusService` (shared singleton)                                                | `session.status` (`StreamStatusMachine`); cross-session reads via explicit aggregation                                              |
| `ExecutionRegistry`                                                                     | `session.runs` (`RunTable`); E/F behind `Pick<>`; constructor `onDidChange` bridge → subscription to own session's machine          |
| `InterruptRegistry`                                                                     | deleted — capability lives on the run handle                                                                                        |
| `ToolUseFollowUpQueue` (static)                                                         | `session.followUps` instance                                                                                                        |
| `getDefaultStreamLogStore` (last-writer-wins)                                           | `session.transcripts`, threaded into `createRunTrace`                                                                               |
| `conversationProgressHub`, `terminalResultToast`                                        | First-class projector subscribers on `session.events` (the pattern, generalized)                                                    |
| `installTuiApprovals` emit monkey-patch (CLI)                                           | CLI `HostInteractions` implementation                                                                                               |
| STOPPED-wins / preserve / stale-handle guards                                           | `StreamStatusMachine` transition table                                                                                              |
| `UsageMonitor` dual emit                                                                | Single trace `usage` emit; sidebar totals are a projector                                                                           |
| `setTaskState` event + `TaskState` + `meta.json.taskState` (raw copy)                   | `run.start` trace arm carrying an immutable versioned `RunDescriptor`; config persisted once (`config.json`); `activeFiles` derived |
| `handleSetTaskState` run-start piggy-backs (counter reset, hint clear, O(N) rebuild)    | The status machine's `→ running` transition                                                                                         |
| `r<N>` label regex + `ExecutionProgress` round counters + `conversationProgress` rounds | Typed round stages (`kind:'round'`, `index`, `total`); `conversationProgress` shrinks to `toolCallCount`                            |
| `progress-grouping-refactor.md` (R1/R2/R4 landed, PRD stale)                            | Marked superseded; residue = module channel logger in `executeAgent.ts`                                                             |
| Tab-delete leaving `executions/`, flow records, goal entries behind                     | `session.stores` facade: atomic delete + startup orphan sweep + retention hook                                                      |
| 5 resumability predicates (extension/CLI/desktop disagree; crash → `completed`)         | One `deriveResumability(executionId)` over flow record + `RunOutcome`                                                               |
| Per-host restart repair (status/transcript/terminalStatus can disagree)                 | One shared `repairAfterRestart(session)` writing all three artifacts together via the `restart-repair` cause                        |
| `conversation.json`/`todos.json` KV projections (duplicate flow-record shared)          | Deleted; display reads the sidecar facade, resume reads the flow record                                                             |

Invariants that become true _by construction_ (each currently held by a guard,
a comment, or luck): no event exists before its subscriber (hub is built with
the session); a pending interaction always has exactly one settlement path and
survives webview reload from one registry; a live stream is always
interruptible if discoverable; a status transition always has a cause and is
always observed; a run's transcript always lands in its session's store; one
window's actions never mutate another window's runtime state.

## 4. Surface contracts: where the vocabulary and events cross boundaries

A surface census (persisted formats, IPC schemas, SDK exports, display
tables) ranked where the current vocabulary is pinned. The redesign tiers
the surfaces so each has one canonical source and an explicit compatibility
posture:

**Tier 0 — canonical schemas (one source).** `RunOutcomeSchema` and a new
`StreamPhaseSchema` in `@shared/schemas` are the only definitions.
`ResultEvent.outcome` is today a **hand-inlined literal** that must track
`RunOutcome` by hand (`events.ts:173`) — it becomes schema-derived.
`StageEndEvent.status` drops `EndGroupStatus` for `'ok' | 'error'` (the only
distinction any group renderer consumes).

**Tier 1 — SDK (`@texra/core` / `AgentEvent`).** `StreamStatus` does not
leak into the SDK today (verified) — keep it that way: the SDK speaks
`RunOutcome`, `StreamPhase`, and the `AgentEvent` union only.
`ExecutionListingEntry.terminalStatus` (re-exported as free `string`)
switches to `outcome?: RunOutcome` with the read shim. The union gaining
`status`/`child.activity`/`process.output` arms is deliberately breaking for
exhaustive-switch subscribers — that is the union's documented design, and it
is free **only while the package is `private: true`**: the event-surface work
must land before the SDK ships.

**Tier 2 — host IPC (webview/renderer).** The protocol stays
stream-addressed; the census confirmed no message is session-scoped and all
scoped messages compose one schema (`StreamScopedBaseSchema`, `data.ts:29`),
so if a session dimension is ever needed it is a one-file change. Two
outbound message types carry status (`UPDATE_STREAM_STATUS`,
`UPDATE_STREAMS`); they carry `phase` + `substate` after the trim. This
**removes a today's asymmetry**: `terminalStatus` is stripped from webview
IPC, so only the CLI can render "done" vs "interrupted" — with outcome as
the phase, the webview gains the distinction for free (a deliberate,
user-visible improvement, not byte-identical). Frontends consume the raw
vocabulary (label table, `is-*` CSS selectors, per-status button-enable
sets), so the trim touches ~7 display sites — all keyed on 5 values + a
substate afterwards.

**Tier 3 — persisted formats (compatibility posture per file).**

| Format                                              | Pin strength                                                                                       | Posture                                                                                                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `executions/{id}/meta.json` `terminalStatus`        | Soft — stored as free `z.string()`, defensive readers                                              | Write `RunOutcome` values; read-shim maps legacy `interrupted/error`; no version bump needed                                                         |
| Desktop `streams.json` `lastKnownStatus`            | **Hard — the only required on-disk enum** (`streamRestoration.ts:44`); a rename discards old rails | The repo's canonical `z.union` + `.transform` shim (the pattern `PersistedStreamLogEntrySchema` already uses) mapping old 7-value statuses to phases |
| `StreamSnapshot.status`                             | Soft — optional, advisory, log-derived, schema-versioned                                           | Recomputed on load; nothing to migrate                                                                                                               |
| StreamLog group-end rows                            | Opaque (`data: z.unknown()`) but display code pattern-matches `status:'error'`                     | Tolerant reader accepting both old and new literals; writer switches                                                                                 |
| CLI history JSON (`resumable`/`unknown` synthetics) | CLI-invented, CLI-consumed                                                                         | Derive from `outcome`; `cancelled`/absent stay resumable                                                                                             |

**Tier 4 — external contracts (frozen projections).** The CLI headless JSON
(`CliRunResult`) is the widest external pin: it exposes **all three** legacy
terminal vocabularies simultaneously (`outcome` + `status`/`terminalStatus` +
`endGroupStatus`) to scripts, behind a deliberately loose NDJSON schema that
would not catch renames. Per the clig.dev future-proofing guideline (changes stay additive),
those legacy fields are **not removed**: they become frozen projections
derived from `outcome` (`terminalStatus` via the legacy mapping,
`endGroupStatus` via the 2-value helper), documented as deprecated, with
`outcome` as the supported field. Headless output stays byte-identical.

**Display tier.** `streamStatusDisplay.ts` and the CSS/button tables key on
`(phase, substate)`: `starting…`/`resuming` come from the substate,
`completed`/`cancelled` finally get distinct labels everywhere (today the
extension shows both as "Stopped"), and the tables shrink with the enum.

## 5. Holistic review: interactions and side effects across everything proposed

Taking the whole program together (audit Parts A/B, the three planes, the
status trim, the surface tiers), these are the cross-cutting effects and the
ordering they force:

**Sequencing constraints (do these in this order or pay twice):**

1. **Vocabulary before machine.** The `StreamStatusMachine` ships speaking
   `StreamPhase`; building it on the 7-value enum and trimming later would
   migrate every surface twice. (Legacy values live only in the tier-3/4
   shims from day one.)
2. **Test infra first.** The `memfs`/global-setup change (audit A4) touches
   the same 75 `initPlatform` sites and singleton-bound suites that every
   session-scoping stage churns; landing it first cuts total churn.
3. **Host-adapter factories (A2) and the interactions port share files**
   (`desktopAgentExecution.ts`, both message handlers). Run them as one
   sequenced track, not parallel PRs into the same 1,000-line files.
4. **`requestRetry` must be co-designed with the error-pipeline plan** —
   `error-pipeline-and-ownership.md` T2 names a single retry owner; the
   interactions port is that owner's request surface, not a competitor.
5. **SDK-breaking event work before publishing `@texra/core`.** All
   `AgentEvent` arm additions and the `StageEndEvent.status` change are free
   now, expensive the day the package has external consumers.

**Deliberate behavior changes (visible, and intended):**

- The extension webview starts distinguishing completed/cancelled (today
  both render "Stopped"; only the CLI decodes `terminalStatus`). This
  intentionally breaks the "extension byte-identical" rule for one
  user-facing improvement — flagged, not smuggled.
- Approval serialization narrows from process-wide to per-session
  one-at-a-time (multi-window can prompt concurrently).
- Un-attributed stop paths must name an outcome (`cancelled`), which
  _changes_ CLI history for future runs from `unknown` to `interrupted`-
  equivalent — a bug fix wearing a behavior change.

**Risks and their mitigations:**

- **Chunk traffic on the hub.** `stream.chunk` never reaches the bus today;
  forwarding whole traces into the session hub puts per-token events in
  front of every hub subscriber, and `StreamSnapshotStore`'s debounced
  persistence must not see them. The hub API therefore takes a subscription
  filter (`subscribe(sub, { types?, scope? })`) so projectors and stores
  opt into event classes; the transcript recorder keeps its direct trace
  subscription.
- **Buffer removal converts a runtime crutch into an activation invariant.**
  The extension's scattered frontend consumers (`fileDecorations`,
  `inlineCriticism`, status bar) attach at different points during
  activation and lean on bus replay today. Post-hub, "all session
  subscribers attach before startup-resume runs launch" must be an explicit,
  asserted activation ordering — otherwise early events are silently lost
  where today they replayed. Stage 1 adds that assertion before anything
  depends on it.
- **CLI headless parity is a hard gate.** `texra run`/`--print`/JSON output
  must be byte-identical through the renderer's move to hub subscription
  (both paths are synchronous, so ordering holds) and through tier 4's
  frozen projections. Each stage that touches the CLI lands with the parity
  test, not an assumption.
- **Migration-window event ordering.** While some run-facts are projected
  trace→bus and others still emit directly, relative order between two
  related facts can invert. Stages therefore migrate whole fact _clusters_
  (e.g. status+result together), never half of a causally-linked pair.
- **Multi-window desktop reality check.** L1–L3's "live bug" severity
  assumes >1 `DesktopAgentExecution` per process actually ships. The
  per-window session comments say yes, but verify before paying stages 3–5;
  if single-window, those stages are pre-payment for a planned feature and
  should be re-prioritized honestly.
- **Collision with the active PR train.** This branch was force-updated
  mid-audit by concurrent maintainer work; the program only works as small,
  independently shippable PRs per stage — a long-lived refactor branch
  across these files would conflict constantly.
- **What deliberately does NOT change:** `subagentDeliveryRegistry` and
  `toolInjectionRegistry` stay process-global (documented decisions);
  WAITING keeps its `terminal ∧ inFlight` oddball semantics; the
  `StreamLogStore`/`StreamSnapshotStore` format split stays (facade only,
  per audit A6); headless output bytes; the PocketFlow flow contracts.

## 6. Migration (each stage shippable; extension byte-identical throughout, except the flagged completed/cancelled display improvement)

The `defaultSession()` aliasing strategy from the 7d migration carries every
stage: the extension keeps one default session, so wiring changes are
invisible to it while desktop/CLI gain correctness.

0. **Vocabulary + shims.** Land `StreamPhaseSchema`, the tier-3 read shims
   (desktop `streams.json` union+transform, `terminalStatus` legacy mapping),
   the tier-4 frozen CLI projections, and the display-table re-keying —
   while the old service still runs. Pure schema/shim work, independently
   revertible, and it forces the outcome-naming fix onto the direct stop
   paths (per §5 sequencing rule 1: vocabulary before machine).
1. **Hub + projection of the easy seven.** Add `SessionEventHub` (with
   subscription filters, see §5 chunk risk) + the `attachRunTrace`
   generalization (attach before first emit, with the activation-ordering
   assertion). Project the seven drop-in run-facts (`updateTodos`,
   `updatePlan`, `updateStreamUsage` single-emit, `addOutputFiles`,
   `updateMissingOutputs`, `updateCompileFailures`, `goalPaused`) via the
   `conversationProgressHub` pattern onto the bus. Nothing downstream
   changes.
2. **Status machine.** Introduce `StreamStatusMachine` per session (speaking
   `StreamPhase` from day one) wrapping the shared instance's data; move
   guards into the transition table; convert `emit:false` writers to
   `restart-repair`/`clear` causes; add the `status` trace arm and make
   `updateStreamStatus` a projection. RunTable stop path switches from
   writing to requesting `cancelled`.
3. **Session facts + registry facts + run structure.** `SessionFact` channel
   for the non-run emitters; `child.activity`/`process.output` arms;
   `session.transcripts` and `session.followUps` instances (fixes L1;
   deletes the static queue and the binder invariant comment). Also here:
   the `run.start` `RunDescriptor` arm (retiring `setTaskState` and moving
   its run-start piggy-backs onto the `→ running` transition from stage 2)
   and typed round stages (`kind`/`index`/`total`), deleting the
   `ExecutionProgress` round counters and the round half of
   `conversationProgress`. The persistence facade lands here too:
   `session.stores` atomic delete + orphan sweep, the single
   `deriveResumability` and shared `repairAfterRestart` primitives (repair
   uses stage 2's `restart-repair` cause), and deletion of the
   `conversation.json`/`todos.json` projections.
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

Stages 0–2 are low-risk and deliver the trimmed vocabulary, single-writer
status, and single-emit facts immediately; 3–4 are where multi-window
desktop becomes actually correct; 5 is the payoff deletion.

## 7. Rejected alternatives

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
