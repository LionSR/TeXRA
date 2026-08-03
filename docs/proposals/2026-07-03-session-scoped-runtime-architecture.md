# Session-scoped runtime architecture: facts, interactions, and status ownership

> **Status:** Partially landed proposal (Stages 0-3b plus Checkpoint A; status
> refreshed by #6965 on 2026-07-05). Companion to the diagnosis in
> `2026-07-03-tech-debt-audit.md` (Part B1/B5 + appendix); this document is the
> target design. It covers the event/logger chain, the
> approval/interaction RPC machinery, stream status, and the execution registries
> — and how all of them couple to the UI backends. **§8 (2026-07-11)** is a
> design-gated addendum for #7993: the concrete, near-term StreamPhase-native
> cutover of group-end/live-status _production_, extracted from D1 (#6982)
> because those producers turned out to be live, not dormant. It corrects the
> Tier-0 `StageEndEvent.status` sketch in §4.

## 1. Diagnosis: one root cause, many symptoms

Every debt found in the deep dives reduces to the same defect: **run facts,
host interactions, and status live on process-global singletons while the UI
backends are per-window**, and the gap is bridged by per-run patches and
defensive guards instead of ownership.

The evidence, condensed (file:line references in the audit appendix):

**Genuine cross-session leaks (live bugs in multi-window desktop):**

- L1. Pre-Stage 3a evidence: `getDefaultStreamLogStore()` was process-global and last-writer-wins
  (`ProgressViewState.ts:153` calls `setDefaultStreamLogStore(this.streamLogs)`
  per window; `runTrace.ts:34` defaults to it). A run's transcript appended to
  whichever window's store was constructed last. Stage 3a (#6964) moves run
  traces and progress backends onto `session.transcripts`; the default getter
  remains only as the single-session compatibility path.
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
- Pre-Stage 3a session invariants were enforced by comments, not types: the
  per-session subscription binder read the process-static streamId-keyed
  `ToolUseFollowUpQueue` (`SessionHandle.ts:99-104`); `handles`
  (executionId-keyed) and `InterruptRegistry` (streamTabId-keyed) had to be
  populated in tandem or a stream was discoverable but uninterruptible. Stage 3a
  moves the binder and tool-use flows onto `session.followUps`; interrupt
  ownership remains a later stage concern.

**What is already right (build on it, don't replace it):**

- `SessionHandle` is a real composition root (owns per-session
  interrupts/executions/coordinators/subscriptions plus the Stage 3a
  events/transcripts/follow-up owners) with the
  `defaultSession()` aliasing strategy proven by the 7d migration.
- The 12-variant `AgentEvent` trace is a clean one-way fact stream with
  per-run subscribers; `conversationProgressHub` proves the trace→bus
  projection pattern; `AgentExecutionHandle` already carries `trace`,
  `result`, `coordinators`.
- `runFlowWithLifecycle` + `RUN_OUTCOME_PROJECTION` is a working
  single-writer terminal transition.
- Emit discipline holds: zero raw `bus.emit` in VS Code-free zones.
- The logger is done in shape: `src/logger/*` is 381 lines after the redaction
  helper expansion, with one channel-sink boundary and two entry points that
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
(`2026-07-03-agent-runtime-ui-coupling-audit.md:76`) — hosts keep their own persistence,
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
  launching session, removing the last-writer-wins path and fixing L1. The
  default store/queue accessors remain as scheduled single-session
  compatibility shims until D1.
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
  | 'restart-repair'; // host recovery: running→waiting/failed after reload

interface StreamStatusMachine {
  transition(
    streamId: StreamTabId,
    to: StreamPhase,
    cause: TransitionCause,
    substate?: StreamSubstate,
  ): boolean; // false = rejected by the transition table
  /** Tab delete / delete-all (this session only). NOT a transition: it
   *  removes the entry (no StreamPhase represents "no stream") and emits
   *  an explicit `cleared` event rather than a status event. */
  clearStream(streamId: StreamTabId): void;
  get(streamId: StreamTabId): StreamPhase | undefined;
  /** Admission lock: reserves the stream (internal state, not a phase).
   *  Surfaces to the UI as running+substate:'starting'. Deliberately
   *  outside the transition table — it is a two-state reservation
   *  (reserved/free) with its own invariant pair (acquire rejected while
   *  in-flight; release only if still reserved), tested separately. */
  tryAcquire(streamId: StreamTabId): boolean;
  releaseIfReserved(streamId: StreamTabId): void;
}
```

- **The rules move inside**: cancelled-wins (today's STOPPED-wins),
  `shouldPreserveOnCompletion`, stale-handle guards become the machine's
  transition table instead of call-site checks in the registry and
  lifecycle. Terminal-state immutability is general — the table rejects any
  transition out of a terminal phase except an explicit `resume`; cancelled-
  wins is its specific arbitration between a user stop and a racing
  lifecycle completion. Illegal transitions return `false`; today's
  scattered guards are deleted.
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

| Today                                                              | Census verdict                                                                                                                                                                                          | In the new model                                                                                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RUNNING`                                                          | Load-bearing (restart recovery, thinking indicator, pills)                                                                                                                                              | `running`                                                                                                                                                            |
| `WAITING`                                                          | Load-bearing — irreducible `terminal ∧ inFlight` oddball (follow-up routing, eviction, `shouldSkipWait`, focus/notify)                                                                                  | `waiting`                                                                                                                                                            |
| `STOPPED`                                                          | Two outcomes in one value; split carried out-of-band by `terminalStatus`, which the dominant direct-stop paths **omit** (`executionRegistry.ts:622,740,761`, `RetryState.ts:288`)                       | `completed` \| `cancelled` — outcome is the phase                                                                                                                    |
| `ERROR`                                                            | Load-bearing (sole injective terminal)                                                                                                                                                                  | `failed`                                                                                                                                                             |
| `RESUMING`                                                         | Redundant-with-RUNNING: one producer, and its only value-specific branch (`executionRegistry.ts:416`) has downstream behavior identical to the WAITING branch; all guards go through the `active` trait | `running` + `substate:'resuming'`                                                                                                                                    |
| `INITIALIZING`                                                     | Internal lock: one producer (`tryAcquire`), one consumer (its own compensating release); nothing else branches on it                                                                                    | machine-internal reservation, shown as `running` + `substate:'starting'`                                                                                             |
| `READY`                                                            | Equals `undefined` — the service deletes the map key; no registry consumer can ever read it; survives only as the emitted "cleared" signal and frontend default props                                   | deleted; `clear` emits an explicit cleared event; frontends default on `undefined`                                                                                   |
| `ExecutionStatus` (`completed/interrupted/error`)                  | Strict bijection of `RunOutcome`; kept alive only as the on-disk `terminalStatus` encoding (already a permissive `z.string()` with defensive readers)                                                   | deleted; write `RunOutcome`, read-shim legacy `interrupted→cancelled`, `error→failed`                                                                                |
| `EndGroupStatus` (`error/stopped`)                                 | Byte-identical to the terminal `StreamStatus` projection; no consumer needs a third value; completed groups already render as neutral "stopped"                                                         | deleted as a stored vocabulary; derived helper `failed→'error'`, else `'stopped'` where the 2-value shape must survive (CLI JSON compat)                             |
| `TaskGroupStatus`                                                  | Named `StreamStatus` subset                                                                                                                                                                             | derived from `StreamPhase`                                                                                                                                           |
| `ActiveChildInfo.status` / `ExecutionStatusInfo.status` (stringly) | `StreamStatus` widened to `string` for badge wire format + process-exit text                                                                                                                            | `StreamPhase \| string` (exit text), documented                                                                                                                      |
| `TaskState`                                                        | **Not a status** — agent config (model, category, files); misnamed                                                                                                                                      | replaced by `RunDescriptor` (see the run-descriptor section; the correction is conceptual — it is config, not state — and `RunDescriptor` is the single target name) |
| `ToolStatus`, `GoalStatus`, PR/CI states, `LogLevel`               | Orthogonal subjects (tool call, user goal, GitHub, severity)                                                                                                                                            | unchanged                                                                                                                                                            |

The `STREAM_STATUS_TRAITS` table collapses into **three** derived predicates
over 5 values: `isActive = running`, `isInFlight = running \|\| waiting`,
`isTerminal = completed \|\| cancelled \|\| failed \|\| waiting` — with WAITING's deliberate
`terminal ∧ inFlight` oddball preserved as today. `isLiveElapsed` becomes
identical to `isActive` after the trim and is **deleted** (in the old table
they diverged only on INITIALIZING — elapsed-ticking but not active; with
`starting` as a substate of `running`, the distinction has no member left).
The one behavioral delta: a stream in `starting` now counts as "active",
which is safe because the guards that matter (`tryAcquire`,
follow-up routing, eviction) key off `isInFlight`, not `isActive`.
`RUN_OUTCOME_PROJECTION` shrinks from a three-column table to the single
derived group-end helper. The machine's transition table over 5 phases × 5
causes is small enough to be exhaustively unit-tested, which was the point
of the trim (the admission reservation is deliberately outside the table —
see the interface note — and carries its own two-invariant test pair).

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

- **One immutable, versioned `RunDescriptor`** (the single target name for
  today's misnamed `TaskState`; no intermediate `TaskConfig` step)
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

The grouping refactor documented in `2026-05-30-progress-grouping-refactor.md` has
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
- **Resumability is re-derived in five places with different predicates** —
  bare flow-record existence (`detectWaitingStreams.ts:33`), the same
  truthy check re-implemented for lazy follow-up promotion
  (`lazyDetectWaitingStatus`, `followUpCommand.ts:48`), a schema-parsing
  variant (`SessionResumeRetrieval.ts:120`), a
  `terminalStatus` gate that only the CLI applies (`history.ts:292-311`),
  and a status-based rule on desktop (`desktopStreamSnapshot.ts:145`). The
  hosts genuinely disagree about which runs are resumable — a stream the
  extension would auto-resume can be gated non-resumable by the CLI, and
  desktop's rule keys off a persisted status the others ignore. (The CLI's
  crash handling itself is already correct: `resolveCliHistoryStatus`
  explicitly refuses to report a missing terminal write as `'completed'`,
  returning `'resumable'`/`'unknown'` — the historical crash-as-success bug
  described in `2026-06-10-lifecycle-status-ownership.md:134` has been fixed. The
  remaining debt is the five-way disagreement, not that bug.)
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
  terminal write derives a definite `failed`-after-crash instead of the
  CLI's `'unknown'` bucket.
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
| `2026-05-30-progress-grouping-refactor.md` (R1/R2/R4 landed, PRD stale)                 | Marked superseded; residue = module channel logger in `executeAgent.ts`                                                             |
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

**Tier 0 — canonical schemas (one source).** `RunOutcomeSchema` (which
**already ships** — `src/shared/schemas/stream.ts:145`; do not redefine it)
and `StreamPhaseSchema` (which **also already ships** —
`src/shared/schemas/stream.ts:148-157`) are the only definitions; no new
schema is introduced. `ResultEvent.outcome` is today a **hand-inlined
literal** that must track `RunOutcome` by hand (`events.ts:173`) — it becomes
schema-derived.
`StageEndEvent.status` drops `EndGroupStatus`. **Superseded, 2026-07-11: see
§8** — the `'ok' | 'error'` collapse sketched below was itself a new
2-value vocabulary and fails R4 (reuse, don't invent). §8 works out the
production cutover in full and lands on reusing `RunOutcome` directly
instead, since every real producer already holds the outcome value at the
call site.
<!-- Original sketch, kept for the sequencing rationale in §5 item 1, corrected by §8:
`completed → 'ok'`, `cancelled → 'ok'`, `failed → 'error'` — the same
collapse the legacy 2-value helper applies (`{completed,cancelled}→stopped`,
`failed→error`), renamed so "ok" stops being spelled "stopped". -->

**Tier 1 — future SDK package / `AgentEvent`.** `StreamStatus` should not
leak into a future SDK package: the SDK surface should speak `RunOutcome`,
`StreamPhase`, and the `AgentEvent` union only.
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
   `2026-06-10-error-pipeline-and-ownership.md` T2 names a single retry owner; the
   interactions port is that owner's request surface, not a competitor.
5. **SDK-breaking event work before reintroducing/publishing an SDK package.**
   All `AgentEvent` arm additions and the `StageEndEvent.status` change are
   free now, expensive the day a package has external consumers.

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
- A lifecycle outcome for a stream already in WAITING is intentionally written
  as `WAITING → RUNNING` (`resume`) followed by `RUNNING → outcome`
  (`lifecycle`). The old preservation behavior left a completed cycle stuck in
  resumable UI state; the machine now records the run outcome explicitly while
  keeping WAITING's in-flight/resumable semantics for streams that have not
  reached a lifecycle outcome.

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
- **Multi-window desktop reality check.** Checkpoint A recorded the maintainer
  pre-flight answer on 2026-07-05: for desktop, do the wisest thing. The
  checkpoint treats multi-window desktop as supported/intended unless current
  code proves it mechanically impossible, so L1–L3 remain correctness work for
  stages 3–5 rather than pre-payment.
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

Test gates per stage: stage 0 ships the exhaustive phase×cause transition
table test, the reservation invariant pair, and round-trip tests for every
tier-3 shim (old value in → phase out); stage 1 ships the
activation-ordering assertion and the CLI headless byte-parity test; stages
2–5 each keep the parity test green and add projector-equivalence tests
(bus-fed vs hub-fed handler output identical) before any bus key is
deleted.

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
3. **Session facts + registry facts + run structure.** Stage 3a (#6964) lands
   the `SessionFact` channel for the non-run emitters,
   `child.activity`/`process.output` arms, and `session.transcripts` /
   `session.followUps` instances (fixes L1 and deletes the binder invariant
   comment). Stage 3b (#6965) lands the `run.start` `RunDescriptor` arm,
   moves the run-start piggy-backs onto the `→ running` transition from stage
   2, and lands typed round stages (`kind`/`index`/`total`) while shrinking
   `conversationProgress` to `toolCallCount`. Remaining Stage 3 work is the
   persistence facade:
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

## 8. Addendum (2026-07-11): StreamPhase-native group-end/live-status production (#7993 step 1)

Design-gated per #7993: no production-cutover PR may land until this section
is reviewed. Re-scoped out of D1 (#6982) on 2026-07-11 because the legacy
producers this targets are **not** dormant residue awaiting an age window —
they run on every stream today. This section is deliberately narrower than
§§1-7: it does not require the `StreamStatusMachine`/`SessionEventHub` build.
It only retypes what `stage.end()` and the live-status writers already emit,
reusing the `StreamPhase`/`RunOutcome` vocabulary that already ships (§4
Tier 0). §§1-7's bigger machine can still land later; this addendum does not
block on it, and nothing here is incompatible with it landing afterward.

### 8.1 Current state (verified at HEAD `035741c0d`, 2026-07-11)

**Three live producers write the legacy 2-value `EndGroupStatus`
(`{error, stopped}` — `END_GROUP_STATUS`, `src/shared/schemas/log.ts:16-19`,
asserted at compile time to be a subset of the 4-value `TaskGroupStatus`,
itself a subset of the 7-value `StreamStatus`) into every `GROUP_END`
transcript row:**

1. **`AgentRunLifecycle.ts:138`** — `params.stage.end(legacyEndGroupStatusForOutcome(outcome))`,
   called at every `stage.end()` on run termination. `outcome` here is
   already a `RunOutcome` (`completed | cancelled | failed`); the helper
   throws that information away, folding `completed`/`cancelled` into one
   string (`'stopped'`).
2. **`AgentRunLifecycle.ts:369`** — a direct `session.transcripts.update(...)`
   write (bypassing `TraceEmitter`, because the trace's subscriber has
   already been torn down at this point in the suspend path — see the
   comment at `:355-364`) with
   `status: legacyEndGroupStatusForOutcome(RUN_OUTCOME.CANCELLED)`. Same
   helper, same fold, hand-called a second time.
3. **`TraceEmitter.ts:212` and `:300`** — `openStage()`'s
   `defaultStatus = options.defaultStatus ?? END_GROUP_STATUS.STOPPED` and
   `StageHandleImpl.run()`'s catch branch `this.end(END_GROUP_STATUS.ERROR)`.
   These defaults are correct for genuinely generic stages (tool groupings
   and sub-phases), whose local execution is binary: success or failure.
   They are not an outcome source for cancellable round stages. At the audit
   baseline, `ToolUseCycleNode.ts` called `roundStage.run()` and only then
   classified the returned round as completed, failed, or cancelled. Since
   `run()` closed the stage before that classification, a returned failure or
   cancellation was mislabelled as `STOPPED` there (and as `completed` after
   the native-vocabulary cutover).

**A fourth, previously uncatalogued producer** (found in this recount, not in
the #6982 pins — the two-pin list in the issue body undercounts the surface):
`StreamLogStore.endRunningEntriesInLoadedLogs` (`src/transcript/StreamLogStore.ts:446-485`),
reached through the public `endRunningGroups(status = END_GROUP_STATUS.ERROR)`
/ `endRunningGroupsForStreams(...)` API. This is the restart-repair /
orphan-sweep path that finalizes rows still `running` after a crash or
reload. Callers: `ProgressViewState.endRunningTaskGroups`
(`src/controllers/progressView/backend/ProgressViewState.ts:316-326`)
and desktop's `closeRunningTaskGroupsForStreams`
(`packages/desktop/src/main/desktopAgentExecution.ts:812-826`), both of which
already pass an explicit `EndGroupStatus` decided by restart-repair
classification — i.e. they too are folding a richer decision (crash → failed,
graceful-interrupt → cancelled) into the same 2-value string.

**Two independent legacy-tolerant read sites** parse a `GROUP_END` row's
opaque `data.status` back out today (no single boundary — this is the gap
§8.3 closes):

- `packages/extension/src/progressView/frontend/slices/logSlice.ts:82,109` —
  `isTaskGroupStatus(payload.status) ? payload.status : STREAM_STATUS.STOPPED`
  (live progress-view group rendering).
- `packages/trace-viewer/src/replayTrace.ts:116` —
  `StreamStatusSchema.safeParse(entry.data.status)` inside
  `toStreamLifecycleStatus` (historical trace replay/export).

**`GROUP_START` rows** write `data.status: 'running'` as a bare string
literal (`TexraTranscriptRecorder.ts:235`), not through any helper — this is
already the `StreamPhase.RUNNING`/`StreamStatus.RUNNING` string today
(the two vocabularies share the literal `'running'`), so it needs a type
change, not a value change.

**The frozen Tier-4 external contract** (`endGroupStatus` in the CLI's
headless JSON, `packages/cli/src/runtime/terminalStatus.ts:78`, called out in
§4 Tier 4) is a _fifth_ call site of `legacyEndGroupStatusForOutcome` and is
explicitly **out of scope** — it is a documented-deprecated frozen projection
for external scripts and stays byte-identical, deriving from `RunOutcome` the
same way after the cutover as before.

**Live-status `STREAM_STATUS`/`STREAM_STATUS_TRAITS` reader census — recounted
at HEAD, not trusted from the issue body.** The re-scope comment on #6982
claimed "~61 files"; an earlier scout comment on the same issue claimed 44.
Recount methodology: `grep -rlE` for `STREAM_STATUS\b|StreamStatusSchema\b|
\bStreamStatus\b` (the enum, its schema, and the type) unioned with call
sites of the four trait predicates (`isActiveStatus`, `isInFlightStatus`,
`isTerminalStatus`, `isLiveElapsedStatus`) that read `STREAM_STATUS_TRAITS`
indirectly, across `src/` and every `packages/*/src/`:

| Scope                                                                             | Count  |
| --------------------------------------------------------------------------------- | ------ |
| Direct `STREAM_STATUS`/`StreamStatusSchema`/`StreamStatus`, production files only | 29     |
| + trait-predicate call sites, production files only                               | **39** |
| Same query including `*.vitest.*`/`__tests__`/`test-kernel`                       | **70** |

None of the three numbers (44, "~61", or this recount's 39/70) agree, which
is itself evidence the number should never be hand-carried between issues
again — task 3 (§8.4 step 2) must re-run this grep at execution time, not
copy this table.

### 8.2 Native group-end/live-status row design (total mapping table, R4: no new vocabulary)

Two legacy vocabularies feed the rows this addendum retypes: the 7-value
`StreamStatus` (live status; also the `GROUP_START` row) and the 2-value
`EndGroupStatus` (the `GROUP_END` row only, itself asserted to be a subset of
`StreamStatus`'s 4-value `TaskGroupStatus` slice). Every legacy value below —
all 7 `StreamStatus` members plus the 2 (already-covered) `EndGroupStatus`
members — maps onto an existing `StreamPhase` (5 values: `running`,
`waiting`, `completed`, `cancelled`, `failed`) or `StreamSubstate` (2 values:
`starting`, `resuming`) member. No new type, value, or plane is introduced;
this is exactly the trim already worked out in §2's status-model table
(lines 376-409) and `streamStatusToPhase`/`streamStatusToSubstate`
(`src/shared/schemas/stream.ts:189-216`), which **already ship** — this
addendum's job is only to point _production_ at them, not to design them.

| #   | Legacy value   | Vocabulary                        | Live producer today                                                                                                | Native replacement                                                                         | Wire-value change?                                                                                                                                    |
| --- | -------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `RUNNING`      | `StreamStatus`                    | `GROUP_START` literal; live status writers                                                                         | `StreamPhase.RUNNING` (`'running'`)                                                        | No — identical string                                                                                                                                 |
| 2   | `WAITING`      | `StreamStatus`                    | live status only (no group-end producer)                                                                           | `StreamPhase.WAITING` (`'waiting'`)                                                        | No                                                                                                                                                    |
| 3   | `RESUMING`     | `StreamStatus`                    | live status only                                                                                                   | `StreamPhase.RUNNING` + `StreamSubstate.RESUMING`                                          | No — already the §2 design                                                                                                                            |
| 4   | `INITIALIZING` | `StreamStatus`                    | live status only (`tryAcquire` reservation)                                                                        | `StreamPhase.RUNNING` + `StreamSubstate.STARTING`                                          | No — already the §2 design                                                                                                                            |
| 5   | `STOPPED`      | `StreamStatus` / `EndGroupStatus` | `GROUP_END` default via `legacyEndGroupStatusForOutcome`'s non-error branch; `StreamLogStore` orphan-sweep default | `RunOutcome.COMPLETED` **or** `RunOutcome.CANCELLED` (was one string folding two outcomes) | **Yes — the fold splits.** Every real producer already holds the actual outcome; writing it directly is strictly more information, not new vocabulary |
| 6   | `ERROR`        | `StreamStatus` / `EndGroupStatus` | `GROUP_END` failed branch; `StageHandleImpl.run()` catch; `StreamLogStore` orphan-sweep `ERROR` default            | `RunOutcome.FAILED`                                                                        | No — 1:1                                                                                                                                              |
| 7   | `READY`        | `StreamStatus`                    | live status only; equals "no entry" (map-delete)                                                                   | absence (`undefined`)                                                                      | No — already the §2 design                                                                                                                            |

Concretely, for the `GROUP_END` row specifically: **`EndGroupStatusSchema`/
`END_GROUP_STATUS` is retired as a _production_ type.** `StageEndEvent.status`,
`StageHandle.end()`/`StageOptions.defaultStatus`, and
`StreamLogStore.endRunningGroups(status)`/`endRunningGroupsForStreams(status)`
all retype from `EndGroupStatus | undefined` to `RunOutcome | undefined`.
Every real call site already has (or can trivially be given) the actual
`RunOutcome`:

- `AgentRunLifecycle.ts:138` passes `outcome` directly — deletes the
  `legacyEndGroupStatusForOutcome` call entirely, no behavior decision needed.
- `AgentRunLifecycle.ts:369` passes `RUN_OUTCOME.CANCELLED` directly — same
  deletion.
- `TraceEmitter.ts`'s genuinely generic stage default becomes
  `RunOutcome.COMPLETED` on success, `RunOutcome.FAILED` on the `run()` catch
  branch. These stages have no local cancellation concept, so they only ever
  use 2 of the 3 `RunOutcome` members — that is a narrowing, not a new value.
- Cancellable round stages use the existing outcome-aware path: run their
  body under `StageHandle.within()`, derive the round's `RunOutcome`, and pass
  it explicitly to `StageHandle.end()` in a `finally` block. In particular,
  `ToolUseCycleNode` preserves completed, failed, and cancelled as three
  distinct `GROUP_END` values. `TraceEmitter` remains generic; it does not
  gain a round-specific callback or a second `run()` interface.
- `StreamLogStore`'s orphan-sweep default flips from unconditional `ERROR` to
  a caller-supplied `RunOutcome`; `ProgressViewState.endRunningTaskGroups`
  and desktop's `closeRunningTaskGroupsForStreams` already classify
  crash-vs-graceful-interrupt for `restart-repair` transitions elsewhere
  (§2's `StreamStatusMachine` `RESTART_REPAIR` cause table,
  `src/common/constants/streamStatus.ts:182-190`) — this cutover lets that
  same classification finally reach the transcript row instead of being
  discarded at the 2-value boundary.

This is the deliberate behavior change §5 already flagged ("the extension
webview starts distinguishing completed/cancelled") — this addendum shows it
lands at **stage 0** for the group-end row specifically (§2's migration list
had scoped it to stage 2, gated on the full `StreamStatusMachine`; the
transcript row does not need the machine to carry the extra bit).

`GROUP_START` rows: no value change (row 1 above), only the type at the
write site (`TexraTranscriptRecorder.ts:235`) moves from a bare string
literal to `StreamPhase.RUNNING`.

### 8.3 Boundary plan: two true boundaries — `StreamLogStore`'s persisted read, and the standalone trace-viewer's file import

Binding directive (maintainer, desktop-never-released + no-scattered-shims):
during the released-data window (CLI + VS Code extension both ship
historical transcripts with `data.status: 'error' | 'stopped'` group-end
rows), **the only legacy parse in the in-app path lives at `StreamLogStore`'s
read side** — everywhere else that loads through `StreamLogStore`, live or
persisted, gets canonical `RunOutcome`/`StreamPhase` values. The standalone
trace-viewer's file import is a separate concern outside this directive's
scope; it keeps its own boundary, registered at the end of this section.

**Today**, per §8.1, there are _two_ scattered legacy-tolerant parses instead
of one in the in-app path: `logSlice.ts:82,109` and `replayTrace.ts:116`.
Neither is the read boundary — `StreamLogStore.parsePersistedEntries`
(`src/transcript/StreamLogStore.ts:798-848`) is: it is the one function every
persisted row passes through — the `.safeParse(raw)` call itself sits at
`StreamLogStore.ts:823`, against the `PersistedStreamLogEntrySchema` union
_defined_ (not called) at `src/shared/schemas/log.ts:149-152` — before
entering the in-memory `StreamLog`, for both the extension's live progress
view (which rehydrates released streams via `ensureLoaded`/`load`,
`StreamLogStore.ts:228,631`) and the CLI's own transcript readers
(`packages/cli/src/chat/…`, `runtime/runExecution.ts`), which also load
through `StreamLogStore`. The standalone trace-viewer does **not** load
through `StreamLogStore` and is a separate boundary — see below.
`data` stays `z.unknown()` in that schema (correctly — Tier 3 in §4 already
documents `StreamLog` group-end rows as "opaque… display code pattern-matches
`status:'error'`"), so today's union does not — and after this cutover still
does not — validate `data.status`; the normalization is a _value_ transform
on top of the existing parse, not a schema change, and needs no persisted
format-version bump.

**Census correction (found while landing #8087, folded in here per that PR's
own recommendation):** the two live callers named above are not the only
`StreamLogStore` clients — `assembleTrace()`
(`src/transcript/traceAssembler.ts`) is a **third**, and it sits upstream of
the trace-viewer's input rather than downstream of it. It constructs a fresh
`StreamLogStore` instance and calls `.load()`/`.ensureLoaded()` on it to
build every exported `TraceDocument` — used by the CLI's single-file export,
the extension's history browser, and the settings-view chat export
(`ChatExportController`) — so it runs through `parsePersistedEntries` like
any other reader. Consequently, every `TraceDocument` `assembleTrace()`
builds after this boundary lands carries canonical `RunOutcome`/`StreamPhase`
values in its `GROUP_START`/`GROUP_END` rows, **including a re-export built
from pre-cutover on-disk history** — a genuinely externally-authored
`trace.json` that predates the cutover and is never reassembled keeps the
legacy 2-value strings forever (per the trace-viewer boundary below), so
`replayTrace.ts`'s `toStreamLifecycleStatus` has to read a
`StreamLogStore`-derived `TraceDocument` right alongside a legacy one without
knowing in advance which vocabulary it's holding. That consumer-side
handling already landed in #8087: `toStreamLifecycleStatus` parses the
terminal group's `data.status` with `StreamLifecycleStatusSchema` (the
already-shipped `StreamPhase`-or-legacy-`StreamStatus` union, §2), not the
narrower legacy-only `StreamStatusSchema` the original census described — see
`replayTrace.ts:105-116`. This is a census fix only: `assembleTrace()` is a
third _client_ of boundary 1, not a third _boundary_ — it does not change the
two-boundary count in this section's heading.

**Target:** extend `parsePersistedEntries` (or a transform run immediately
after it, before entries reach callers) so that any `GROUP_START`/`GROUP_END`
entry's `data.status` is normalized in place at load time:

- On-disk `'running'` → `StreamPhase.RUNNING` (row 1; string-identical,
  retype only).
- On-disk `'stopped'` → `RunOutcome.COMPLETED`. This is a **documented lossy
  default** for rows written before the cutover: pre-cutover `'stopped'`
  already could not distinguish `completed` from `cancelled` (row 5), so the
  boundary cannot recover information the old writer discarded. Choosing
  `COMPLETED` (not `CANCELLED`) matches today's rendering behavior — the
  extension already displays these rows as neutral "Stopped", closer in
  connotation to a normal finish than an interruption — so no historical
  transcript's _displayed_ label changes, only its typed value.
- On-disk `'error'` → `RunOutcome.FAILED` (row 6; 1:1, lossless).

**The live-emission path needs no parse at all — it is canonical by
construction, not by normalization, so §8.3's boundary story is not just the
persisted-read side.** `StreamLogStore.append()` (`StreamLogStore.ts:287-297`)
is the one entry point every live producer writes through
(`TexraTranscriptRecorder.ts:137,189,226,263`, which back the four §8.1
producers — `AgentRunLifecycle.ts:138,369`, `TraceEmitter.ts:212,300`, and
`StreamLogStore.endRunningEntriesInLoadedLogs`) — and `append()` never calls
`parsePersistedEntries`; only the disk-load paths do
(`ensureLoaded`/`load`/`loadStreamSummary`, `StreamLogStore.ts:228,631`).
`WebviewBridge` (`src/controllers/progressView/backend/WebviewBridge.ts:151`)
then streams these entries straight from the in-memory `StreamLog` to the
webview's `logSlice.ts` `LOG_DELTA` handler — no disk read, no parse,
anywhere on that path. Once step 1 retypes all four producers to emit
`RunOutcome`/`StreamPhase` directly (§8.2), every entry `append()` ever sees
is canonical the instant it is created; `parsePersistedEntries`'s
normalization exists solely to backfill rows that predate the cutover and
were already sitting on disk, not to process anything a live run produces
today or after.

That also answers the in-memory mixed-vocabulary question directly: because
step 1 retypes all four live producers in the **same PR** as the boundary
(§8.4 step 1), there is no rollout window in which some in-memory
`GROUP_END`/`GROUP_START` rows are canonical and others are still
legacy-typed. Every producer capable of writing a fresh row cuts over
atomically in that one PR; the only legacy-shaped rows any consumer can ever
observe afterward are ones that were already persisted to disk before the PR
merged, and those get normalized once, at load time, by
`parsePersistedEntries`. No consumer — live or persisted-read — sees a mix
of old and new vocabulary once step 1 ships.

Post-boundary, `StreamLog`/`StreamLogStore` and everything downstream that
loads through it — `logSlice.ts`, the CLI's own transcript readers — only
ever observe canonical `StreamPhase`/`RunOutcome` values, whether an entry
arrived live via `append()` or was rehydrated from disk via
`parsePersistedEntries`. `logSlice.ts`'s
`isTaskGroupStatus(...) ? ... : STREAM_STATUS.STOPPED` fallback becomes dead
code on that path (its `else` branch can no longer be hit by anything
`StreamLogStore` hands it) and is deleted as a mechanical follow-up once the
boundary lands and `logSlice.ts` is retyped to expect
`StreamPhase`/`RunOutcome` — not before, per the "consumers get canonical"
half of the directive (deleting the fallback before the boundary normalizes
would just move the crash site). That deletion is conditioned on **both**
of `logSlice.ts`'s callers going canonical, not just `StreamLogStore`'s —
see the standalone trace-viewer boundary immediately below, which also feeds
`logSlice.ts` and is not downstream of `parsePersistedEntries` at all.

**A second, independent true boundary: the standalone trace-viewer's file
import.** `packages/trace-viewer/` is not a `StreamLogStore` client at all —
its `main.ts`'s `loadTrace()` reads either an inlined
`window.__TEXRA_TRACE__` (the CLI's single-file export) or a fetched
`trace.json`, validates it through `parseTraceData`
(`packages/trace-viewer/src/traceDataSchema.ts`), and feeds the result
straight to `replayTrace()` (`packages/trace-viewer/src/replayTrace.ts:131`);
`StreamLogStore.parsePersistedEntries` never runs in that call chain —
`replayTrace.ts` only imports `TraceDocument` as a type. These exported
trace files are, by `main.ts`'s own doc comment, "externally-authored…
exported by whatever TeXRA version produced them" — a file exported before
this cutover ships stays on-disk in the legacy vocabulary forever; nothing
re-normalizes it retroactively, since a static exported JSON file never
passes through a live `StreamLogStore` instance again. That makes the
trace-viewer's import path a second, genuinely independent boundary, not a
downstream consumer of the first, and §8.3's opening directive ("the only
legacy parse lives at `StreamLogStore`'s read side") is scoped to the in-app
path only — it does not extend here. Concretely: `replayTrace.ts`'s
`toStreamLifecycleStatus` keeps its own `StreamStatusSchema.safeParse`
legacy-arm (`:116`) permanently, as this boundary's one owner of the
overall-run status. It does **not**, however, currently normalize the
individual `GROUP_START`/`GROUP_END` `data.status` values on the entries it
forwards — `replayTrace()` dispatches `trace.entries` verbatim into the same
`LOG_DELTA`/`logSlice.ts` pipeline the in-app live path uses (`replayTrace.ts:182`),
so those raw per-entry values land on `logSlice.ts`'s `isTaskGroupStatus`
fallback exactly as a pre-cutover on-disk row would. That means the
`logSlice.ts` fallback (previous paragraph) is not purely in-app dead weight
once `StreamLogStore` goes canonical — it is the shared landing point both
boundaries currently feed, and it can only be deleted once the trace-viewer
import path also normalizes per-entry `data.status` the same way
`parsePersistedEntries` does (a follow-up for whichever PR does the
trace-viewer's own cutover, out of scope for step 1 itself but recorded here
so the eventual `logSlice.ts` fallback deletion isn't done prematurely).
§8.4 step 3's acceptance-gate grep (R8) must count `replayTrace.ts`'s
`StreamStatusSchema.safeParse` as a second permitted survivor alongside
`StreamLogStore`'s boundary, not something to delete: deleting it would
break historical export files opened outside a running extension/CLI, which
is exactly the case this boundary exists to serve.

The Tier-4 frozen CLI JSON projection (`terminalStatus.ts:78`) is
unaffected: it derives `endGroupStatus` from `RunOutcome` via
`legacyEndGroupStatusForOutcome`, which stays alive as a **read-side/derive
helper** for that one frozen external contract — it is deleted as a
_production_ call at the three §8.1 sites, not deleted outright.

### 8.4 Cutover sequence: 3 PR-sized steps

Mirrors the parent issue's goal items 2-4. Each step is independently
shippable and each keeps CLI headless JSON byte-identical throughout (Tier 4,
§4/§8.3); the extension/CLI live displays are unaffected until step 1 lands
(new information, additive) and step 2 (mechanical retyping, no behavior
change per step).

**Step 1 — Production cutover (this document's design; §8.2).**
Retype `StageEndEvent.status`, `StageHandle.end()`,
`TraceEmitter.openStage({defaultStatus})`, and
`StreamLogStore.endRunningGroups*(status)` from `EndGroupStatus` to
`RunOutcome`; delete the three/four production call sites' use of
`legacyEndGroupStatusForOutcome` (§8.1 items 1-4); retype the
`GROUP_START` write site to `StreamPhase.RUNNING`. Land the
`StreamLogStore.parsePersistedEntries` boundary normalization (§8.3) in the
**same PR** — the boundary and the producer cutover must ship together, or
there is a window where in-memory rows use both vocabularies depending on
write date, which is exactly the "two vocabularies for one fact" class this
whole program exists to close. `EndGroupStatusSchema`/`END_GROUP_STATUS`
themselves are **not** deleted yet (`legacyEndGroupStatusForOutcome` still
backs the Tier-4 CLI projection, §8.3) — only their production role ends.
R6: net-negative at the three/four call sites (each drops a
helper-call-plus-import for a direct field reference); net-positive at the
boundary (~15-25 new lines for the load-time normalization + its round-trip
test). Net for the PR: roughly flat to slightly positive, not a reduction —
correctly so, since this step is a correctness/behavior improvement
(completed-vs-cancelled distinction), not a dead-code deletion.

**Step 2 — Migrate the live-status readers (goal item 3; mechanical after
step 1).** Re-run the §8.1 census grep at execution time (do not reuse the
39/70 table — it is a snapshot). For each of the ~39 production files,
replace direct `STREAM_STATUS`/`STREAM_STATUS_TRAITS` reads with the
`StreamPhase`-keyed equivalents (`isActivePhase`/`isInFlightPhase`/trait
helpers already exported from `src/common/constants/streamStatus.ts:130-146`
— these already exist and are already used by the transition-cause logic;
step 2 is pointing the remaining 39 files at them, not building them).
Per-host PRs as the parent issue specifies (CLI TUI, extension progressView,
desktop bridge — split because the files cluster by host and a single PR
touching all three risks the "collision with the active PR train" mitigation
already logged in §5). R6: each per-host PR is a like-for-like swap
(`STREAM_STATUS.X` → `STREAM_PHASE.X` at call sites already trait-gated), so
expect small negative-to-flat diffs per file, no structural growth.

The census also sweeps the **task-group status consumers**, which read the
group-end/group-start-derived status this addendum's step 1 retypes at the
source, not the generic per-stream status §2 already covers — call them out
explicitly so step 2's per-host PR authors don't miss them as "just more of
the 39": `TaskGroupSchema.status` (`src/shared/schemas/taskGroup.ts:10`,
typed `TaskGroupStatusSchema`) is the wire/state type `logSlice.ts`'s
`updateTaskGroups` populates from `GROUP_START`/`GROUP_END` rows (§8.3), and
`packages/extension/src/progressView/frontend/components/TaskGroupList.ts`
is its primary renderer — `getStatusIcon` (`:60-68`) switches on
`STREAM_STATUS.RUNNING`/`ERROR`/`STOPPED`, and the completion-sound check
(`:301-304`) compares `group.status` against `STREAM_STATUS.READY`/`STOPPED`.
Both retype to `StreamPhase`/`RunOutcome` in lockstep with `logSlice.ts`
itself, and `TaskGroupListIndex.vitest.ts` (already named in §8.5) is the
existing suite that pins `TaskGroupList`'s fixtures for this migration.

**Step 3 — Delete the legacy enums (goal item 4; original D1 task-3 list,
finally unblocked).** Once step 2 empties the reader census, delete
`STREAM_STATUS`/`STREAM_STATUS_TRAITS`,
`EndGroupStatusSchema`/`END_GROUP_STATUS`, and the
`legacyEndGroupStatusForOutcome`/`groupEndStatusForOutcome`/
`terminalStreamStatusForOutcome` helpers — except the read-shim forms the
D1 ledger (#6981) already dates for the tier-3 persisted-format shims
(`meta.json.taskState`, desktop `terminalStatus`, the boundary normalization
this step 1 added in §8.3, which **stays** as the permanent legacy-transcript
reader, not a temporary shim — released transcripts never get rewritten, so
this parse never ages out). `StreamStatusSchema` itself is in that same
surviving set, not fully deleted: `replayTrace.ts`'s `toStreamLifecycleStatus`
(§8.3's second boundary) keeps calling `StreamStatusSchema.safeParse`
permanently, so the schema stays exported for that one caller even after
every other production reader of it is gone. R8: consumer count is exactly
the step-2 output (should be 0 production readers of the deleted symbols
outside the two permitted boundary survivors — `StreamLogStore`'s
`parsePersistedEntries` normalization and `replayTrace.ts`'s
`StreamStatusSchema.safeParse` — both named in the D1 acceptance-gate grep).
R6: this step is the actual deletion payoff — net-negative, size M per the
parent issue's own estimate.

### 8.5 Test plan

Existing suites already pin group-end/transcript-boundary behavior and are
the ones step 1 extends (R7 — no new suites):

- `src/test-kernel/agent/followUp/ToolUseProgressEvents.vitest.ts` — pins
  `ToolUseCycleNode`'s round-stage closure for completed, failed, and
  cancelled classifications, including the corresponding literal
  `RunOutcome` in each persisted `GROUP_END` row.
- `src/test-kernel/agent/runtime/AgentRunLifecycle.vitest.ts` — pins the two
  `stage.end`/direct-transcript-write call sites (§8.1 items 1-2); extend
  with cases asserting the `GROUP_END` row's `data.status` is the literal
  `RunOutcome` value (`completed`/`cancelled`/`failed`), not the folded
  2-value string.
- `src/test-kernel/common/RunOutcomeAlgebra.vitest.ts` — the outcome-algebra
  suite (`deriveRunOutcome`/`projectRunOutcome`/the legacy helpers); extend
  with the retyped `legacyEndGroupStatusForOutcome` (now a Tier-4-only
  derive helper) staying correct, and delete assertions that depended on it
  being called from production sites once step 1 removes those calls.
- `src/test-kernel/transcript/TexraTranscriptRecorder.vitest.ts` — pins
  `stage.start`/`stage.end` → `GROUP_START`/`GROUP_END` row shape
  (`:244-256` today); extend for the `RunOutcome`-typed `data.status` and the
  `StreamPhase.RUNNING`-typed `GROUP_START` row.
- `src/test-kernel/transcript/StreamLog.vitest.ts` and
  `StreamLogStoreLoad.vitest.ts` — pin `StreamLogStore` load/round-trip
  behavior; extend `StreamLogStoreLoad` with the §8.3 boundary-normalization
  round-trip (`'stopped'`/`'error'` on disk → `RunOutcome.COMPLETED`/`FAILED`
  in memory) — this is the one new assertion class step 1 needs, added to an
  existing suite per R7, not a new file.
- `src/test-kernel/progressView/RestartRepair.vitest.ts` — pins the
  orphan-sweep/`endRunningGroups*` restart-repair path (§8.1 item 4); extend
  for the caller-supplied `RunOutcome` replacing the unconditional `ERROR`
  default.
- `src/test-kernel/desktop/DesktopAgentExecution.vitest.mts` — pins desktop's
  `closeRunningTaskGroupsForStreams` caller; extend alongside
  `RestartRepair.vitest.ts` for the desktop-specific classification path.
- `src/test-kernel/traceViewer/replayTrace.vitest.ts` — pins
  `toStreamLifecycleStatus`'s `GROUP_END`-row read (§8.1). Unlike
  `logSlice.ts`'s in-app fallback, `replayTrace.ts`'s legacy-string fixtures
  do **not** move to `StreamLogStore` fixtures or get deleted once the
  `StreamLogStore` boundary lands — the trace-viewer is §8.3's second,
  independent boundary and keeps tolerating both vocabularies permanently
  (exported trace files never pass through `StreamLogStore`). Step 1 only
  needs this suite unchanged; add cases here (or in a trace-viewer follow-up)
  once the trace-viewer's own per-entry `GROUP_START`/`GROUP_END`
  normalization (§8.3, flagged as future work) lands, not before.
- `src/test-kernel/progressView/LogDeltaTextDeltas.vitest.ts` — the one
  existing suite that drives `logSlice.ts`'s exported `logHandlers` directly
  (`:9`), today only over `STREAM_LOG_ENTRY_TYPES.LOG` fixtures; it does not
  yet exercise the `GROUP_END` handler (§8.1's other read site) — step 1 adds
  a `GROUP_END` case here (still R7: an existing suite gains a case, not a
  new file) asserting `isTaskGroupStatus`'s fallback is unreachable for
  entries sourced from `StreamLogStore` once the boundary normalizes — it
  stays reachable (and still needs coverage) for entries the standalone
  trace-viewer forwards unnormalized, per §8.3's second boundary.
- `src/test-kernel/progressView/TaskGroupListIndex.vitest.ts` — covers
  `TaskGroupList`'s rendering of hand-built `TaskGroup[]` fixtures (not
  `logSlice.ts`'s projection itself); listed for step 2 below since it
  constructs fixtures with `STREAM_STATUS` literals directly.

Per-host live-status suites for step 2 (named here so step 2's PR authors do
not have to rediscover them): CLI TUI's `src/test-kernel/cli/
TuiStateAndFocus.vitest.mts` (references `STREAM_STATUS` per §8.1's census);
the extension's `TaskGroupListIndex.vitest.ts`, which builds `TaskGroup`
fixtures directly from `STREAM_STATUS` literals.

### 8.6 Step 4 execution record (2026-07-29): what was deleted, and what is permanent

§8.4 step 3 (the parent issue's goal item 4) named one deletion list. On
execution the list split cleanly in three, and only the first part is a
deletion — recorded here so a future sweep does not re-open the other two as
outstanding debt.

**Deleted — provably dead, no released-data dependency.**

- `STREAM_STATUS_TRAITS` and everything derived from it:
  `streamStatusesWithTrait`, `StreamStatusTrait`,
  `LIVE_ELAPSED_STREAM_STATUSES` (`src/shared/schemas/stream.ts`). Membership
  questions are answered exclusively by the `StreamPhase` predicates
  (`isActivePhase`/`isInFlightPhase`/`isTerminalOutcomePhase`,
  `@shared/streams/streamStatus`) after steps 2-3. The last non-test consumer
  was `packages/cli/scripts/tui-harness.tsx`, migrated in the same change:
  the harness now seeds child rosters with `STREAM_PHASE` values, which is
  what production has written since #8317, so the harness is a faithful
  mirror again rather than the repo's last legacy-vocabulary producer.
- `groupEndStatusForOutcome` (`@shared/streams/streamStatus`) — the
  `'ok' | 'error'` intermediate hop. Its only caller was
  `legacyEndGroupStatusForOutcome` in the same file; the fold is now stated
  once, there.
- The trait-table pin in `RunOutcomeAlgebra.vitest.ts`, replaced by an
  exhaustive pin of the three `StreamPhase` predicates over
  `StreamPhaseSchema.options` — the membership fact keeps its coverage, on
  the canonical vocabulary.

**Permanent, not debt.** `STREAM_STATUS`/`StreamStatusSchema`/`StreamStatus`
and `END_GROUP_STATUS`/`EndGroupStatusSchema` stay, as §8.3 already ruled,
because two read boundaries never age out:

1. `StreamLogStore.parsePersistedEntries`'s group-status normalization —
   released transcripts are never rewritten.
2. The standalone trace-viewer's file import (`replayTrace.ts`'s
   `StreamLifecycleStatusSchema` parse and `StreamSnapshot.status`, plus
   `GroupLogPayloadSchema`'s legacy `EndGroupStatus` union member, which
   serves the raw `trace.entries` this boundary forwards into `logSlice.ts`)
   — a static exported `trace.json` stays legacy-shaped forever.

Their doc comments now say this in the enum's own definition, so the next
reader does not have to reconstruct it from the ledger.

**Still dated, deliberately not touched.** The remaining legacy _reads_ are
released-data compatibility with live removal triggers in the #6981 ledger,
not dead code: the frozen CLI headless JSON `endGroupStatus` projection
(`packages/cli/src/runtime/terminalStatus.ts`, v0.41 / 2026-08-04 whichever
is later — the only remaining caller of `legacyEndGroupStatusForOutcome`),
`streamStatusDisplay.ts`'s legacy display arm and
`sessionStatus.ts`'s legacy child-`stopped` label, and the `terminalStatus`
and `meta.json.taskState` tier-3 shims. These are what keep #7993's last
checkbox open; nothing above unblocks them.
