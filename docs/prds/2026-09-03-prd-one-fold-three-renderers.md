---
created: 2026-09-03
updated: 2026-09-03
---

# PRD: One fold, three renderers

**Status:** Proposed; requires owner ratification of the nine decisions in
section 17 before lane 2 starts. Decision 9 is the one to read first: it
rules that a `StreamTabId` names a run and is never reused, which is what
lets all thirteen incarnation fences earlier drafts had accumulated be
deleted rather than maintained. Its cost is that a relaunched workflow
appears as a new row instead of reusing its tab, stated in full there;
reverting is mechanical if the owner weighs that differently. Lane 1 needs
decisions 1 **and 9** - it implements the identity change, so starting on
decision 1 alone would ship an unratified one; lane 6 likewise needs
decision 7, which is what it implements.

**Decision in one sentence:** every process that shows a TeXRA session runs
the same pure fold over the same events into one `SessionView`, the
transport carries events and requests and never a view, hosts own only the
interaction state of one view instance, and the extension, desktop, and TUI
shells are rebuilt on that state in Effect, deleting the projection and
adapter layers that today make three hosts render three different pictures.

**Owner rules this PRD applies:** no dual systems; no projection or adapter
layers between state and pixels; the TUI, the desktop, and the extension
render the same state; cross-cutting minimized; the cleanest shape rather
than the cheapest; the new program is written in Effect to Effect's best
practice; users are theorists, so the unit of work is a paper.

**Lineage.** This PRD consolidates three proposals written on 2026-09-03
after two survey passes, five audits, three critique agents, and eight
adversarial attacks:
`docs/proposals/2026-09-03-conversation-shell-directions.md` (the shell
design and its boards),
`docs/proposals/2026-09-03-one-view-state-three-renderers.md` (the state
rule, version 2, with the Effect shape in its section 12), and
`docs/proposals/2026-09-03-projection-adapter-ledger.md` (every layer
classified). Where this PRD and those documents differ, this PRD governs.
Its companion is the persistence decision
`docs/proposals/2026-09-03-persistence-substrate-decision.md` (the event
table as the only persisted truth), written by the persistence cutover owner
after two rounds of alignment with this program. That document is in flight
in another branch and is not part of this pull request, so every "agreed
with the substrate owner" claim below is checkable only once it lands. This
PRD follows the governing rules of
`docs/prds/2026-08-26-effect-4-runtime-migration.md` (R1 to R3, R5 to R10).

---

## 1. Problem, measured

The hosts share a fact bus (`SessionEventHub`), one reducer into a
host-neutral `SessionState` (`src/controllers/session/SessionFactApplier.ts`),
and pure shared folds under `src/shared/` (`projectTranscriptRow`,
`taskGroupProjection`, `compactionActivityProjection`, `workflowRunModel`,
`streamStatusDisplay`, `streamOrdering`). After that point they diverge.

| Measure                                                               | Today                                                                                                                                                           |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hops for one fact ("stream description changed") to reach a component | 11 on the extension (fact, applier, renderer port, renderer, command, bridge, slice, signal, `willUpdate`, context, consume); 3 on the TUI                      |
| Copies of the state on the view side                                  | extension: `ProgressState` in 9 slices with `StreamState` re-merging backend fields (`store.ts:88`, `streamStateMerge.ts:29`); TUI: none                        |
| Renderer-port implementations                                         | 3: `LitSessionRenderer` (539 lines, 21 typed commands), `TuiSessionRenderer` (no-ops that bump revisions), `runProgressRenderer`                                |
| Facts computed twice (TUI and extension)                              | 6: settled-versus-live boundary, child-to-parent topology, child status and elapsed, approval-to-row mapping, child list order, run-model retained-phase filter |
| Owners of the active stream                                           | 3, across 59 files (`ProgressPresentationState.ts`, `progressState.ts:119`, `cliState.ts:319`)                                                                  |
| Wire commands                                                         | 244 in 7 groups; 35 exist only to move a value a state patch would carry                                                                                        |
| Lit contexts that only re-broadcast signals                           | 11 contexts, 2 providers, 10 consumers                                                                                                                          |
| UI-state stores for one concern                                       | 6 stores, 3 schema families                                                                                                                                     |
| Status-to-color mappings                                              | 11 sites, contradictory (running is success, yellow, or cyan by file), 2 dead selectors                                                                         |
| Terminal-state vocabularies                                           | 3 tables plus a fourth "Running", none importing another                                                                                                        |
| `HostInteractions` implementations                                    | 3: the shared GUI controller, the TUI, headless                                                                                                                 |
| Entry points into run or resume                                       | extension 4, desktop 2, CLI 5; launch validation entered 9 ways, 3 by raw schema parse                                                                          |
| Files from click to OS, "open a file"                                 | extension 11, desktop 12 (and the line number is dropped), CLI 0                                                                                                |

The extension is the outlier: it copies the state across the bridge as
commands and rebuilds it. The TUI is closer to the target: it keeps no
mirror and re-reads `SessionState` at paint.

The shell on top of this has the same shape: the extension sidebar swaps two
webview bundles in one slot (`MainViewProvider.switchMode`), the sidebar and
the editor tab are an exclusive target (`ProgressViewProvider.target`), the
desktop hand-wires its own conversation and rail (`renderer/main.ts:288-294,
1031-1080`), and the desktop is one workspace per process with a relaunch to
switch (`main/index.ts:577-596`).

## 2. Goals

1. One `SessionView` value, produced by one pure fold, identical in every
   process that shows a session: runtime, extension webview, Electron
   renderer, TUI, headless, SDK.
2. The transport carries the fold's input (events and text chunks) down and
   requests up. No view crosses a process boundary.
3. Hosts own a `Surface` (interaction state of one view instance) and
   nothing else.
4. One conversation shell on the extension and the desktop: New is the empty
   state of the conversation, sessions are a drawer or a docked list, one
   composer, hierarchy visible through rollups, breadcrumbs, and a dispatch
   card, a run board for multi-agent runs, and a Tools sheet for LaTeXDiffs
   and the media tools.
5. One desktop process holds one session per open paper.
6. Every layer named in the ledger is deleted in the same pull request as
   its replacement (R10).
7. Enforcement by construction where a type or a lint rule can make the
   dual unwritable; tests only where a name must be forbidden.

## 3. Non-goals

- Changing PocketFlow's state-machine authority (R4 of the migration PRD).
- Changing the persistence substrate; this PRD consumes the event table and
  the durable event set and adds to that set only what section 6 lists.
- A new UI framework. Components stay Lit and Ink.
- A second schema system. Zod remains the source of truth for data.
- Line-count targets. Prior convergence work landed net-positive when the
  duplicated surface was smaller than the seam replacing it; each lane
  measures before it is called a reduction.

## 4. Governing rules

**G1. One fold, everywhere.** `fold(view, input): SessionView` is a pure
function in `src/shared/session/` over `FoldInput`, the union of durable
events, live text chunks, and this process's local runtime state (5.2).
Every process that shows a session runs it, and the same inputs give the
same view in all of them. No process holds a mirror of another process's
fold output. The two non-durable arms are by definition local: a process
that does not own a run has fewer inputs and renders the settled prefix of
its text (7.2), which is a smaller input set, never a different reading of
the same one.

**G2. The transport carries input, never output.** Down: durable events and
live text chunks, seq ordered. Up: `runtime.request` and `host.request`. A
generic setter applying view patches is a second reducer imitating the
first and is not built.

**G3. Facts versus interaction.** A fact is derivable from the durable event
set and lives in the fold. Interaction state (selection, drafts, recording,
expansion overrides, focus, scroll, layout) lives in the renderer's
`Surface` and is never a session fact, never persisted as one.

**G4. Rows carry fact-only strings.** Every string that is a function of
facts alone (label, preview, one status label, `tone`, settled duration,
metadata parts, notices, copy) is on the row. Hosts carry every function of
width, locale, color depth, and the clock.

**G5. Replacement deletes.** A lane's pull request is not done until the
layers it replaces are gone.

**G6. Effect inside, Promises at the boundary** (migration PRD R1). One
`ManagedRuntime` per process at the existing entry. Components never import
`effect`. Zod for data; `Data.TaggedError` for errors; Effect Schema nowhere.

**G7. Construction over allowlists.** A dual is prevented by a type, a
single table, or a method on a scoped object where possible; a test only
where a field name must be forbidden.

## 5. The state

### 5.1 `SessionView`

Zod, in `src/shared/session/sessionView.ts`. Types by `z.infer`. Sketch;
field names are final unless marked.

```ts
SessionView = {
  // which session (paper) this view is of; one desktop process holds N
  key: SessionKey,
  streams: Map<StreamTabId, StreamView>,
  // top-level ids, streamOrdering rule
  order: StreamTabId[],
  // the last session commit ordinal folded (7.1)
  cursor: CommitOrdinal,
  // per-aggregate high-water mark: the last seq folded for each aggregate.
  // The fold's duplicate rule reads it (5.2) and a Subscribe's per-aggregate
  // fromSeq is copied from it (8.1); never a commit ordinal
  folded: Map<AggregateId, Seq>,
  // live text at SESSION scope, so it can arrive before its stream (5.2)
  inflight: Map<`${StreamTabId}/${RowId}`, string>,
  // paper-level aggregate; the desktop rail badge reads it and derives nothing
  rollup: { running: number, waiting: number, interrupted: number },
  // each carries streamId and requestId
  approvals: ApprovalRequest[],
  policy: Map<StreamTabId, ApprovalPolicySnapshot>,  // latest-of-type per run
  inquiries: InquiryThread[],
  // this process's local truth: a fold input, never durable, never persisted
  // wire type (8.1): arrays, never Maps - see the note under 5.1
  local: { self: OwnerId[], heldBy: OwnerId[],
           unreadable: { streamId: StreamTabId, detail: string }[] },
  queuedFollowUps: Map<StreamTabId, string[]>,
}

StreamView = discriminatedUnion('category', [ToolUseStreamView, WorkflowStreamView])
  // common
  id: StreamTabId
  executionId: ExecutionId                   // from run.start; 1:1 with id
  identity: RunIdentity | null              // null only for legacy imports
  // launch facts from the run.start payload, never derived (5.2)
  isRemote: boolean
  ownerId: OwnerId | null                    // owner of the latest durable event
  // agent name or fallback from id prefix
  label: string
  // the AI one-liner; title when present
  description: string | null
  model: string | null, modelLabel: string | null
  worktree: WorktreeInfo | null              // from run.start payload
  status: StreamStatus, substate: StreamSubstate | null, statusDetail: string | null
  statusLabel: string, tone: Tone            // G4; one table
  // immutable; the commit ordinal of this incarnation's run.start
  createdAt: CommitOrdinal
  runStartedAt: number | null, lastTimestamp: number | null
  conversationProgress: ConversationProgress
  stage: StreamStage | null
  followUpSupport: UserFollowUpSupport
  parentId: StreamTabId | null
  // root first; evicted parent keeps its last label
  ancestors: { id: StreamTabId, label: string }[]
  childIds: StreamTabId[]                    // streamOrdering rule
  rollup: { total: number, running: number, finished: number }
  approval: 'none' | 'own' | 'descendant'
  // this process cannot act on it: another live owner, or unreadable (5.2)
  readOnly: boolean
  // true when this stream or any descendant needs the user; hosts read it
  // instead of re-deriving, and it outranks a collapsed override (5.2)
  forceExpanded: boolean
  group: 'running' | 'waiting' | 'interrupted' | 'recent'
  usage: RunUsageMap
  context: ContextStateData | null           // latest `context.state`
  transcript: TranscriptView
  // toolUse arm; goal is per stream (GoalStore.getForStream)
  todos, plan, goal, outputs, missingOutputs, compileFailures
  // workflow arm
  files, missingOutputs, compileFailures

TranscriptView = {
  rows: TranscriptRow[],                     // projectTranscriptRow, exhaustive
  taskGroups: TaskGroup[],                   // taskGroupProjection
  compaction: CompactionBlock[],             // compactionActivityProjection
  settledSeq: CommitOrdinal,                 // last session ordinal folded
  settledRows: number,                       // contiguous settled prefix
  // workflow arm; retained-phase filter folded in
  run: WorkflowRunModel | null,
}
```

`SessionView` holds `Map`s because it never crosses a bridge - only events,
chunks, and `local` do (8.1). Every type that _is_ on the wire uses arrays
and records, so nothing depends on a `Map` surviving `JSON.stringify`; the
same rule governs the persisted `Surface` (9).

Four aggregate kinds, one key shape, one placement rule (contract C2). The
event key is `(aggregate_id, seq)`, and **every fact lives on the aggregate
of its logical target**, so a latest-of-type lookup never has to
disambiguate targets and no key column exists. Run-scoped trace facts and
the stream's own lifecycle facts use the stream as their aggregate:
`run.start` (seq 1), the trace `AgentEvent`s, the status fact, `goal`
(`GoalStore.getForStream` is keyed by stream), the queued-follow-ups
snapshot (`UpdateQueuedFollowUpsPayload` and `FollowUpSentPayload` carry
`streamId`, `progressEvents.ts:133-139`, and `queuedFollowUps` above is
keyed by stream), and `stream.removed` (today's `removeStream` fact,
renamed in lane 1, section 6), which is the **last row of its own
aggregate** and, in the same transaction, sets `event_sequence.closed = 1`
(C9). The agent runtime's flow rows, named by
`2026-09-04-agent-runtime-on-effect.md` section 2.1 (`model.message`,
`model.compaction`, `tool.intent`, `tool.result`, `flow.step`,
`flow.snapshot`; that section also says which of a run's two aggregates each
row lives on), use the execution as their aggregate, with the
execution-to-stream edge on `run.start`. An inquiry thread's facts
(`inquiryThreadUpdated`, parented or not) use an aggregate whose id is the
thread id. The **one session aggregate** per paper carries singleton session
facts only (C2 names a session-level goal as its example); a fact that can
have more than one live instance never goes there, because after two
deletions a latest-of-type read of one aggregate would see only the newer
tombstone and resurrect the older stream. `SessionView` reads each
session-scoped field from the aggregate its type declares, and the fold's
`sessionScoped` arm keys on the envelope's aggregate id, which is why no
sentinel stream id exists: an unparented inquiry has a thread id. A
transcript subscription therefore names **aggregates**, not streams: the
stream aggregate and, through the edge on `run.start`, its execution
aggregate, each with its own `fromSeq`, because the two sequences are
independent and one number could not resume both (7.1, 8.1, contract C7).

Types that die when this lands: `StreamTabInfo`, `StreamMetadata`, both
`StreamState` variants, `StreamExecutionState`, `SessionStreamMetadata`,
`ActiveChildInfo`. They were four slices of one record.

`SessionState` (the class in `src/controllers/session/SessionState.ts`)
stays a class because it owns stores and lifecycle; it gains `view:
SessionView` and loses its metadata cache and its own topology.

### 5.2 Fold rules

The fold's input is `FoldInput = SessionEvent | TextChunk | LocalRuntimeState
| TranscriptSubscriptionSet`. Two rules govern the first arm before any fact
below applies. **Duplicates:** the fold drops any `SessionEvent` whose `seq`
is not above `view.folded` for its aggregate and advances that entry
otherwise. The three reads of 7.1 overlap by construction - a listing fact
is also row seq 1 of its aggregate, so `aggregate(id, 0)` replays the
`run.start` that `listing()` or `all()` already delivered, and the `all()`
tail carries every subscribed aggregate's rows a second time - and the
high-water mark is what makes the second copy a no-op, including for
`run.start`, which is not idempotent under the fold. The transcript fold
already upserts rows by id (`sessionFold.ts`, `upsertRow` over `rowIndex`),
so a duplicated transcript row would be harmless on its own; the seq rule is
stated for the facts that are not. **Residency:** a transcript row (a trace
row or a flow row) for an aggregate outside the subscription set is dropped;
its listing facts fold regardless. The set is the fourth arm, a
`SubscriptionRef` (`TranscriptSubscriptions`, 7.2) whose every change is a
fold input, and when an aggregate leaves it the fold drops that stream's
`rows`, `taskGroups`, `compaction`, and `run`, and the aggregate's `folded`
entry, keeping every listing fact.
Every fact below derives from the durable events of section 6 except owner
liveness, which is process state and not an event: the runtime's lease
reader (`executionLease.ts`, a pid probe on the lease owner) emits an
`LocalRuntimeState` snapshot - the owner ids whose lease this process may
not touch, and the streams it could not read (see "Unavailable" below) - on
every change and on every subscribe, and the fold keeps the latest snapshot
in `local`. A foreign process dying produces no event and no lease-file
change - its claim stays on disk, and `proveOwnerLiveness` runs only when
something inspects or claims (`executionLease.ts:369-373`) - so the runtime's
lease reader **re-probes held foreign owners on an interval** and emits a
new snapshot when a verdict changes. Without that wake, `heldBy` never
moves in an already-open process and the dead owner's run stays read-only
and running forever, which is the state Resume exists to leave. `self` holds this
process's owner id and never a lease token: `claimLease` mints a fresh UUID
per claim (`executionLease.ts:519-525`), and that token is the lease's
internal fencing token, compared only inside the lease against the claim it
fenced; it is not an owner id and never reaches an event envelope, `self`,
or `heldBy`. A process running two executions stamps one owner id on both
runs' events, and both fold as its own. `heldBy` is the lease's own
predicate, not "alive": a lease is
`held` when its owner is alive **or unprovable**, and nothing automatic
reaps an unprovable one - only an explicit deletion does
(`executionLease.ts:38-41, 164-172`). Defining it as known-alive would label
a stream on another host `interrupted` and offer a Resume that cannot
acquire the lease. The snapshot is transient like a text chunk: never
durable,
never a seq. A replay with no snapshot folds with `local` empty, so
every pending approval reads as interrupted until the runtime says
otherwise, which is the safe direction. Agreed with the substrate owner on
2026-09-03 (the companion proposal, in flight).

**Liveness is probed per owner process, never per run.** An owner id
names a process (pid plus process start time, the cutover's
`event_sequence.owner_id`), and one process owns every run it launched, so
the lease reader probes the distinct owner ids present in the session's
tail - a handful - and never one lease per run. `local.self` and
`local.heldBy` are therefore sets of owner-process ids, and the waiting
group (below) reads liveness through them; a fold input computed any other
way is wrong, not slow. This reconciles the startup-repair proposal's S3
with the waiting rule (substrate owner, 2026-09-04). The value is derived by
the substrate at insert time from the process, never supplied by the
emitter, so it cannot be forged or forgotten by a new emit site; there is
no per-handle owner token, because the only question asked of an owner id
is "is this owner alive" and a token could not be probed without a second
table mapping tokens to processes. With one database per root and one
session per paper (11) there is at most one handle per process per
database, so a token would distinguish nothing; two handles on one root in
one process is a guard at handle construction, not an owner-id axis. Until
the cutover, the runtime stamps the same process identity on the envelope
it hands the fold.

- **Existence** is decided by the stream's own aggregate (contract C2, C9):
  `run.start` and `stream.removed` are the first and the last row of one
  lifecycle on one aggregate, and the stream exists iff its aggregate holds
  a `run.start` and no `stream.removed`. Both rows carry the stream as their
  target, so no cross-aggregate comparison is needed and no key column
  exists. Deletion is a durable tombstone rather than a physical row
  removal - the `delete` and `deleteAll` requests (8.2) append
  `stream.removed` as the aggregate's last row, and the same transaction sets
  `event_sequence.closed = 1`, the one schema addition (C9); the publisher
  checks that flag in the write transaction it already holds, so a late fact
  for a removed stream is refused in O(1), and retention deletes closed
  aggregates. The tombstone is a listing fact: `listing()` returns it as the
  aggregate's latest `stream.removed` and `all()` carries it in the tail, so
  it reaches every process (7.1) - and **a tombstone is final**. Nothing supersedes it:
  a relaunch after a deletion mints a fresh `StreamTabId` and carries the
  deterministic workflow name as a label (decision 9), so it is a different
  stream, no later event can target the closed one, and nothing has to tell
  one incarnation of an id from another. A stream therefore has exactly one
  `run.start`, at seq 1, and exactly one lifecycle. That is exactly what `_streamIncarnations` and its
  compare-on-remove exist for today (`SessionState.ts:133-148`), and both go
  with it - as does every `{ streamId, executionId }` pairing successive
  review rounds added to this document before the id itself was fixed.
  Physical removal is retention's business and takes a stream's rows only
  together with its tombstone. The event table has two coordinates and they do different
  jobs. `seq` is per **aggregate** - a stream id, an execution id, an inquiry
  thread id, or the one session aggregate for singleton facts (5.1, C2); an
  `inquiryThreadUpdated` with a null `parentStreamId` rides its thread
  aggregate, so no sentinel stream id exists. `commit` is a single
  session-wide ordinal assigned under the publish permit (7.1): it is the
  insert order a replay must follow, and it is what `SessionCursor` is - one
  number, not a map. Every row carries both. `seq` serves the per-aggregate
  reads and the duplicate rule above; `commit` serves every ordering
  question across aggregates - a child's `run.start` against its parent's,
  the two aggregates of one transcript (7.2) - and `settledSeq` among them
  is a commit ordinal, not a `seq`, because a stream's transcript spans two
  aggregates whose seqs are not comparable. Every stream kind gets one:
  agent, process (`bash@tool`), workflow script, through `RunIdentity.kind`.
- **Category, remote-ness, and owner** are launch facts on the `run.start`
  payload (section 6, item 6). `RunIdentity` deliberately does not encode
  `AgentCategory` (its header comment in `runIdentity.ts` says so), and
  remoteness is a registry lookup (`isRemoteAgent` at
  `streamTabInfo.ts:57-63`) that a browser fold cannot make, so the fold
  reads both from the payload and derives neither. `ownerId` is the
  process identity of the writer (pid plus process start, the `owner_id`
  the substrate stamps at insert, contract C5), never a lease token; it
  rides on every durable event's envelope and `StreamView.ownerId` is the
  latest one, so a resume in another process moves ownership without a new
  fact kind.
- **`group === 'interrupted'`** iff the stream is non-terminal and
  `stream.ownerId` is in neither `local.self` nor `local.heldBy` - whether or
  not an approval is pending. Both sets, because the lease model calls this
  process's own claim `owned` and only another process's `held`
  (`executionLease.ts:164-172`): testing `heldBy` alone would fold every run
  this process is currently executing to `interrupted`. `self` and `heldBy`
  together are "somebody holds this"; the two stay separate only so
  `readOnly` can ask the narrower question of _who_. Owner loss is the whole condition: a process that crashes
  mid-generation commits no terminal status, so conditioning this on a
  pending approval (as an earlier draft did) would leave every ownerless run
  reading `running` forever, with no Resume offered and no repair until some
  later restart. A pending approval is then simply the case where the loss is
  most visible, not a separate rule.
- **`group === 'waiting'`** iff an `approval.requested` exists without its
  `approval.resolved` AND `stream.ownerId` is in `local.self` or
  `local.heldBy`. Without a
  live owner it is `'interrupted'` by the rule above, never `'waiting'`,
  because nothing is listening for the answer; `'interrupted'` is the fourth
  arm of the union (5.1) and the group a host offers `resume` on. Resume appends `approval.resolved` (cause: interrupted) for every
  unresolved request on the stream **before** it starts, on the same path
  that clears the previous run's terminal state
  (`clearTerminalExecutionState`, `executeAgent.ts:541`). Without that, the
  resumed owner reappears in `local.heldBy` and the orphaned request
  folds the stream back to `waiting` for an answer no runtime is listening
  for - and, because resume keeps the stream and the execution id, nothing
  later retires it. Compensating at the boundary is the same shape as the
  failed reservation's terminal status in section 6; scoping approvals to a
  generation the fold retires would add a concept to carry the same fact.
- **`goal`** is per stream, on the toolUse arm. Today's
  `GoalStore.getForStream` and the `goalStateChanged` fact are keyed by
  stream id, and concurrent streams hold independent goals; one session
  field would let one stream's goal event overwrite another's.
- **`approval`** is `'own'` when the stream itself is waiting, `'descendant'`
  when any descendant is. Expansion is forced - **over a collapsed
  override** - by a
  pending approval and equally by an interrupted descendant, the two states
  that need the user (see `rollup`). The fold projects that condition as
  `forceExpanded` on every stream on the path, so a host expands by reading
  one named field instead of walking descendants for approvals and
  interrupted runs itself. The fold cannot clear the collapsed override -
  `Surface.expanded` is the renderer's - so the **surface** drops its
  override for a path when `forceExpanded` turns true. Without that the
  override merely sleeps: the moment the approval resolves and
  `forceExpanded` goes false, the parent snaps shut again on a path the user
  has just been working in. An override applied on top would let a parent the
  user collapsed earlier stay closed when a child later asks for a decision
  or loses its owner, and since `rollup` deliberately carries neither count
  there would be nothing else on screen to show it - a blocked or resumable
  run with no visible cause. The override governs only a path with nothing
  below it that needs the user.
- **`rollup`** counts descendants by status. It has no waiting count and no
  interrupted count, because both expand the path: the invariant is that **a
  collapsed parent never hides a row that needs the user**, and the two
  things that need one are a pending approval and an interrupted,
  resumable run. Expansion is forced for either, over any collapsed override
  (see `approval`), which is why neither needs a count to stand in for it.
- **`ancestors`** walks `parent`; an evicted parent contributes its last
  known label. A bare id suffices because ids are never reused (decision 9):
  a relaunched deterministic parent is a different stream and cannot adopt
  the previous run's children. A child whose `parentId` names a stream the
  view does not have - a tombstoned parent, most often - is **top-level**: the fold sets its
  `parentId` to null, so it joins `order`, shows no ancestors, and the
  composer's "reply to parent instead" (12.1) cannot address a stream that
  no longer exists. Leaving the link dangling would keep that action
  pointing at a permanently unavailable target. Deleting a parent therefore cannot hide
  its children **in the view**. The runtime side of detachment stays: the
  deletion path still calls `session.executions.detachActiveChildren(parent)`
  (`createSessionStores.ts:30-44`), which performs `activation.detach()`,
  `handle.detach()`, and approval detachment
  (`executionRegistry.ts:580-603`) - live handles and approval ownership do
  not re-root by rule. What the fold's rule replaces is only the durable
  `setParentStream` **event** that path emits afterwards to project the
  edge, which a tombstone now makes unnecessary.
- **`order`** and `childIds` use `streamOrdering` (newest creation first,
  ties by name), keyed on `createdAt` - the commit ordinal of the stream's
  `run.start`, which is immutable and already monotone. `runStartedAt` goes
  null outside active phases and `lastTimestamp` moves with every event, so
  neither can place a re-rooted child among existing siblings without
  replaying history.
- **`executionId`** comes from `run.start`, is 1:1 with the stream id, and
  never changes. A workflow's resume anchor is its `checkpointId`, also on
  the `run.start` payload, not its execution id (decision 9). A resume keeps
  the execution id rather than minting one: `executeAgent` passes
  `resume.executionId`
  straight back into `buildAgentLaunchContext` (`executeAgent.ts:541-549`),
  because the checkpoint, the lease, and every execution-scoped store live
  under it. The fold carries it only because `RunIdentity` deliberately does
  not, and the execution-scoped requests of 8.2 (`skip`, `retry`, `kill`)
  name it.
- **Unavailable.** Two conditions read as unavailable today and they are
  not the same kind of fact. A stream whose lease is held by another live
  process is now _derivable_: `ownerId` is not this process and is in
  `local.heldBy`. Either way the stream is **read-only here**, and the
  fold says so in one field: `readOnly` is true when `ownerId` is in
  `local.heldBy` and **not** in `local.self`, or when the stream is in
  `local.unreadable`. The held test matters: once the previous owner exits,
  its lease is reclaimable, so the stream is `interrupted` **and
  actionable** - marking every foreign `ownerId` read-only would hide the
  Resume on exactly the runs a restart is meant to recover. Without it a
  second process renders the ordinary approval panel for a decision only
  the owning process can deliver, and every action comes back `NotOwner`
  (7.6) - an invitation to act that cannot work. A stream whose run state
  this process could not read at
  startup (`markUnavailable` with `streamUnreadableMessage`,
  `restartRepair.ts:232-240`) is genuinely local - another process may read
  the same run fine - so it belongs to the same transient arm as liveness,
  as an entry in `local.unreadable`. It is an **overlay**, not a write:
  `statusDetail` keeps the latest durable detail and the row displays
  `local.unreadable[stream] ?? statusDetail`. Overwriting the field would
  lose the durable detail with no event to replay when the hold clears, so
  the stream would keep a stale unreadable message or lose its real one. The
  entry names the incarnation it observed, like every other stream
  reference (decision 9): otherwise a hold recorded against a retired run
  would render its relaunched successor read-only with Delete as its only
  action. That is
  why the arm is `LocalRuntimeState` and not `OwnerLiveness`: it was always
  "what this process knows that the events cannot say", and liveness was
  only its first field. A stream in `unreadable` renders read-only with
  Delete as its one action. Today the hold lives in
  `StreamStatusService`'s process-local map and reaches the UI through
  `holdState` (`LitSessionRenderer.ts:429`, `childExecutions.ts:98`), which
  no webview fold can call.
- **`context`** is latest-of-type over `context.state`, already a canonical
  run fact. Both renderers show it live today - `UsagePanel` through
  `ToolUseStreamContent` and `WorkflowStreamContent`, and the TUI status
  bar's occupancy gauge - and it is cumulative-per-run, not derivable from
  `usage`.
- **`policy`** is latest-of-type over the approval-policy snapshot events.
- **Residency is two-tier** (contract C8). Listing facts - identity,
  description, outcome, status, group, and the rollup inputs - come from
  **latest-of-type indexed queries** over the event table, never from
  folding whole transcripts. One listing fact is a **set**, not a latest:
  a stream's pending approvals are every `approval.requested` on the
  aggregate without a matching `approval.resolved`, keyed by `requestId`,
  an indexed query over the same `(aggregate_id, type, seq)` index rather
  than a latest-of-type lookup, because a stream with two outstanding
  requests would lose the older one the moment the newer resolved; the
  `approvals` list, the waiting group, and the rollup all read that set.
  Transcript rows fold only for **subscribed** aggregates, through
  `aggregate(id, fromSeq)` (7.1) from each aggregate's own seq, and the
  `all()` tail's rows for any other aggregate are dropped at the fold's
  input (the residency rule at the top of this section). Without
  this rule every listing is a fold of all history and the residency
  problem of #9952 returns. The subscription set is a fold input, not a
  property of the reads: when an aggregate leaves the set the fold evicts
  that stream's `rows`, `taskGroups`, `compaction`, and `run`, so opening
  and closing transcripts leaves no history behind, and the listing facts
  of that stream stay exactly as they were. The rule binds the runtime's
  subscription set (7.2) exactly as it binds a webview's (8.1, 9): the fold
  fiber in the runtime holds the listing tier for every stream and the
  transcript tier for the aggregates some surface has subscribed, and
  nothing else.
- **`settledSeq`** is the last **session commit ordinal** folded for the
  stream, not a per-aggregate seq; text deltas do not advance it.
  Per-aggregate it would be unusable as a memoization key for exactly the
  reason `transcript.run` needs the ordinal (below): a stream's transcript
  spans its stream aggregate and its execution aggregate, whose seqs are
  independent, so the key would move backward or collide as rows from the
  two arrive. The per-aggregate seqs live in `view.folded` (5.1) and serve
  the duplicate rule and the `fromSeq` of a resubscribe (8.1), never
  ordering. It is a memoization key, **not** a
  print boundary: a status change or a usage event advances it
  while the row above is still open. `settledRows` is the separate frontier:
  the **contiguous leading prefix** of rows whose finalizing event has
  folded, not a count of them, which is what `advanceSettledPrefixIndex`
  already computes by stopping at the first unfinished row
  (`transcriptFold.ts:160-175`). That is what the TUI prints into
  append-only scrollback (12.3). Using `settledSeq` would print a row a
  later checkpoint or `stream.end` still changes; using a count would print
  a still-streaming row 1 the moment row 2 finalized.
- **Incremental.** One rule, keyed on what a change _names_. A durable event names the
  streams its _type_ declares - not `event.streamId`, which an inquiry
  fact does not have: `setParentStream` names its `childStreamId` and its new
  parent, an unparented `inquiryThreadUpdated` names none. That mapping is
  exhaustive and already written: `sessionFactStreamIds`
  (`SessionFactApplier.ts:116-125`) is the function, and the fold takes it
  over rather than reinventing it - with one addition it cannot make, since
  the payload does not carry it: on a `setParentStream` the fold also names
  the child's **prior** parent, read from the view before the event applies.
  A `stream.removed` names its prior parent for the same reason: the fold
  recomputes the deleted stream's arm first, after which the edge is gone,
  so the old parent would keep the deleted child in its `childIds`,
  `rollup`, and memoized run model forever. Without both, the walk starts
  at the new relationship - or at none - which is the two-chain requirement
  below. A fact naming no stream still folds - it
  updates session-level state such as `inquiries` - it simply names no arm.
  A **lifecycle** event (`run.start`, `stream.removed`) additionally names its
  stream's subtree: a child's
  placement is derived from whether its parent exists, so deleting a parent
  re-roots its children and shortens every descendant's `ancestors` (see
  `ancestors` above). That walk is O(subtree) and happens only when a parent
  appears or is tombstoned. A `LocalRuntimeState` snapshot names the symmetric
  difference against the previous one: the streams whose `ownerId` entered or
  left `heldBy`, and those entering or leaving `unreadable` - so an owner
  exiting recomputes exactly the streams it owned, not the view. A
  `TextChunk` names its row's stream. For each named stream the fold
  recomputes its arm, then
  walks `parent` to the root updating each ancestor's `childIds`,
  `rollup`, `approval`, and `group`, then `order` when a top-level stream
  appeared or changed status. An event that _changes_ `parent` walks two
  chains, the old and the new: detach is a real runtime transition
  (`onChildrenDetached` emits `setParentStream` with a null parent,
  `createSessionStores.ts:30-44`), so a child's parent genuinely moves and
  the abandoned branch would otherwise keep the child in its `childIds` and
  its `rollup` forever. The old parent needs no extra bookkeeping: the fold
  holds it in the view until the event applies. Cost is O(depth) per named
  stream and the named set is bounded by what actually changed, never a
  whole-view pass. `transcript.run` is memoized on
  `(streamId, commitOrdinal, childRevision)` - the **session** ordinal, not
  `settledSeq`: `seq` is per aggregate (above) and a transcript spans two,
  so a per-aggregate key can stay unchanged or repeat across the two and
  return a stale board.
  `childRevision` is bumped
  on the ancestor walk only when a field `childProgress` consumes changes -
  status, call count, usage - never on a text chunk. Bumping it on any arm
  change would rebuild every ancestor's run model per token in a workflow
  with streaming descendants, which is the opposite of memoizing it. `settledSeq`
  alone is not enough: `workflowRunModel` consumes `childProgress` to build
  `liveOf`, so a child's status, call count, or usage changing leaves the
  parent's model stale until an unrelated parent event arrives - and the
  walk that has to bump it is already visiting every ancestor.
  Recomputing `workflowRunModel` over a whole transcript per event would be
  quadratic.
- **Legacy.** The fold has no legacy arm and no event carries a
  `StreamLogEntry`. The importer normalizes each old entry into the
  canonical events of section 6 at the import boundary, where
  `TraceStreamLogEntrySchema` (`streamLogEntry.ts:185-189`) already parses
  the exported-trace format: the CLAUDE.md rule is that a legacy format is
  normalized once at the entry point and downstream code never branches on
  a format version, and the fold is the most downstream code there is. An
  entry the canonical set cannot express is dropped by the importer with a
  `warn` naming its type, never silently. Legacy streams have
  `identity: null` and a label from the id prefix, as today. The exported
  trace format itself stays a permanent read boundary for the trace viewer
  and is untouched by this PRD (decision 5).
- **Live text.** Text and thinking deltas are not durable, and a positionless
  delta cannot say whether it appends or replaces. `TextChunk` is therefore
  `{ streamId, rowId, from, to, text }` - an append that carries its own
  offsets into the row's in-flight text, the transient analogue of `seq`.
  One rule covers every case, and it reads `to` before `from`: **ignore a
  chunk whose `to <= length`** (already applied), otherwise **truncate at
  `from` and append `text`**, with `from > length` a defect rather than a
  repair path. Reading only `from` is not idempotent - after
  `{from: 0, to: 3}` and `{from: 3, to: 6}`, redelivering the first would
  truncate `abcdef` back to `abc` and put the next chunk at
  `from: 6 > length`, stopping live output on a duplicate. With `to` a
  redelivery in any order is a no-op, a `from: 0` chunk covering the row
  replaces it, and two adjacent chunks merge into one exactly - `from` of
  the first, `to` and concatenated text of the second - which is what lets
  the framer coalesce instead of drop (7.4). Replacement needs no second
  arm. `settledSeq` never moves.
- **Settled text is in the event.** A chunk is transient, so the finalizing
  event must carry the row's complete text or a replay - and any non-owning
  process - loses it. Today it usually does not: `TraceEmitter.finalize()`
  computes `this.finalText` from its private chunk buffer but emits
  `stream.end` with `finalText: undefined` unless the caller passed the text
  explicitly (`TraceEmitter.ts:370-387`), which the common no-argument form
  and thinking streams do not. Lane 1 makes it mandatory: `stream.end`
  carries the joined text it already computed, and the `phaseOnly` guard
  stays as-is because a phase-only stream has no text to carry.
- **Text is never checkpointed** (contract C4). Deltas are transient in the
  owning process; the finalizing event carries the whole text and is the
  only durable writer. A crash before it loses the in-flight message, and
  the resumed run's repair path appends a durable finalization for every
  row it finds open, so replay never reconstructs a never-terminated row. A
  non-owning process renders the settled prefix (7.2).
- **In-flight text is its own map, so order does not matter.** Chunks
  accumulate in `SessionView.inflight`, keyed by stream and row at **session
  scope** - not inside `StreamView`, which would give a chunk nowhere to
  live while its stream is still unfolded, and dropping it would put the
  next delta at a nonzero `from` against empty text. Session scope is what
  makes the claim true rather than nearly true: text accumulates whether or
  not the stream exists yet, which it routinely does not during a webview's
  replay; a row renders by joining
  its durable fields with its in-flight entry, and the entry is dropped when
  the row's finalizing event lands. A chunk arriving before its creating
  event is therefore not a problem to order around - it simply has nowhere
  to render until the row appears, and then it is already there. Ordering the
  two arms is not available anyway: the producer can append before it
  streams, but the fold's two inputs are separate streams and the table drain
  is asynchronous, so emission order is not delivery order. A consumer-side buffer
  ordered against the event stream would need an eviction policy of its own;
  keying the text by row ties it to the stream lifecycle instead. An entry
  goes when its row's finalizing event folds, when its stream's terminal
  status folds (a run can end with a row unfinalized - a crash, an abandoned
  interrupt), or when `stream.removed` closes the stream. Those three cover
  every way a row stops being live, so nothing needs a timeout and nothing
  accumulates in a long-lived process.
- **Durable text wins.** At the other end, a chunk is a preview of a row the
  durable events will settle, so a chunk for a row whose finalizing event has
  already folded is discarded rather than reopening its `inflight` entry, and
  `stream.removed` clears every session-level entry keyed by its stream -
  `inflight`, the stream's pending `approvals`, its `queuedFollowUps`, its
  `policy` entry, and its `inquiries`. Not only the text: a pending
  `approval.requested` with no `approval.resolved` would otherwise fold back
  into `approvals` on every replay as an actionable decision for a stream
  that can never exist again. A chunk that arrives
  afterwards - the two arms are asynchronous, so one can - is **dropped at
  the source**, in every process: `TextChunkSource` suppresses queued and
  later chunks for a stream once that stream's `stream.removed` has been
  published, and the transport framer applies the same rule to what it
  frames. It has to be both: §7.2 feeds the runtime, TUI, and headless folds
  from `TextChunkSource` directly, so a rule living only in the framer would
  leave an in-process late chunk recreating an `inflight` entry that nothing
  can ever finalize - and the in-process view would diverge from the webview
  one. That is the one place where
  "already tombstoned" and "not started yet" are both observable, and it
  keeps the fold's single rule intact - text accumulates whether or not its
  stream exists - with no tombstone set and no exception. An earlier draft
  put a `closed` list in the fold instead, which needed a drain boundary the
  fold has no input to see: dropping on absence alone would discard valid
  opening text and put the next delta at `from > length`. Without the clear,
  an entry for a stream that can never render or finalize would sit in the
  session map forever. That makes the merge order of the three arms (7.2)
  irrelevant by construction: a late chunk cannot mutate settled text, and
  an early one is overwritten when its event lands. Without the rule the
  same two inputs give two different rows in two processes.
  `LocalRuntimeState` is the other transient arm.

### 5.3 The row

`TranscriptRow` (`src/shared/transcript/transcriptRow.ts`) gains, per G4:
`statusLabel` from the one table, `tone`, settled `durationText`, and model
booleans for the three predicates copied byte for byte between hosts today
(`(no output)`, `showAsError`, exit-on-failure; `toolFormatters.ts:67, 106,
131-136` and `toolRenderers.tsx:171, 354, 361-365`). Live elapsed stays a
host call to one shared `(row, now)` formatter. `streamStatusDisplay.ts`
gains a `tone` column and becomes the only file mapping a status to a tone
word; the three terminal-state vocabularies (`streamStatusDisplay.ts:73-75`,
`workflowCallProgress.ts:182-188`, `historyRunStatus.ts:19-21`) become one
in `src/shared/copy/`.

## 6. Events

The only contract between this PRD and the persistence cutover is section
6.1 of `docs/proposals/2026-09-03-persistence-substrate-decision.md`
(clauses C1 to C10, jointly owned, changes land there first); this document
references its clauses and does not restate them. That document lands in its
owner's pull request, not this one; until it merges, the clause numbers here
refer to its working-tree draft dated 2026-09-04. The durable event set below
is C3's view from the fold's side. Emission for everything is `SessionHandle.events` and
`SessionEventHub`; no new bus emit (CLAUDE.md event-channel rule).

Agreed additions and changes (substrate owner, 2026-09-03):

1. **`approval.requested` and `approval.resolved`**, run-scoped
   `AgentEvent`s; resolved carries the request id. Payload is what the UI
   shows (diff, command, question), never host handles. Today these travel
   only on the `HostInteractions` port, so a pending approval does not
   survive a restart.
2. **`approval.policy`**, run-scoped, carrying the full policy snapshot
   after a change, emitted by the single policy authority
   (`src/shared/approvalPolicy.ts`, pinned by
   `approvalPolicyAuthorityRatchet.vitest.ts`). The **initial** snapshot is a
   field on the `run.start` payload rather than a separate event at the
   reservation commit: without it a never-edited run has no entry under the
   latest-of-type rule (5.2) and its bypass controls read blank, and emitting
   it as its own event would need an ordering rule against `run.start`, which
   resets the incarnation's state. On the payload it is atomic by
   construction. The authority still owns the value in both cases. Never a toggle delta. Deletes
   `UPDATE_BYPASS` and the five bypass mirrors.
3. **`run.start` moves to the reservation commit point** (where
   `AgentLaunchContext.ts:412-421` emits `setActiveStream` today) and is the
   existence fact. The terminal fact is the one that exists today - the
   canonical `status` fact reaching a terminal `StreamPhase`, published by
   `StreamStatusMachine` and durable in the cutover's event table like
   every other fact. There is no `run.end` event and this PRD does not add
   one. A launch that fails after reservation already transitions to
   `STREAM_PHASE.FAILED` on that same failure path
   (`compensateActivatedFailure`, `AgentLaunchContext.ts:582-587`), so a
   reserved-but-never-run stream folds to failed, never to a ghost. The failure-compensation boundary
   (`AgentLaunchContext.ts:602-605`) and the tombstone-reopen gate
   (`SessionFactApplier.ts:286-300`) are re-keyed on `run.start` plus live
   owner evidence.
4. **`worktree`** (nullish) is a field on the `run.start` payload. The
   launcher has the cwd before the reservation commit and the lookup is
   cached (`streamInfoUtils.ts:24-42`); the fold never shells out. Legacy
   imports carry null.
5. **`setActiveStream` is deleted** as a fact and as a payload. It fused
   stream creation, a metadata hint, and a focus request
   (`SessionFactApplier.ts:671-690`); creation is `run.start`, the hints
   are payload fields (item 6), focus is `Surface.select`.
   `suppressViewSwitch` was two things fused: a launch fact and a focus
   request. The launch fact survives as `background` on the `run.start`
   payload - a delegated child is launched in the background whoever is
   watching (`childStream.ts:174-178`), and the frozen NDJSON wire's
   `setActiveStream` line carries it, so the projection needs it to stay
   byte-identical (10.3). The focus request is `Surface.select` and travels
   with the surface, never as an event. The
   frozen NDJSON wire keeps its `setActiveStream` line - the CLI projection
   emits it from `run.activate` (item 8) and from nothing else. Not from
   `run.start`: a resume mints no start, so that mapping would drop the line
   on a resumed run, and a first launch emits both events, so keeping both
   mappings would emit it twice. Deleting the internal fact does not touch
   the contract.
6. **`category`** and **`isRemote`** are fields on the `run.start`
   payload, and **`ownerId`** is on every durable event's envelope,
   `run.start` included: stamped by the substrate at insert from the
   writing process (contract C5), never passed by the emitter (5.2). `category` is
   on **every** run, not only agent runs: it is the discriminant of
   `StreamView` (5.1), and `AGENT_CATEGORIES` is exactly the two arms
   (`agent.ts:19-22`), so an agent-only field would leave a `process`
   (`bash@tool`) or workflow-script `run.start` unable to select one. The
   launcher knows it in all three cases - from the run config for an agent,
   `toolUse` for a process, `workflow` for a workflow script - and the fold
   derives nothing.
   Today `StreamIdentityFields` (`stream.ts:227-228`) carries both
   beside the identity, sourced from the config, and the tab derivation
   recomputes remoteness (`streamTabInfo.ts:57-63`).

7. **Invalidation hints become snapshots.** `goalStateChanged` carries only
   a `streamId` and the applier answers it by re-reading `GoalStore`
   (`SessionFactApplier.ts:339-340`); `updateQueuedFollowUps` and
   `followUpSent` are handled by `renderer.invalidate(streamId,
'queuedFollowUps')` (`:344-350`). A browser fold has neither store, so
   both fields would fold empty and a replay could not reconstruct them.
   Each event carries its post-mutation snapshot instead - `Goal | null`
   and the queued-message list - emitted at the mutation boundary, the same
   correction item 2 makes for the policy and item 5 makes for
   `setActiveStream`. The general rule for lane 1: an event that says
   "something changed, go look" is not a fact, and every remaining session
   fact is audited against it. `inquiryThreadUpdated` is the third case and
   the largest: its payload is a summary (`threadId`, status, preview,
   timestamps, a count) while the panel needs the open turn's question,
   context, attachments, session links, and transcript - which
   `ExternalInquiryRequestHandler.replayOpenPermissions` recovers from the
   manifest today and lane 4 deletes. External inquiries are non-blocking,
   so `approval.requested` does not carry them either. The event carries the
   open turn's snapshot, normalized at the storage boundary, or a reload
   leaves an open inquiry no surface can render or answer.

8. **`run.activate`**, emitted at every activation - the first launch and
   each resume - carrying the activation metadata (`category`, `isRemote`,
   `background`); the activating process's `ownerId` is on its envelope
   like every other event's (C5). `run.start` stays the creation fact and is
   emitted once per incarnation; activation happens many times on one
   incarnation, which is why the two cannot be the same event. This is what
   the frozen wire's `setActiveStream` line projects from, one to one.
   A launch appends `run.start` and its first `run.activate` in **one
   transaction** - `publish` takes a batch for this - because a process
   failure between them would leave a durable run whose exported trace has
   no activation line, and the wire is byte-identical or it is not. Later
   activations are ordinary single appends. It carries no incarnation fence
   and needs none, because its stream id names one run (decision 9):
   `AgentLaunchContext` emits that line on every activation and it carries
   `agentCategory` and `isRemote`, which a `status` fact does not have and a
   projection attached at `SessionEvents.now` cannot recover from a
   historical `run.start`.

**Rename, cut before add (lane 1).** The tombstone this document calls
`stream.removed` is today's `removeStream` session fact
(`SessionEventHub.ts:55`), which the applier, the CLI projection, the
child-stream tool, the leftover sweep, and their tests still emit and match
by that name. Lane 1 renames the discriminator to `stream.removed`, and every
producer and consumer with it, in one pull request before the fold lands;
otherwise deletion events would not match the fold's lifecycle arm and a
removed stream would stay visible. The frozen NDJSON wire keeps its existing
`removeStream` line byte-identical: the projection maps `stream.removed` to
it (10.3), the same way `run.activate` keeps the `setActiveStream` line.
This is a rename of an existing fact, not a ninth event change; the count
above stays eight.

**Durability before the cutover (substrate owner, 2026-09-04).** No new
durable fact lands on `main` before the event table exists.
`TexraTranscriptRecorder.ts` (`:815-818`) is an exhaustive switch over
`AgentEvent`; if `approval.requested`, `approval.resolved`, the policy
snapshot, or any other event of this section were persisted into
`streamLogs/` there, it would be a new legacy shape the importer has to
read: a datum with a file writer today and an event writer later. Until the
cutover they are live-only: the recorder maps them to no persisted entry,
and lane 1 ships them that way. A pending approval not surviving a restart
is today's behavior, so this is no regression; the first process that
persists them is the cutover's `SessionEvents.publish`.

There is no `stream.text` checkpoint (contract C4). An earlier revision
added one so an owner crash mid-response would keep the partial text that
`StreamLogStore` recovers today; the substrate owner ruled it a second
writer for one datum. The completed message event is the only writer of
text, and kill -9 loses the in-flight message, as every peer accepts.

The importer emits `run.start` for every legacy stream with `identity`
nullish where the descriptor has none, and normalizes every other old
`StreamLogEntry` row into the events above (5.2, "Legacy"). No
`legacy.entry` event kind exists.

## 7. Effect services and layers

Verified against the installed `effect@4.0.0-rc.112`. Appendix A lists every
API with its import and a note. The guides and the source clone are a beta
older than the installed package; the installed package wins.

### 7.1 `SessionEvents`

```ts
// src/controllers/session/SessionEvents.ts
class SessionEvents extends Context.Service<
  SessionEvents,
  {
    // an ordered batch, committed in one transaction (see run.start, 6.8)
    readonly publish: (events: readonly SessionEvent[]) => Effect.Effect<void>;
    // Three reads (C7), nothing else.
    // the cold listing hydrate (C8): the latest-of-type row per aggregate
    // for the listing fact types plus the outstanding-approval set, one
    // indexed query; never a transcript row; completes, no tail
    readonly listing: () => Stream.Stream<SessionEvent>;
    // every event with commit > fromCommit, in commit order across
    // aggregates, then the tail. Transcript rows of unsubscribed aggregates
    // included: the live tail, and the frozen NDJSON projection's read (10.3)
    readonly all: (fromCommit: SessionCursor) => Stream.Stream<SessionEvent>;
    // one aggregate's rows from `fromSeq`, in seq order, then the tail. An
    // AggregateId is a stream id, an execution id, an inquiry thread id, or
    // the session aggregate (5.1); a subscriber opens one per aggregate it
    // names (7.2, 8.1)
    readonly aggregate: (
      aggregateId: AggregateId,
      fromSeq: Seq,
    ) => Stream.Stream<SessionEvent>;
    // the session's current commit ordinal: where a tail attaches
    readonly now: Effect.Effect<SessionCursor>;
  }
>()('@texra/session/SessionEvents') {
  // runtime processes: the durable table is the source of truth
  static readonly durableLayer = Layer.effect(
    SessionEvents,
    Effect.gen(function* () {
      // a LEVEL, not an edge: the last commit ordinal THIS process appended.
      // It is the AUTOINCREMENT `commit` ordinal (C1), the only number space
      // a cursor lives in; nothing else is ever compared against it.
      const ticks = yield* SubscriptionRef.make(0 as CommitOrdinal);
      const gate = yield* Semaphore.make(1);
      // provided by the persistence cutover
      const durable = yield* DurableWrite;
      const publish = Effect.fn('SessionEvents.publish')(function* (events) {
        // uninterruptible: a commit that wakes nobody is a stall every live
        // subscriber carries until something else commits
        yield* gate.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              // assigns seq, INSERT under BEGIN IMMEDIATE
              const at = yield* durable.appendAll(events); // last ordinal
              yield* SubscriptionRef.set(ticks, at);
            }),
          ),
        );
      });
      // cross-process wake (C7): `PRAGMA data_version` is connection-local,
      // moves only when ANOTHER connection commits, and resets on reconnect.
      // It is a TRIGGER, never a level in the commit space: compared only
      // with its own previous sample, and a change means "read forward",
      // nothing more. ONE poll per database, forked once here in the
      // layer's scope, never one per drain: it fans out through one
      // SubscriptionRef that counts observed foreign changes, and every
      // drain subscribes to that. A SubscriptionRef replays its current
      // value on subscribe, so a drain's first wake is an unconditional
      // forward read and no foreign commit can land between the sample and
      // the read
      const foreignChanges = yield* SubscriptionRef.make(0);
      yield* Effect.forkScoped(
        Stream.tick(dataVersionPollInterval).pipe(
          Stream.mapEffect(() => durable.dataVersion),
          Stream.changes,
          Stream.runForEach(() =>
            SubscriptionRef.update(foreignChanges, (n) => n + 1),
          ),
        ),
      );
      const foreign = SubscriptionRef.changes(foreignChanges).pipe(
        Stream.map(() => 'foreign' as const),
      );
      // "the table moved": this process's commit level and the foreign
      // trigger. Neither carries events, and subscribing to either replays
      // its current value immediately, so no commit can slip between a read
      // and a subscribe
      const wake = Stream.merge(SubscriptionRef.changes(ticks), foreign);
      // ONE ordered read per tier: the table, read forward from the caller's
      // position, once per wake that can mean new rows. `read` is the tier's
      // window and `pos` its coordinate (commit for `all`, seq for
      // `aggregate`); `high` is the highest commit ordinal this drain has
      // delivered, the one value a local level is compared against
      const drain =
        <P>(
          read: (from: P) => Stream.Stream<SessionEvent>,
          pos: (e: SessionEvent) => P,
        ) =>
        (from: P) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const at = yield* Ref.make(from);
              const high = yield* Ref.make(0 as CommitOrdinal);
              const forward = Stream.unwrap(
                Ref.get(at).pipe(
                  Effect.map((c) =>
                    read(c).pipe(
                      Stream.tap((e) =>
                        Ref.set(at, pos(e)).pipe(
                          Effect.andThen(
                            Ref.update(high, (h) => Math.max(h, e.commit)),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              );
              return wake.pipe(
                // a foreign trigger always reads forward; a local level at or
                // below what this drain has delivered says nothing. A level
                // says "there is more", not "there is one more", so a burst
                // of intermediate levels collapses into one further read
                Stream.filterEffect((w) =>
                  w === 'foreign'
                    ? Effect.succeed(true)
                    : Ref.get(high).pipe(Effect.map((h) => w > h)),
                ),
                Stream.flatMap(() => forward, { concurrency: 1 }),
              );
            }),
          );
      // the cold listing hydrate (C7, C8): one indexed query, latest-of-type
      // per aggregate for the listing fact types plus the outstanding
      // approvals; never a transcript row; completes, so it is not a drain
      const listing = () => durable.readListing();
      // every row above a commit ordinal, in commit order (C7): the tail
      const all = drain(
        (c) => durable.readAll(c),
        (e) => e.commit,
      );
      // one aggregate's rows from a seq, in seq order (C7)
      const aggregate = (id, fromSeq) =>
        drain(
          (from) => durable.readAggregate(id, from),
          (e) => e.seq,
        )(fromSeq);
      return { publish, listing, all, aggregate, now: durable.now };
    }),
  );

  // webviews: no database, no publish; the bridge's frames are the source
  static readonly transportLayer = Layer.effect(
    SessionEvents,
    Effect.gen(function* () {
      // this session's frames: the port is demultiplexed once, above (7.4)
      const frames = yield* SessionFrames;
      return {
        publish: () => Effect.die(new Error('webview cannot publish')),
        // the runtime ran the three reads for this Subscribe (8.1) and the
        // framer forwards their rows; each read here is that read's frames
        listing: () => frames.listing(),
        all: (fromCommit) => frames.events(fromCommit),
        aggregate: (id, fromSeq) => frames.aggregate(id, fromSeq),
        // a webview never attaches live-only; it subscribes with a cursor (8.1)
        now: Effect.die(new Error('webview has no table')),
      };
    }),
  );
}
```

One ordered source per tier, and it is the table. The hub used to carry
events and be merged with a cross-process feed; two concurrent sources
cannot be put back in order by a dedupe, and the interleaving is real - this
process can read another's seq N, commit N+1, and deliver N+1 before the
feed delivers N, folding a stale snapshot over a fresh one. So the hub now
carries no payload at all: it is a wake, saying only that the table moved,
and every subscriber reads forward from its own position. `all` reads every
row in session **commit order**, every aggregate interleaved - not per
aggregate, which would let facts on different aggregates fold in an order
their commits contradict: a child's `run.start` before its parent's, or a
parent's tombstone before the `run.start` of the child it re-roots.
`listing` is the cold hydrate and completes: one indexed query, no tail.
`aggregate` reads one aggregate's rows in seq order. The three reads
overlap - a listing fact is also seq 1 of its aggregate, and the `all` tail
carries every subscribed aggregate's rows again - and the fold's duplicate
rule (5.2) drops any row whose seq is not above `view.folded` for its
aggregate, so a `run.start` that `listing()` delivered and `aggregate(id,
0)` replays is a no-op rather than a second creation. That rule is the only
dedupe: there is no `dedupeBySeq` pass, no reorder buffer (a transcript row
is placed by the commit ordinal it carries, 7.2), and no replay-then-tail
seam, so the "subscribe before you read" invariant and its scoped queue are
gone.

The local wake is a **level, not an edge**, and the distinction is
load-bearing. An edge signal must be armed before the read, or a commit
landing between the read's snapshot and the subscription is lost forever -
and `concat` does not subscribe to its second stream until the first
completes, so the obvious shape has exactly that hole. A `SubscriptionRef`
replays its current value on subscribe, so the loop reads "read forward,
then wait for a level above the one I read at" and no ordering of subscribe
and read can lose a commit. That is why this process's half is a counter
rather than a `PubSub` - and why it holds the **commit ordinal**
`durable.appendAll` returns rather than a private tally: it is compared
against the commit ordinals of the rows the drain has delivered, and a tally
in another number space would either run ahead, filtering real levels as
stale, or start behind an existing database and filter every local wake
until it caught up. One coordinate, again (5.2).

The cross-process wake is **not a level** and is never compared against
that coordinate. `PRAGMA data_version` (contract C7) is connection-local: it
moves when another connection commits, does not move for this connection's
own commits, and resets on reconnect, so its value means nothing in the
`commit` number space. It is a trigger: the poll keeps its previous sample,
and a change means only "read forward from where you are", after which
`all(cursor)` (or the open `aggregate` reads) pick up whatever the other
process committed. Merging it into the level filter - as an earlier
revision of this block did with a `durable.commits` counter - is exactly
the mistake the trigger reading avoids: once a cursor is past the small
connection-local value every later change is filtered as stale and the
reader goes silent for the life of the connection. There is one poll per
database, forked once in the layer, and it fans out through one
`SubscriptionRef` counter to every drain; a drain never polls on its own,
so a session with several subscribed aggregates costs one `PRAGMA` per
interval, not one per read. The counter replays on subscribe, so a drain's
first wake is a forward read and a foreign commit between the subscribe and
that read still shows, and a wake that finds no new rows costs one indexed
read per drain.

Being a level also means a subscriber need not see every value. The drain
reads forward to exhaustion and then waits for a level **above the one it
read at**, so a burst of commits during a read collapses into one further
drain rather than one indexed empty read per queued wake - which is the
behaviour a `PubSub` could not have given, since every edge would have had
to be delivered.

Decision 6 is **resolved by contract C7** (2026-09-04): the cross-process
wake is the `data_version` poll above, a trigger followed by `all(cursor)`,
and the only level is the `AUTOINCREMENT` `commit` column (C1), which never
decreases or reuses a value. The earlier argument is kept for what it rules
out. The alternative was a **monotone commit counter** exposed by the store
and merged with the local level. Anything merged into that filter may not
over-report - reporting 100 while the table is at 50 advances the shared
`n > seen` filter past ordinals 51-100, and no wake ever arrives for them -
and may not go backwards or reuse a value: a WAL frame count is reset by a
checkpoint, `MAX(rowid)` falls when retention deletes the highest row and,
without `AUTOINCREMENT`, reuses the value afterwards, and `data_version`
itself is connection-local and resets. Every candidate for a second level
failed one of those tests, which is why there is no second level: a level
that can go backwards is worse than a poll, because it looks reliable, so
the foreign signal is a trigger the level filter never sees. Without a
foreign wake at all a process that only reads goes stale whenever another
process owns the run, since a seq gap is only visible once a _later_ row for
the same stream arrives locally.

The durable write is in the publish path, under the same permit as seq
assignment and the wake, so seq order and insert order cannot diverge and
no subscriber persists anything. The permit section is
`Effect.uninterruptible`, so neither an interrupt nor a failure can land
between the append and the wake: the append either fails before anything is
visible, or it commits and the wake fires. The hub is unbounded because
bounded parks the publisher behind the slowest subscriber, which would
stall the durable write path; with a payload-free wake there is nothing to
lose by coalescing anyway. Backpressure lives at each transport framer
(7.4).

`SessionCursor` is one number - the last session commit ordinal folded - and
it is a field of the view (`cursor`). Both properties matter. A single
ordinal is what makes `all` a globally ordered scan of the listing tier
rather than a per-aggregate merge, and being a field rather than a projection of `view.streams`
is what keeps it monotone: derived from the visible streams it would drop a
tombstoned stream's position the moment `stream.removed` folded, and the next
wake would re-read from the start, resurrecting the stream and its approvals
in the intermediate states `Stream.scan` publishes, forever. An ordinal
never regresses because it is not a function of what is visible.

That ordinal is also the local level of 7.1: a wake says "this process's
last commit is N", the reader asks for everything above its own position,
and a foreign trigger asks the same question without naming a number.
`all(view.cursor)` is the resubscribe; the transcript tier resubscribes per
aggregate from its own `fromSeq`, that aggregate's entry in `view.folded`
(8.1).
**Read path, corrected 2026-09-04.** An earlier revision of this section
had no per-aggregate read method and read everything through
`all(cursor)`; a later one narrowed `all` to listing rows. Neither holds.
The first breaks the two-tier residency rule (5.2): a listing that folds
every stream's transcript is #9952 again. The second breaks the frozen
NDJSON projection (10.3), which needs every event, transcript rows of
unsubscribed streams included, or `stage.start` lines go missing and
same-type updates collapse before a drain. The read path is therefore the
three methods in the block above (contract C7): `listing()` is the cold
listing hydrate, the latest-of-type row per aggregate for the listing fact
types plus the outstanding-approval set, one indexed query that completes
and never returns a transcript row; `all(fromCommit)` is every event above
a commit ordinal in commit order, then the tail, and is what the fold's
live tail and the NDJSON projection read; `aggregate(aggregateId, fromSeq)`
is one aggregate's rows from a seq, opened by `SessionViewService` (7.2)
for each aggregate in its subscription set and closed when that aggregate
leaves the set. A transcript subscriber names aggregates, not streams - the
stream aggregate and, through the edge on `run.start`, its execution
aggregate, each with its own `fromSeq` (5.1, 8.1) - and cold hydration is
`listing()`, then `aggregate(id, 0)` per named aggregate, then `all(now)`,
with the overlap between them absorbed by the fold's duplicate rule (5.2).
The listing facts (status, parent, removal, inquiry) come from `listing()`
and then the `all` tail, so a subscriber always holds both tiers. The
precise shape of the key, the ordinal, the cursor, and the three
reads is the jointly owned contract with the substrate proposal
(`2026-09-03-persistence-substrate-decision.md`, section 6.1), and this
document references that section rather than restating it; where the two
disagree, the substrate proposal wins on storage shape and this document
wins on what the fold consumes. The rc.112 names used above -
`Stream.unwrap`, `Stream.flatMap`, `Stream.tick`, `Stream.mapEffect`,
`Stream.changes`, `Stream.filterEffect`, `Ref.make`/`Ref.get` - are verified
against `node_modules/effect/dist`; the v3 `toQueueScoped` and
`unwrapScoped` are gone and are no longer needed here.

Two layers implement this one shape. `durableLayer` runs in the extension
host, the desktop main process, and the CLI, and is the only one that
resolves `DurableWrite`. `transportLayer` runs in a webview, where there is
no database and no publisher: it decodes the `EventsFrame`s of 8.1 through
`SessionFrames`, the one service a webview's process layer provides. Three
of its fields are fold arms - `events` (the rows of whichever read the
runtime ran for this subscriber, each tagged with its read), `chunks`,
`local` (7.2) -
and the fourth is `host`, which is not a fold arm at all: the decoder
publishes it into a `HostState` service (a `SubscriptionRef` the shell's
components read as a signal), because it is host data, not session state
(8.1, 9). Without that fourth field the frame would carry the snapshot with
nowhere to put it. A webview that reaches for `publish` is a defect, not a
silent no-op: it issues a `runtime.request` (8.2) instead.

`SessionFrames` takes no `SessionKey`, because it _is_ one session's frames.
A webview has one `postMessage` port and N open papers, so the port is
demultiplexed exactly once, where the frames are decoded: the bridge reads
`frame.session` and hands the frame to that session's `LayerMap` entry
(7.3), which builds its own `SessionFrames` over its own stream. Below that
one point the key is not a runtime value any code can compare wrongly, so a
fold consuming another paper's events is unrepresentable rather than
filtered against. The alternative - one process-wide frame stream plus a
`session` argument on every read - is precisely the shape in which
overlapping stream ids or cursors can cross papers, with a filter left to
be trusted at each call.

### 7.2 `SessionView`

```ts
// src/controllers/session/SessionView.ts
class SessionViewService extends Context.Service<
  SessionViewService,
  {
    readonly ref: SubscriptionRef.SubscriptionRef<SessionView>;
    readonly changes: Stream.Stream<SessionView>;
  }
>()('@texra/session/SessionView') {
  static readonly layer = Layer.effect(
    SessionViewService,
    Effect.gen(function* () {
      const events = yield* SessionEvents;
      // lease reader in the runtime; the frames' local field in a webview
      const liveness = yield* LocalRuntimeSource;
      // the delta path in the runtime; the frames' chunks field in a webview
      const chunks = yield* TextChunkSource;
      // the subscription set (5.2, 8.1): the aggregates some surface holds a
      // transcript subscription on, each with its own fromSeq. Written by the
      // subscribe handler in the runtime and by the shell in a webview. It
      // is a SubscriptionRef because it is a fold input: every change of the
      // set folds, and an aggregate leaving it evicts its transcript state
      const subscriptions = yield* TranscriptSubscriptions;
      // the key is the layer's, not an input: no fold arm carries one.
      // SessionKey IS the workspace root that keys the LayerMap (7.3).
      const roots = yield* WorkspaceRoots;
      const empty = emptySessionView(roots.workspace);
      const ref = yield* SubscriptionRef.make(empty);
      // where the tail attaches, captured BEFORE the cold reads so nothing
      // can commit between them and the tail; the overlap this creates is
      // dropped by the fold's per-aggregate seq rule (5.2)
      const now = yield* events.now;
      const initial = yield* SubscriptionRef.get(subscriptions);
      // transcript tier: one `events.aggregate(id, fromSeq)` per subscribed
      // aggregate, opened when the set gains it and closed when the set
      // loses it. `switchMap` interrupts the previous set's reads; an
      // aggregate still in the set reopens from its entry's fromSeq, which
      // is that aggregate's entry in view.folded (8.1). The stream and
      // execution reads of one transcript interleave freely here: every row
      // carries its commit ordinal and the fold places it by that, so
      // arrival order between the two reads does not matter
      const transcripts = SubscriptionRef.changes(subscriptions).pipe(
        Stream.switchMap((set) =>
          Stream.mergeAll(
            set.map((s) => events.aggregate(s.id, s.fromSeq)),
            { concurrency: 'unbounded' },
          ),
        ),
      );
      // cold hydrate (C7): listing(), the initially subscribed aggregates
      // (above, from the replayed set), then the tail from `now`. Publish
      // only after the replay says it is done: a mounting surface must not
      // render the intermediate scan states
      yield* Effect.forkScoped(
        Stream.mergeAll(
          [
            events.listing(),
            transcripts,
            events.all(now),
            SubscriptionRef.changes(subscriptions),
            liveness.changes,
            chunks.changes,
          ],
          { concurrency: 6 },
        ).pipe(
          Stream.scan(empty, fold),
          // listing() complete AND one replay-complete marker per initially
          // subscribed aggregate (below); nothing is published before both
          dropUntilReplayComplete(initial.map((s) => s.id)),
          Stream.runForEach((v) => SubscriptionRef.set(ref, v)),
        ),
      );
      return { ref, changes: SubscriptionRef.changes(ref) };
    }),
  );
}
```

The empty value is built once from `WorkspaceRoots` and passed to _both_
`SubscriptionRef.make` and `Stream.scan`: `SessionView.key` identifies which
paper a view is of, no `FoldInput` arm carries a `SessionKey`, and seeding
the scan with anything else would have its first emission overwrite the
correctly keyed ref. `SessionKey` needs no field of its own - it is
`roots.workspace`, the same value that keys the `LayerMap` (7.3, 8.1).

The fold folds the replay through before the first value reaches `ref`:
`Stream.scan` emits one view per input, so publishing them all would let a
surface mounting onto an existing session render its history - deleted
streams reappearing, resolved approvals actionable again, non-terminal runs
briefly `interrupted` because no `local` snapshot has arrived yet, a
transcript filling in row by row - for the length of the replay. The replay
says when it is finished rather than being inferred from an ordinal:
`listing()` completes, and each `aggregate(id, fromSeq)` read emits a
**replay-complete marker** after its first forward read, before its tail;
a frame carries the same markers (8.1). The first publish waits for
`listing()` to complete **and** for the marker of every aggregate in the
subscription set at layer build, because the listing replay and the
transcript replays run concurrently and the listing finishing first says
nothing about the transcripts; a marker from an aggregate that joins the set
later gates nothing, since the view is already published and its rows
arrive incrementally like any tail. Comparing the view's cursor against a
captured ordinal does not work, because retention can prune a deleted
stream's rows and its tombstone while the ordinal keeps counting - if the
surviving history ends at 10 and the pruned rows held 11-20, nothing the
subscriber folds ever reaches 20 and the view would stay empty until some
unrelated commit arrived. The fold drops scan values until both conditions
hold and publishes every one after; the tail then publishes incrementally
as before.

`Layer.effect` strips `Scope` from the requirements, so the forked fold
fiber is owned by the layer's scope and ends on `runtime.dispose()`.
`Layer.scoped` does not exist in v4 (the migration PRD's section 8.3 example
needs the same correction). `SubscriptionRef` does not coalesce; the bridge
does (7.5). Synchronous reads use `SubscriptionRef.getUnsafe`, never
`runSync`. The six merged streams are the four arms of `FoldInput`
(5.2), the event arm arriving as its three reads, and each transient one has a
source service with a process-specific layer, so the fold fiber is the same
code everywhere.
`LocalRuntimeSource` is the lease reader and restart repair's shared `SubscriptionRef` in the
runtime and the `local` field of each frame (8.1) in a webview.
`TextChunkSource` is the model handler's existing delta path in the runtime
(the stream `StreamingTextAccumulator` consumes today) and the `chunks`
field of each frame in a webview.

`events.listing()` is the cold listing hydrate: the latest-of-type row per
aggregate for the listing fact types plus the outstanding-approval set,
never a transcript row. `events.all(now)` is the tail: every row committed
after the ordinal captured at layer build, in commit order, transcript rows
of every aggregate included, of which the fold keeps only the subscribed
aggregates' (the residency rule of 5.2). Transcript history arrives through
`events.aggregate(id, fromSeq)`, one read per aggregate in the subscription
set: the set gains an aggregate when a surface subscribes to it (8.1; the
TUI and headless write the set in process) and loses it when the last
subscriber leaves. The set is itself a fold input: `switchMap` only closes
the departing aggregate's read, and the eviction is the fold's, on the set
change - that stream's `rows`, `taskGroups`, `compaction`, and `run` go,
its listing facts stay - so opening and closing transcripts accumulates
nothing. The set names aggregates, not streams - a stream's transcript is
its stream aggregate plus its execution aggregate, each from its own seq
(5.1) - and the subscribe handler writes each entry's `fromSeq` from the
subscriber's `view.folded` entry for that aggregate, never from `settledSeq`
or the cursor, which are commit ordinals in another number space; a stream
at commit 100 whose execution aggregate is at seq 3 reopens the execution
read from 3, not 100. A reopen after a set change therefore costs the rows
since then, not the history. That is the residency rule of 5.2 applied to
the runtime, not only to webviews; one `SubscriptionRef` that folded all
history would be #9952 again.

All three non-durable inputs are **levels**, like the commit ordinal (7.1),
and for the same reason: a snapshot read beside a separately armed delta
stream loses whatever lands between the two. `TextChunkSource` is therefore
a `SubscriptionRef` of the in-flight text per row rather than a snapshot
plus a delta feed. Subscribing to a `SubscriptionRef` replays its current
value, so there is no window in which a chunk can be lost, and the framer
derives each subscriber's chunks from the difference between that ref and
what it has already sent for each row - which is what the `from`/`to`
offsets are for. A fresh subscriber has sent nothing, so its first chunk per
row is `from: 0`. Without this a webview reloading mid-response starts with
an empty `inflight` map and meets the next delta at `from > length`, the
defect assertion.

Chunks are process-local by decision, and that bounds G1 precisely: a run's
incremental text exists only in the process that owns the run and in the
webviews that process serves. A second process with the same session open
sees the row as running and its text at the last settled event, because the
table and the commit counter deliberately carry no chunks. Forwarding them
would mean a second cross-process transport whose only payload is the data
this PRD refuses to persist, and it would have to buffer, order, and repair
that payload separately. G1 therefore reads: every process folds the same
inputs to the same view; a non-owning process has strictly fewer inputs and
renders the settled prefix, never a different picture of the same input.
Making the settled text authoritative on the finalizing event (5.2) is what
keeps that prefix complete rather than empty. Without that third arm the in-process
readers - the TUI (10.1) and headless (10.3), which read
`SessionViewService.ref` directly - would see settled rows only, which G1
forbids.

### 7.3 `WorkspaceRoots` and the per-session layer

```ts
class WorkspaceRoots extends Context.Service<
  WorkspaceRoots,
  {
    readonly workspace: string;
    readonly storage: string;
    readonly config: string;
    readonly workspaceState: string;
  }
>()('@texra/session/WorkspaceRoots') {}

// the runtime graph; a webview's is the same with
// SessionEvents.transportLayer over SessionFrames and no Database (7.1)
const sessionLayer = (roots: WorkspaceRoots.Shape) =>
  Layer.mergeAll(
    SessionEvents.durableLayer,
    SessionViewService.layer,
    SessionRequests.layer,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(LocalRuntimeSource.layer, TextChunkSource.layer),
    ),
    Layer.provide(Database.layer),
    Layer.provide(Layer.succeed(WorkspaceRoots, roots)),
  );

const sessions = LayerMap.make((root: string) => sessionLayer(rootsFor(root)), {
  idleTimeToLive: '30 minutes',
});
```

`LayerMap` keyed by workspace root is the keyed resource family the
desktop's N papers need, and it closes the memoization trap: layers memoize
by reference, so a parameterized layer built at two call sites would build
twice. The persistence cutover's `Database` layer takes the root as a layer
parameter from day one and never reads the process singleton; one database
per session under WAL. Effect code never calls `currentSession()`: it is
backed by async-local storage (`RunContext.ts:78, 159-161`), and Effect's
scheduler drains many fibers' continuations in one turn, so that state
bleeds across fibers. Roots come from context; the async-local path stays
in the Promise tier only.

### 7.4 Transport framing

**Redaction is the framer's contract obligation (C3, 2026-09-04).** Trace
rows on the stream aggregate, error payloads, and approval payloads are
secret-scrubbed at publish time before the row is written. The flow rows on
the execution aggregate (`2026-09-04-agent-runtime-on-effect.md` section
2.1: `model.message`, `model.compaction`, `tool.intent`, `tool.result`,
`flow.snapshot`) are
byte-exact and never scrubbed, because Anthropic signature verification and
a resumed context need the original bytes. Therefore every framer that
feeds a renderer process (webview, Electron renderer) and every export
applies display redaction and truncation, and no webview or export ever
receives a byte-exact flow payload; only the in-process hub is trusted.
Until the display fold reads `model.message` directly, message text is
durable twice (the redacted trace row and the flow row); that collapse
deletes the trace copy and moves redaction to fold time.

Down, per subscriber: the reads its `Subscribe` names (8.1: a cold mount is
`listing()`, `aggregate(id, 0)` per named aggregate, then `all(now)`; a
resubscribe is `all(cursor)` and `aggregate(id, fromSeq)` per named
aggregate), each row tagged with its read, and transcript rows of aggregates
the subscriber has not named left out (the fold would drop them; not framing
them keeps the bridge to the listing tier plus the subscribed transcripts),
then `Stream.groupedWithin(n, "16
millis")` then `Stream.buffer({ capacity, strategy: 'suspend' })` for
durable events, which must not drop; suspension parks the framer, never the
publisher, because the hub is unbounded. Text chunks are append deltas, not
snapshots, so a slid or dropped chunk is lost text that no replay recovers.
They need neither strategy: the offsets make coalescing lossless, because
two adjacent chunks for a row merge into one exactly (5.2). The framer
therefore keeps **one merged chunk per streaming row per frame**, which
bounds the queue by the number of live rows rather than by the chunk rate,
and text rides the same `'suspend'` buffer as durable events.

That deletes the entire repair path this section used to carry: no
per-stream chunk index, no dedupe pass, no drop to detect, no resync
message kind, and no control output for the pure fold to raise - which it
could not have raised anyway, since it is a fold and the subscription is
not its to restart. `from > length` becomes a defect assertion rather than
a repair. The only resubscribe left is the ordinary one: a reload, or a seq
gap in durable events (7.1), sends `Subscribe` with the view's cursor and
each named aggregate's `view.folded` seq, and
the runtime answers each in-flight row with a `from: 0` chunk that replaces
it under the same splice rule. Frame volume equals
today's `LOG_DELTA` framing (`WebviewBridge.ts:11`, 16 ms, text appends
merged per entry); a row-per-update patch would have shipped every text
twice, which is one reason patches are not built.

### 7.5 The signal bridge

```ts
// src/shared/signals.ts
export function toSignal<A>(
  runtime,
  changes: Stream.Stream<A>,
  initial: A,
): Signal<A> {
  const s = signal(initial);
  const fiber = runtime.runFork(
    Stream.runForEachArray(changes, (arr) =>
      Effect.sync(() => {
        s.value = arr[arr.length - 1];
      }),
    ),
  );
  return Object.assign(s, {
    dispose: () => runtime.runFork(Fiber.interrupt(fiber)),
  });
}
```

The only meeting point between Effect and the components. Lit components
are `SignalWatcher`s; the CLI's `useSignal` is the other side. Coalescing
is here, by draining arrays and assigning the last element.

### 7.6 Requests, errors, ownership

```ts
// src/shared/session/requestErrors.ts
class NotOwner extends Data.TaggedError('NotOwner')<{
  streamId: StreamTabId;
}> {}
class Unavailable extends Data.TaggedError('Unavailable')<{
  streamId: StreamTabId;
  reason: string;
}> {}
class Rejected extends Data.TaggedError('Rejected')<{ reason: string }> {}
class Invalid extends Data.TaggedError('Invalid')<{ issues: string[] }> {}
// defects reach the surface as this, never as silence
class Internal extends Data.TaggedError('Internal')<{ ref: string }> {}
type RequestError = NotOwner | Unavailable | Rejected | Invalid | Internal;

// src/controllers/session/SessionRequests.ts
// Effect.fn('SessionRequests.request')
request: (req: RuntimeRequest) => Effect.Effect<Outcome, RequestError>;
```

The interaction scope (`executionInteractionOwnership.ts:36-56`, already
"its own owner token") becomes a resource acquired with
`Effect.acquireRelease`; workflow skip, retry, and kill are methods on it,
so nothing outside a scope can call them. Failures are matched with
`catchTag` and `catchTags`; unexpected causes `orDie` with one
`tapCause` log at the boundary (`tapErrorCause` does not exist in rc.112,
and `orDie` moves the failure into the defect channel, which is what
`tapCause` sees). The bridge then inspects the fiber's exit and posts
`Internal { ref }` for a defect, where `ref` is the log correlation id: §8.4
promises exactly one response per request, and a dying fiber that posts
nothing leaves the admission latch, the draft, and focus restoration pending
forever - the same failure this section rejects for a stale stream. `orDie`
decides what is _logged as a defect_, not whether the caller hears back. A request naming a stream that is gone is
`Unavailable`, not a defect: with two surfaces on one session, one can send
`stop` or `resume` from a view that has not yet folded the other's
`stream.removed`, and calling that a defect would bypass the response path
(8.4) and leave the sender's latch and draft pending forever. The envelope is parsed first, and an
arm the Zod union rejects is `Invalid` under that request's own id - a stale
surface sending `followUp.send` with no text still gets an answer, where
calling it a defect would strand the same latch this rule protects. Only a
message whose **envelope** cannot be decoded is a defect, because there is
no id to answer under. Error payloads cross the bridge as plain
tagged objects under the Zod union. Effect Schema is used nowhere: it
measures 188 KB minified and 56 KB gzipped, and rc.112's `Schema.TaggedError`
is already renamed upstream, so the pinned name would break on the next
bump.

### 7.7 Runtime per process

One `ManagedRuntime.make(processLayer)` per process, module-owned at the
existing entry, disposed on the existing shutdown path. The runtime
processes take `SessionEvents.durableLayer` with the runtime's
`LocalRuntimeSource` and `TextChunkSource`; every webview entry takes
`SessionEvents.transportLayer` over `SessionFrames` and never resolves
`Database` or `DurableWrite` (7.1). The entries:
`packages/extension/src/extension.ts`, the desktop main entry, the CLI
entry, and each webview entry (`packages/extension/src/progressView/frontend/index.ts`,
which the extension sidebar, the editor tab, and the Electron renderer all
load). `runPromise`, `runFork`, and `runSync` appear only there and at the
outermost Promise-facing method (`runtime.runPromise(effect, { signal })`);
inside, cancellation is fiber interruption (R5). `src/auth/oauth/loopbackLogin.ts:250`
runs on the default runtime today and migrates onto the host runtime.

Webview lifetime: the fold fiber is forked under the runtime's scope;
components subscribe in `connectedCallback` and interrupt in
`disconnectedCallback`; `pagehide` and `import.meta.hot?.dispose` call
`dispose()` so a reloaded module cannot run two fold fibers against one
signal. Remount in the same JS context is real today (`progressState.ts:261`
resets singleton signals for it); with a module-owned runtime the fold fiber
survives and the bridge resubscribes.

### 7.8 Bundle, measured

With the repo's esbuild, browser platform, minified: the set this PRD needs
(`Effect`, `Layer`, `Stream`, `SubscriptionRef`, `Schedule`,
`Scope`, `Semaphore`, `Queue`, `Data`) is 188 KB minified, 61 KB gzipped;
with Effect Schema it would be 376 KB and 117 KB. The current progress
bundle is 2.57 MB raw, 730 KB gzipped, as a development build. Accepted,
and the reason Schema stays out. Re-measure at the end of lane 4 against a
production build.

## 8. The protocol

Six messages, three each way. Down: `events`, `response`, and
`surface.action`. Up: `subscribe`, `runtime.request`, and `host.request`. The CLI calls
the same functions in process.

### 8.1 Down: `events`

```ts
EventsFrame = { session: SessionKey, events: SessionEvent[], chunks: TextChunk[], local: LocalRuntimeState | null, host: HostSnapshot | null, replayComplete: { listing: boolean, aggregates: AggregateId[] } }
Subscribe   = { session: SessionKey, cursor: SessionCursor, aggregates: { id: AggregateId, fromSeq: Seq }[] }  // listing tier for every stream; transcript tier for the named aggregates; each fromSeq is view.folded[id], never the cursor
```

`Subscribe` travels **up** (8.6 makes it the replacement for
`WEBVIEW_READY`); the frames it starts travel down. It is listed here
because the two shapes define one channel between them, not because they
share a direction. It names **aggregates**, not streams (contract C7):
subscribing to a stream's transcript names its stream aggregate and, through
the edge on `run.start`, its execution aggregate, each with its own
`fromSeq`, because the two sequences are independent and one number cannot
resume both - a shared `fromSeq: 10` taken from the stream would skip
execution rows 4 to 10 of an execution aggregate at seq 3. Each `fromSeq`
is that aggregate's entry in the subscriber's `view.folded` (5.1), the last
seq it folded for that aggregate. Never `settledSeq` and never `cursor`:
both are commit ordinals, and a session at commit 100 whose execution
aggregate is at seq 3 would otherwise reopen from 100 and skip that
aggregate's rows 4 onward for good. The runtime's subscribe handler copies
the same entries into `TranscriptSubscriptions` (7.2).

Two shapes on this channel, not three: a resync is a `Subscribe` whose
frames answer with `from: 0` chunks for the streaming rows (5.2, 7.4), so
there is no `Resync` shape and no replacement fold arm. Every event carries
its aggregate id, its `seq`, and its session `commit` ordinal (the aggregate
being a stream id, an execution id, or the session aggregate, 5.1), and
every chunk carries its stream and
its `from`/`to`, so a frame needs no per-stream range. Within one read the
rows of a frame are in that read's order (commit order for `all`, seq order
per `aggregate`); across reads a frame interleaves freely, and that is
fine, because every row carries its commit ordinal and the fold places
transcript rows by it (7.2), so a flow row framed after a trace row that
was committed later still lands before it. A subscriber advances one
cursor (the highest commit folded) and one `folded` seq per aggregate.
`replayComplete` says which replays the subscription has finished: the
listing, and each named aggregate as its history ends. Replay spans many
frames and a webview has no database to ask, so this is how it knows when
to publish its first view (7.2): after the listing and every aggregate it
named at subscribe. Before that the webview folds and stays silent; from
then on, every frame publishes. It is a marker rather than an ordinal
because retention can prune rows above the last surviving one, leaving an
ordinal the subscriber would never reach. `streamId` stays a payload field
on the facts that have one; an unparented `inquiryThreadUpdated` rides its
thread aggregate (C2, 5.1), which is why no sentinel stream id exists.

The two nullable fields are host-owned transient snapshots, sent on every
change and on every subscribe, and they are the only two. `local` is this
process's runtime snapshot - live owner ids and unreadable streams (5.2);
a surface that has never received one folds with `local` empty. `host` is
everything the shell renders but does not own: the launcher's option lists
(models, agents, teams, workspace roots), the document and Git catalogs the
file-select group and the LaTeXDiff controls need (file lists, the current
and open files, whether the root is a Git repository, recent commits -
`fileOptions$` and `isGitRepo$` today), the five banners, the onboarding funnel
state, the debug-mode flag (`GET_DEBUG_MODE` today, which gates the Pack and
Delete-output controls §12 retains), the current theme (the desktop's
`nativeTheme` listener sends `THEME_SET` today,
`desktopViewStateIpc.ts:28-42`, and lane 4 deletes that route), and the open papers'
display records - `{ key, name, initials, subtitle }` per paper, so the
desktop rail reads a named field instead of deriving a name from a path or
joining a catalog in the component (§12). None of it is the user's choice (`Surface`, 9) or a
fact about a run (`SessionView`), and all of it changes while a webview is
open - a new agent file, an added workspace root, a credential that starts
failing. That rules out both alternatives: a one-shot request at startup
goes stale, and a request arm would need a push channel anyway. `local`
already established the shape, so this is a second field on an existing
message rather than one field per kind of host state - which is what feeds
the pickers, the banners, and the empty state once lane 4 deletes
`SET_BANNER`, `SET_ONBOARDING_FUNNEL`, and the option-posting commands.

`SessionKey` is the workspace root that keys the `LayerMap` (7.3), and it
is on every message in both directions. One desktop renderer has N papers
open, so it subscribes once per paper and holds one `SessionView` per
paper; without the key the host would need a process-global "current
workspace", which is exactly what section 11 deletes. It also routes the
requests below: a `host.request` naming a relative file resolves it against
that session's roots, and a launch goes to that session's runtime.

### 8.2 Up: `runtime.request`

One Zod union, one handler. Every request carries a `session` and a
`requestId` minted by the surface, and is answered by 8.4. Arms, from the classification of today's
46 progress and 49 main-view inbound commands:

Arm tags are `group.action` throughout, so two groups cannot claim one tag -
`retry` was about to mean both a follow-up retry and a workflow-call retry
in the same discriminated union, which Zod would have rejected and a reader
would have misread first.

Every stream-scoped arm names a bare `streamId`, and a request naming a
stream the runtime no longer has is answered `Unavailable` (7.6). Nothing
more is needed: a `StreamTabId` names one run for its whole life (decision
9), so a request that waits in the bridge while its stream is deleted can
only miss, never land on a different run. Earlier drafts carried a
`{ streamId, executionId }` target on every arm for exactly that race;
fixing the id retired it.

- stream: `stream.stop`, `stream.delete`, `stream.compact`,
  `stream.resume`, `stream.runNew`, `stream.restoreState`, each naming a
  `streamId`; `stream.deleteAll`, which names none - it is a session
  operation (`DELETE_ALL` is `commandOnly` today and `deleteAllStreams()`
  takes no argument), so requiring a stream would make it unavailable from
  New-task state and fail when that one stream is concurrently removed while
  the rest still need deleting
- follow-up: `followUp.send { streamId, text, images }`,
  `followUp.retry { streamId, retryId, feedback? }`,
  `followUp.cancelRetry { streamId, retryId }` - the pending retry id is
  domain identity, not the envelope's freshly minted correlation id, and the
  handler checks it before settling
  (`ProgressViewCommandHandlers.ts:563-576`,
  `progressHostInteractions.ts:301-312`), so a stale panel in another
  surface cannot resolve the newer retry -
  `followUp.polish { streamId, text }` - the draft
  lives in the view's `Surface.drafts` and §8.6 does not synchronize it, so
  polish carries its text exactly as `polishInstruction` does
- decisions: `toolEdit { action, feedback? }`, `bash { action, feedback? }`,
  `plan { action }` (including `approve_and_goal`) - discriminated payloads,
  because an arm has to say **which** decision was made and carry its
  rejection feedback; the schemas already distinguish these variants
  (`progressView/inbound.ts:145-162, 187-193`),
  `proposal { approve { model?, agent? } | reject | setup }` (the panel
  lets the user approve with a different model or agent, which
  `AgentProposalActionMessageSchema` carries on its approve branch,
  `progressView/inbound.ts:167-173`, and the stored approval cannot
  reconstruct), and
  `userQuestion { action, answers | feedback }` - the answer map lives only
  in the answering surface, and `UserQuestionActionMessageSchema` requires
  it on submit (feedback on reject or skip), so the approval record cannot
  reconstruct it. Each carries the `approvalId` of the request it answers (the runtime's id from
  `approval.requested`, which `ApprovalRequest` already holds), plus
  `externalInquiry { thread, turnIndex, submit { answer, sessionLinks } |
drop { feedback? } }` - a turn is `threadId` plus `turnIndex`, which is
  how the durable model already identifies one, and the runtime rejects a
  request whose `turnIndex` is not the open turn (`Unavailable`) rather than
  letting `recordAnswerForOpenTurn` write to whichever turn happens to be
  open. `Surface.inquiryDrafts` is keyed by the same pair. The answer and
  its links live only in the answering surface's
  `Surface.inquiryDrafts` (§8.6 removes the draft round trip), and
  `InquirySubmitActionSchema` requires both (`inquiry.ts:71-76`) - each
  naming the inquiry's **turn**
  and not only its thread: `recordOpenQuestion` reopens a thread and
  `recordAnswerForOpenTurn` writes whichever turn is open
  (`externalInquiryStorage.ts:251-321, 331-360`), so a stale panel in a
  second surface could answer or drop a turn the agent opened after it last
  rendered. There is no `draft` arm - §8.6 removes that round trip and §9
  makes `Surface.inquiryDrafts` the per-view owner, so two surfaces would
  otherwise overwrite each other's unsent text through the backend. The envelope's `requestId` is
  correlation for the response (8.4) and is minted per message; the
  `approvalId` is domain identity and names which pending decision is being
  resolved. One cannot serve as the other: two surfaces answering the same
  approval send two `requestId`s for one `approvalId`.
- policy: `setPolicy { target, change }` - the field-level mutation, not a
  snapshot. It still replaces three toggles and two enable commands with one
  runtime transaction instead of the read, set, drop sequence at
  `ProgressViewCommandHandlers.ts:378-395`, but a surface that sends a whole
  snapshot is a second authority: two surfaces on one session editing
  different controls from the same starting snapshot would have the later
  request silently revert the earlier change. The authority applies the
  change and emits the resulting full snapshot as `approval.policy` (section
  6, item 2), which keeps "never a toggle delta" true of the _event_ while
  the _request_ stays a mutation.
- workflow: `workflow.skip { streamId, callIndex }`,
  `workflow.retry { streamId, callIndex }`,
  `workflow.kill { streamId, detachActiveChildren }` - bare stream ids like
  every other arm, since an execution is 1:1 with its stream (5.2); the
  handler resolves that execution's interaction scope (7.6) from it, and one
  session can have several workflows running
- credentials: `useOwnApiKey { streamId, retryId, provider, model, reason,
kimiCodeRoutedOnFailure }` - **no key**: the host has already stored it
  (8.3) and the runtime reads it from the secret store, so the credential
  never enters a surface or its message path. One transaction: switch
  routing, trigger that pending retry, compensate on failure.
  `kimiCodeRoutedOnFailure` is carried because
  `ProgressApiKeyRetryController.shouldDisableRuntime` needs it to disable
  the Kimi Code preference; without it a Moonshot key can retry straight
  back onto the exhausted coding endpoint
- misc: `runCompileFixer { streamId }`, `exportTranscript { streamId }` -
  both are stream-scoped in the handlers today, so both name their stream
- launch: `execute { selection }` - the raw launch selection from
  `Surface.launch`, not a request the browser validated: a team launch has
  to resolve the authoritative team plan and can need a partial-continue,
  cancel, or sign-in decision (`executionHandlers.ts:65-81`), neither of
  which a webview can do. The runtime prepares
  (`prepareMainViewExecutionLaunch`) and, when the plan needs a decision,
  returns a `needsConfirmation { token, unavailable, needsAuth }` **outcome**
  rather than reaching upward: §8.3 is for requests a surface mints and §8.4
  routes each response to its sender, so a runtime-initiated `host.request`
  has no way back into the suspended handler. The surface renders the
  prompt (signing in through the host if asked) and issues
  `launch.confirmTeam { token, choice }`, the second continuation, which
  resumes or abandons the prepared launch;
  `polishInstruction { text, agent, model, files }` - the launch draft lives
  in the view's `Surface.launch` and 8.6 deliberately does not synchronize
  it, so the request carries what it polishes, as today's command does

Outcome is a typed value the host renders; the nine toasts hardcoded in the
shared handler (`ProgressViewCommandHandlers.ts:305-312, 383-395, 601-618`)
become outcomes. The follow-up admission latch already lives in the
controller (`progressFollowUpSubmit.ts:42-47`); returning it as the outcome
deletes `FOLLOW_UP_RESULT`.

### 8.3 Up: `host.request`

Same envelope: a `session` and a `requestId`, answered by 8.4.
Capabilities mapped onto `platform()` and `@hosts/*` ports:
`openFile { path, line? }` (the line is what `LogList.ts:310-314` parses
from a compiler link and `OpenFileMessageSchema` already carries; a bare
capability would recreate the desktop line-dropping defect §1 counts),
`openSpillArtifact`, `openTaskStorage { streamId }` (the handler calls
`openTaskStorage(data.stream)` and the selection lives only in the
requesting surface, §8.6), `compare`, `accept`, `merge`,
`latexdiff`, `openLabel`, `pack`, `clean`, `restoreIntoLauncher`,
`showDiff`, `previewProposed`, `showLatexdiff` (for a pending edit),
`record { start { target: StreamTabId | 'launch' } | stop }` (the start
names its destination, which lives only in the requesting surface once §8.6
removes selection synchronization, and is what populates
`HostSnapshot.recording.target` for every other view), `popOut`, `popBack`,
`pickFiles { fileType, options }` (the launcher has input, context, media,
base, and edited pickers; `fileType` chooses the dialog and names the
`Surface.launch` field the paths return to, and `options` carries the
picker-specific context the inbound schemas pass today - `currentFile`,
`baseFile`, `preserveBaseFile`),
`attachDroppedFiles { paths, category }` (returning the accepted
selections: `fileDropHandler.ts:181-194` sends `ATTACH_DROPPED_FILES` today
and `FileManager.ts:240-266` resolves, validates, and categorizes the paths
host-side - a picker is no substitute for a drop), `refreshFiles` and
`listFiles { path }`, `readFile { path }`, and
`writeFile { path, content }` (the desktop Monaco editor's tree, open, and
save - `renderer/fileRequests.ts` sends `LIST_FILES`, `READ_FILE`,
`WRITE_FILE` today and `messageRoutes.ts:153-178` resolves them; they are
distinct from `openFile`, which is the user-facing navigation action, and
they must be session-keyed like every request now that lane 6 removes the
process-global root), `refreshCommits` (the retained `latexdiffs-section`
and launcher controls
post `REFRESH_COMMITS` and `REFRESH_ALL_FILES` today, `MainApp.ts:621-625`;
each re-derives its part of the `host` snapshot, which is otherwise pushed
only when the host notices a change), `openSettings { section, sessionType? }` (the Agent, Team, and Model items
route to three different commands today - `texra.showAgents`,
`texra.showMultiAgent`, `texra.showModels` (`commonSlice.ts:51-60`) - and
agent settings additionally carry the tool-use session type, none of which a
bare arm can express),
`showMessage { level, text }` (retained controllers notify before any
request exists - `pasteHandler.ts:28-35` posts `SHOW_INFORMATION_MESSAGE`
when decoding fails, before `savePastedImage` is reachable - so without it
that failure is silent, which the silent-degradation rule forbids),
`openDashboard` (the retained "Open dashboard" action, `texra.showDashboard`
today), `openUrl`, `openPaper` (the desktop rail's "Add paper…": the native
directory picker, the session graph, and the new key returned as the
outcome for `Shell.open` - without it that action is inert once
`desktopWorkspaceRelaunch` is deleted), `savePastedImage { base64, mediaType, fileName }` (returning the stored
filename, which `InstructionManager.handleClipboardImage` does today through
`savePastedImageBase64`; §12.4 retains image paste and lane 4 deletes the
message registry it rides), `storeApiKey { provider? }` (the quota
panel's recovery: the host prompts **and persists to the secret store**,
returning only success and the provider - never the key itself. A raw
credential must not cross into the webview bundle or its message path, and
today it does not: `ProgressApiKeyRetryController` keeps it host-side
through `readKey`/`promptForApiKey` (`:56-65, 186-211`). The provider is
optional because onboarding's `needs-credential` card sends
`OPEN_SET_API_KEY` without one (`MainApp.ts:354-360`) and the host asks
which to configure; its outcome also refreshes the `host` snapshot, because
the secret store emits no key-change event
(`onboardingSlice.ts:23-28`). The routing switch
and the retry belong together in the runtime, because
`ProgressApiKeyRetryController.commitOwnApiKeyRouting` rechecks the pending
id, changes routing, triggers the retry, and compensates a failure inside
one serialized section; splitting them across a response boundary can leave
global provider preferences changed with no retry started), `setActiveView { mode }` (**from the sidebar bridge only**: `texra.activeView`
is one extension-global key and its six consumers are the sidebar's
`view/title` entries, `packages/extension/package.json:649-678`, so an
editor-tab mode change must not overwrite it - a
notification, not a round trip: the extension host needs `texra.activeView`
for six `view/title` menu conditions and §8.6 removes the selection round
trip, so the surface tells the host what it is showing without selection
becoming a session fact), and the launcher's file pickers. The banners and the
onboarding cards are interactive, so their actions are arms too:
`recheckDependencies`, `dismissBanner { id }`, `signIn`,
`onboarding { advance | dismiss }`,
`openAgentDirectory` (the agent-config banner's "Open agent directory" when
`customDirSet`: the host resolves `agentDirectories.custom()` and calls
`revealFileInOS`, which `openSettings` cannot do), `openAgentDocs` (its
"Read agent docs" sibling, which opens the internal `custom-agents`
document, `mainViewActions.ts:529-543` - an internal document command, not a
URL, so `openUrl` does not stand in for it),
`gettingStarted { action }` (the empty state's `createSampleProject`,
`cloneOverleaf`, `downloadArxiv`, `openWalkthrough` - distinct host
commands in `GettingStartedActionSchema`, `mainView/state.ts:354-374`, which
a funnel transition does not model),
`showInstruction { key, text }` (the launcher's instruction help, including
the "Never remind again" persistence `showInstructionWithSuppress` owns
today, `frontend/ui/instruction.ts:31-64`), and `openInstallGuide { tool }`
(`mainView/inbound.ts:184-200`). `openSettings` and `openUrl` cannot perform
a recheck, a dismissal, or a funnel transition, so without these the
retained controls go inert the moment lane 4 deletes the command
registries. The own-API-key retry is a host credential
prompt that stores the key host-side and reports only that it did; the
surface then issues `useOwnApiKey` (8.2), which owns the routing switch and
the retry and reads the credential from the secret store.

### 8.4 Down: `response`

```ts
Response = {
  session: SessionKey,
  requestId,
  result: { ok: true, outcome: Outcome } | { ok: false, error: RequestError },
};
```

`SessionRequests.request` returns `Effect<Outcome, RequestError>` (7.6);
the bridge runs it and posts one `Response` per request, success or
failure, under the request's id. The webview bridge is one-way today
(`hostBridge.postMessage`), so this is the message that carries an outcome
back at all: the follow-up admission latch clears on it, a rejected
follow-up keeps its draft and restores focus from the error arm, a file
picker returns its paths in the outcome. In process (TUI, headless) the
Effect's own result is the response and no message exists.

### 8.5 Down: `surface.action`

```ts
SurfaceAction = {
  session: SessionKey,
  action:
    | { kind: 'selectNew' }
    | { kind: 'select'; streamId: StreamTabId }   // revealStream(streamId)
    | { kind: 'toggleDrawer' }
    | { kind: 'submitLaunch' },
};
```

The host initiates these, and only these. `texra.showMainView`,
`texra.showProgressView`, `texra.toggleView`, and the run accelerator are
invoked from the command palette, a title menu, the status bar, or a
keybinding, and each has to change or act on state the **surface** owns -
`MainViewProvider.switchMode` is deleted and interaction state is barred
from `HostSnapshot` (8.1), so without this channel those retained commands
have nothing to reach.

It is an action, not state: the surface stays the single owner and decides
what its `Surface` becomes, exactly as when the user clicks the same
control. Anything the host could instead express as data belongs in the
`host` snapshot, and anything a surface initiates is a request - this
message exists only for the case where the host is the actor and the
surface holds the state.

### 8.6 What does not cross the bridge

Interaction state: `SWITCH_STREAM`'s round trip and persistence, the
external-inquiry draft, `SETTLE_STREAM_SELECTION`, `SET_PLACEMENT`. The
transport handshake (`WEBVIEW_READY`) becomes the subscribe message.

## 9. The Surface

Two scopes, both owned by the renderer, both in signals. `Shell` is one per
**view instance** (sidebar webview, editor-tab webview, Electron renderer,
TUI screen); `Surface` is one per view instance **and open session**:

```
Shell = {
  active: SessionKey                   // which paper the view is showing
  open: SessionKey[]                   // rail order, user-arranged
  collapsed: SessionKey[]              // rail rows the user folded shut
  search: string                       // the rail's search, across papers
}
```

The desktop needs `Shell` because clicking a rail row has to choose a paper
and nothing else can own that: a `Surface` is per session and so cannot say
which session, `SessionView` is a fact about one session, and the `LayerMap`
is a resource cache, not a selection. Without it the renderer would grow the
second undeclared state owner G3 forbids. On the extension and the TUI it is
degenerate - one root, `open` of length one - and it persists with the rest
of the view's interaction state.

Recording is deliberately _not_ here either. The recorder is one per
process and a process can have several view instances - the sidebar and the
editor tab at once - so a `Shell` field would leave the other view offering
Start and getting "Recording already in progress", which is the failure that
moved it off `Surface` in the first place. It belongs to the one owner that
already broadcasts to every view: `HostSnapshot` (8.1), as
`recording: { session, target: StreamTabId | 'launch' } | null`. The
destination rides with it, fenced by incarnation like every other stream
reference (5.2), or a relaunch under a reused id would receive the previous
run's dictation.

The transcription itself is not broadcast: it is the **response to the
`record.start` request** that began it (8.4), so it reaches the surface that
asked, addressed by that request's `requestId`. A `record.stop` from a
second view instance **also** completes the original `record.start` request,
carrying the transcription to the surface that asked - which is the only way
the result finds the right draft, since two views on one session hold
different `Surface` drafts for the same stream and the destination alone
cannot tell them apart. The stop request still gets its own ok-or-error
response under its own `requestId`: 8.4's guarantee is one response per
request, and a stop answered only by someone else's response leaves its
sender's latch pending forever.

If the originating surface goes away first - a reload, a closed view - the
runtime **stops the recorder and discards the take**, clearing
`HostSnapshot.recording`. The signal is the transport itself: a webview
reload drops its port, and the bridge treats a closed port as that
surface's teardown, failing its outstanding requests and cancelling a
recording it owns. No seventh message is needed, and `record.stop` keeps
its one meaning - a user stopping a recording, which completes the take
rather than discarding it. A dictation is a foreground interaction bound to
the composer that started it, and the alternative is a parked result that
some later surface claims: more machinery, and a worse failure when it
claims the wrong one. Losing an in-progress take on a reload is the accepted
cost, and it is loud - the indicator clears - rather than a result that
vanishes while the snapshot still says recording.

```
Surface = {
  // which paper this surface is for; the LayerMap key (7.3)
  session: SessionKey
  selected: StreamTabId | null
  drafts: Map<StreamTabId, Draft>
  // the new-task composer: the existing MainViewPersistedState, per session
  launch: LaunchSurface
  // answers in progress; keyed by inquiry, not by stream (8.6).
  // The whole InquiryDraft (answer AND sessionLinks), not just the answer.
  inquiryDrafts: Map<`${InquiryThreadId}#${number}`, InquiryDraft>
  // override on top of approval === 'descendant'; the stream tree
  expanded: Map<StreamTabId, 'expanded' | 'collapsed'>
  // task groups and workflow row groups inside a transcript, per stream
  groups: Map<StreamTabId, Map<GroupKey, boolean>>
  focusedRow: RowId | null
  // run-board tab strip; fact-only transcript.run cannot hold a selection.
  // Resolved at read like `selected`: a phase the model no longer has
  // (terminal suppression, a changed attempt) falls back to the current one.
  phase: Map<StreamTabId, PhaseId>
  scroll: Map<StreamTabId, number>
  drawerOpen: boolean
  toolsSheetOpen: boolean                // the header's Tools bottom sheet
  search: string                         // the drawer's filter, per session
  workbench: WorkbenchLayout                               // desktop only
}
```

`Draft` is `{ text, images: PastedImage[], polished: string | null,
transcribed: string | null }`. The key is the bare `StreamTabId`: it names
one run for the stream's whole life (decision 9), so a draft cannot outlive
its run and reappear against a different one - and being a primitive it
survives the persisted entry array's round trip, where an object key would
be compared by reference and read as missing on reload. A desktop renderer holds one `Surface` per
open paper, so a paper with no streams at all is still a distinct surface
with its own `session` and its own composer, rather than one of many
indistinguishable `selected: null`s.

`LaunchSurface` is `MainViewPersistedState` (`store.ts:26`,
`MainViewPersistedStateSchema`) moved under `Surface` and keyed per session,
minus its host-derived fields: `openedFiles` is the host's, not the user's,
and §8.1 already puts the current and open files in the `host` snapshot, so
persisting a per-view copy would give two surfaces different answers to a
question the rule below says cannot differ - and a stale one after a reload.
`LaunchSurface` is the selections subset. It already owns every launcher selection the composer
needs to build a `validatedRequest` - `sessionType`, `launchTarget`,
`selectedTeamId`, `workingDirectory`, `agent` and `model`, `commit`, the
single, multi, and context file selections, the checkbox values, and the
per-category instruction drafts, which are the new-task draft. The roughly
twenty module-level signals in `mainViewState.ts:76-122` become reads of
that one record, which is what makes them survive a paper switch and a
remount instead of resetting through the tracked-signal registry. Two
things that look adjacent are deliberately _not_ Surface: the option
catalogs (`modelOptions$`, `agentOptions$`, `teamOptions$`,
`workspaceRootOptions$`) are host-provided data, not the user's choices, and
the banners and the onboarding funnel are host state: all of them arrive as
the frame's `host` snapshot (8.1). The test is whether a
second surface on the same session may hold a different value: a selection
may, a catalog may not. `selected` is a _preference_, not a pointer the renderer trusts: what a
surface shows is `selected` if the view still has that stream, else
`view.order.at(0) ?? null`, resolved at read - `null` and not `undefined`,
so deleting the last conversation lands in the New-task state rather than
an unrepresentable one. The fallback applies only to a
**non-null** id that has disappeared. An explicit `null` is the New-task
state and resolves to itself, or the header's New task action and the
drawer's "+" could never open the launcher once a session had any stream. A deletion by this surface or the other
one therefore cannot leave a conversation pointed at a stream that no longer
exists, and a persisted selection restored after a deletion is harmlessly
stale rather than invalid - which is why no reconciliation effect watches
the view to clear it. Two surfaces on one session may select different
streams. Launch returns
the stream id (`onBeforeActivation` already hands it out,
`AgentLaunchContext.ts:93`) and the launching surface selects it. "Reply to
parent instead" moves the draft to the parent. Persisted per view through
the existing `PersistedState` owner for that view, interaction state only.
The signal record holds Maps; the persisted form is a Zod schema beside it
in which each Map is an entry array (`[StreamTabId, V][]`), parsed and
rebuilt into Maps at load, because webview state crosses `JSON.stringify`
and a Map serializes to `{}`. Persisted per view and session: `selected`, `launch` (as
today), `drafts` (text only; images and the polished and transcribed
variants are not), `phase`, `inquiryDrafts` (whole, and cleared when the
inquiry
resolves - §8.6 removes the round trip that persists them today, so nothing
else would), `expanded`, `groups`, `scroll`, `drawerOpen`, `workbench`. Not persisted:
`session` (it is the key) and `focusedRow`; Every per-stream map in `Surface` - `drafts`, `phase`, `expanded`, `groups`,
`scroll` - drops its entry when that stream leaves the view, in every
subscribed surface and in the persisted form. An id is never reused
(decision 9), so an entry for a removed stream can never become valid again;
without the prune, repeated runs and deletions grow the live Maps and the
persisted webview state without bound and keep a deleted conversation's
draft. `streamLifecycleSlice.ts:275-289` already clears stream-scoped
frontend storage on deletion; this is that rule, restated for the records
that replace it.

`Shell` persists `active`, `open`, and `collapsed`; its `search` is not
persisted, and neither is `Surface.search`. The two are separate because
they scope differently: the drawer filters one session's streams and so
belongs to that session's `Surface`, while the desktop rail searches across
open papers and no per-session record can hold it. Both are declared rather
than left to the components, which G3 forbids and which would reset them on
a remount or a paper switch.

Deleted: the `setActiveStream` fact, `ProgressPresentationState`, the
`StreamState.ui` block (`streamState.ts:175-184`), the pending-approval
focus gate (`ProgressBackend.ts:398-409`, `sessionSignalsAdapter.ts:259-266`),
`pendingStateManager.ts`, `ToggleStateStore` as a separate store.

## 10. Host switches

### 10.1 TUI (one pull request)

Reads `SessionViewService.ref` in process; issues `runtime.request` and
`host.request` as function calls. Gains a `Surface`. Deletes
`transcriptFold`'s row driving and `finalizedFrontier`, `streamViews`,
`childExecutions` topology, `approvalQueue`'s row mapping, the retained-phase
filter (`transcriptFold.ts:813, 900`), `chatSubmitDriver.ts` (387 lines,
including the verbatim copy of the shared submit body at `:314-321`), the
submit half of `chatSessionController.ts` (`:452-862`), the approval mappers
(`approvalAdapter.ts:53, 96`, `settleApprovals.ts`, `subscribeApprovals.ts:156-176, 306-344`),
`enabledModels.ts`. Keeps keystroke handling, the Ink static ring and trim
hysteresis, the Alt+1..9 focus order as a Surface concern. The workflow
popup renders `transcript.run` verbatim.

### 10.2 Extension and desktop (one pull request, one bundle)

- The sidebar is one document: `ProgressApp` owns the empty state and
  renders the launcher inside it. `MainViewProvider.switchMode` and the
  bundle swap are deleted. The `texra.activeView` context key (six
  `view/title` menu entries, `packages/extension/package.json:652-677`)
  becomes `launcher` in the empty state and `progress` with a selected
  stream.
- The sidebar webview and the editor-tab webview are two subscribers to
  the same events. `ProgressViewProvider.target` (sidebar XOR editor,
  `:50-60, 275-305`) is deleted; `getActiveWebview()`'s single-target rule
  goes with it.
- Events over the bridge through 7.4; the fold in the webview under a
  module-owned runtime (7.7); the `Surface` in the webview; the two request
  messages up.
- Deleted: `LitSessionRenderer` and its 21 commands, `WebviewBridge`'s delta
  buffering and `LOG_DELTA`, the 9 slices and `streamStateMerge`,
  `progressState`'s re-derived signals (`topLevelStreams$`,
  `childStreamsByParent$`, `pendingApprovalIds$`, `activeRunModel$`,
  `phaseStages$`), `streamTree.ts`, `TranscriptIndex` (`messageIndex.ts`,
  measure first: plain rebuild under `repeat` and `guard` may hold),
  the 11 `@lit/context` contexts and 2 providers (`streamContexts.ts:56-175`,
  `mainViewContexts.ts:19-24`, `MainApp.ts:229-234`,
  `StreamConversation.ts:87-142`), `ProgressViewCommandHandlers.ts` (716
  lines), the registry halves of `ProgressViewMessageHandler.ts` (858) and
  `desktopAgentExecution.ts` (the `DesktopProgressBridge` portion,
  `:166-1265`), `eventHandlers.ts` (420), the desktop's unsupported-command
  list, `FOLLOW_UP_RESULT`, `SETTLE_STREAM_SELECTION`, `UPDATE_BYPASS`,
  the **session routes** of `renderer/messageRoutes.ts` (201) and
  `desktopIpcTypes.createCommandHandler` in favor of one dispatcher over one
  schema family, `desktopProgressIpc`'s outer parse (`:97`). Its terminal,
  PDF, and browser routes stay: those are byte streams, not session events
  or request outcomes (12.2).
- The desktop main process runs the same fold for control and headless
  needs; renderer and main each hold one runtime. One program in two
  processes, not a dual.
- Bundle delta measured here (7.8).
- `stream-tabs` `compact` mode (the sub-500px icon rail of the deleted
  split panel) is deleted.

### 10.3 Headless and SDK

`runProgressRenderer.ts` reads the fold. The NDJSON subscription does not,
and should not: `sessionProgressSubscription.ts:60-96, 104-181` is two
exhaustive switches with no cumulative state, one event to at most one
line, and its `setTaskState` line carries a whole `AgentConfig` through
`agentConfigToTaskState`. Routing a frozen external wire through the view
would put `TaskState` fields in `SessionView` that no renderer shows, and
would then make the projection diff two views to recover the event that
produced a line. It stays a per-event projection of the shape the code already has, one
event to zero or one line: the activation line comes from `run.activate`
(section 6, item 8), not from overloading the resuming `status` fact, which
already projects to `updateStreamStatus` (pinned by
`CliSessionProgressSubscription.vitest.ts`) and carries neither
`agentCategory` nor `isRemote`. It reads
`SessionEvents.all(now)` directly - every event above the ordinal, in
commit order, transcript rows of unsubscribed streams included, so a
`stage.start` no surface subscribed to still becomes its line and two
same-type updates never collapse into one (contract C7 names this reader as
the reason `all` is exhaustive) - attaching at `SessionEvents.now`, the
session's current commit ordinal, captured when it subscribes (§7.1 exposes
it for exactly this reader, which by design never reads `SessionView` and
never calls `listing()`) - not the empty cursor, which on a
resumed session would re-emit the whole history before the current run's
records and break the byte-identical guarantee. The cursor parameter already
expresses "from here on"; no live-only mode is needed. That is the division: the fold is what
_renders_, the event stream is what _serializes_, and the projection is the
one place internal vocabulary is translated to the frozen wire - including
the `setActiveStream` line, which survives the deletion of the fact
(section 6, item 5) because `run.activate` (item 8) replaces it as the
durable activation fact and carries the same payload. `run.start` alone
would not do: `AgentLaunchContext` emits the line on every activation, a
resume keeps its incarnation and mints no new start, and a reader attached
at `SessionEvents.now` never sees the historical one. `workflowPlainOutput.ts` (204 lines, its own event
fold, terminal gate, status table, and model-label swap) renders
`transcript.run` to text. `packages/agent` exports the pure `fold`,
the `SessionView` and request Zod types, and an async-iterable
`subscribeSessionView()` that owns the runtime internally - not
`SessionViewService`. G6 puts Promises at the boundary, and exporting the
service would make an embedder import `effect`, hold layers, and manage
fiber scope just to read a view. The point stands either way: consumers stop
re-folding raw events (`src/index.ts:78-150`). The trace viewer already reads the shared renderer
and stays.

## 11. Session roots and many papers

One desktop process holds N `SessionHandle`s, one per open paper. The
per-workspace roots (`workspace`, `storage`, `config`, `workspaceState`)
move off the frozen `platform()` object (`src/platform/platform.ts:63-75`)
onto `WorkspaceRoots` (7.3). `platform()` keeps the process-true ports:
`fs`, `globalState`, `secrets`, `lifecycle`, `processes`, `fileLocks`.

The runtime is already multi-session: `SessionHandle` keeps a set of live
sessions and resolves the current one through `RunContext`
(`SessionHandle.ts:679-687, 805-838`); every run carries its own
`workingDirectory` (`RunScope.ts:21`, `AgentConfig.ts:59`); bash resolves
cwd from it (`bash.ts:391-393`). What is process-global is only the roots:
`StorageFS` and `WorkspaceFS` are static classes reading the singleton
(`storageFS.ts:18-20`, `workspaceFS.ts:21-26`; 117 and 154 production call
sites), and
none of the session stores take a root (`StreamLogStore.open()`,
`KVStore`, `executionLease.ts:267`, `runStorageFs.ts:29-38`).

`getBasePath` is not the only reader, and re-pointing it alone would leave
the split codex named: `WorkspaceFS.getPath()` and `relativePath()` each
call `platform().workspace` independently and `locatePath()` uses both
(the three accessors at `workspaceFS.ts:21-39`, `locatePath` at 50-51),
so file I/O could target paper B
while path classification still resolved against paper A.

The route is a deletion, not three re-pointings. `WorkspaceProvider` has
exactly one implementation - `createNodeWorkspace`, taken by every host
including the extension (`nodeHost.ts:120`, `extension.ts:388`) - and its
whole body is two already-exported pure functions of the root,
`relativeToRoot(root, filePath)` and `canonicalizeWorkspacePath(root)`
(`nodeWorkspace.ts:51-82`). So `workspace` leaves `platform()` outright
rather than being re-pointed at a session: `WorkspaceRoots.workspace` is
the root, and all three `WorkspaceFS` accessors plus `StorageFS`'s take it
from there and call those functions. One root read per operation and no process-global
workspace left for a second paper to disagree with.

The claim that "every caller stays unchanged" holds only for the Promise
tier, and the boundary has to be enforced rather than assumed. A static
`WorkspaceFS.getPath()` cannot reach an Effect `WorkspaceRoots` from inside
a fiber, and letting it fall back to the async-local lookup is precisely the
cross-fiber bleed 7.3 forbids - Effect's scheduler drains many fibers'
continuations in one turn, so paper B's file operation would resolve against
paper A. So: **Effect code never calls the static classes.** It resolves a
session-scoped file service from `WorkspaceRoots` instead, and the lint that
7.3 already puts on `currentSession()` in `src/controllers/session` covers
`WorkspaceFS` and `StorageFS` too. The unchanged callers are the **run-scoped** ones, which resolve their root
from the run they are inside. Host-scoped callers are not exempt and this
section previously said they were: a `host.request` for paper B - picking,
opening, packing, cleaning - is not inside an agent run, so
`currentSession()` returns the process default
(`SessionHandle.ts:828-836`) and the operation acts on paper A. Every
request already carries its `session` (8.1), so the dispatcher **enters that
session's context before dispatching**, and the async-local lookup resolves
B for the length of the handler. The rule is that nothing resolves a root
from ambient process state: Effect code takes it from `WorkspaceRoots`, and
the Promise tier takes it from a run or from the request that named it.

The other two roots are not that cheap, and this section previously implied
they were. `config` and `workspaceState` have no equivalent choke point:
beside the four shared accessors (`getConfig`, `readPlatformSetting`,
`writePlatformSetting`, `tryWorkspaceState`; 115 call sites, which the
accessors do cover) there are 12 raw `platform().config` and 23 raw
`platform().workspaceState` reads spread across host and core files, and
each resolves the instance built once at startup. With two papers open,
paper B would read and write paper A's settings and UI state. So the four
roots move in two steps, not one: `workspace` and `storage` as above, then
`config` and `workspaceState` as their own named work - the four accessors
resolving the root from context and the 35 raw reads routed through them.

One thing that work must not do is construct a whole config provider per
paper. `openTexraConfigStores` opens a workspace `JsonStore` **and** a
global one, and `JsonStore.get` does not observe writes made through another
instance (`jsonStore.ts:91-100`), so a per-paper provider would leave paper
B reading its open-time snapshot of a global setting that paper A has since
changed. The global store stays process-level and shared; only the
workspace-scoped target is per paper.

That work is a prerequisite of the multi-paper feature, not an optional
follow-up, so lane 6's acceptance covers it: a desktop process may not open
a second paper until both steps have landed. Sequencing the feature behind
it is the alternative to a half-migrated process in which some state is
per-paper and some is not, which is the shape that produces a bug nobody
can reproduce. In Effect
code the roots come from context (7.3); the Promise tier keeps the
async-local lookup. `buildAgentWorkspaceOptions`'s `additionalDirectories`
inference (`agentWorkspaceOptions.ts:26-39`) and `pathResolution.ts:167-179`'s
classification against the process root change with it.

Deleted: `desktopWorkspaceRelaunch` (`main/index.ts:577-596`),
`DESKTOP_WORKSPACE_PATH_STATE_KEY` and the argv plumbing
(`packages/desktop/src/shared/workspacePath.ts`), the read-only cross-paper
index that version 1 proposed (a fourth reader of a file layout the cutover
deletes in the same release), the "foreign run" row kind. The extension's
multi-root "Working directory" select is the same shape at run granularity
and is unchanged.

Sequencing with the cutover: both programs edit `SessionHandle`; the
cutover's `Database` layer takes a root as a layer parameter from day one.
If lane 6 is ready before the cutover branch is cut it lands first and saves
a merge; otherwise the cutover passes the process storage path at its single
construction site and lane 6 swaps that one line.

## 12. The shell

The boards are on the canvas "TeXRA Conversation Shell" (real-component
renders on its "Built with our components" page, produced by the design
harness under `packages/desktop/design-harness/`, untracked). This section
is the spec. Every element names the field it reads; nothing is derived in
a component.

### 12.1 Extension: one surface

- **Header** (38 px): a sessions button (opens the drawer, or is hidden when
  the list is docked), the paper name, then Stop, New task, and an overflow
  menu. The overflow carries Open sessions in editor, Open dashboard, the
  Tools items (LaTeXDiffs…, Figures…, Compile input PDF, Attach TeX Count),
  and the debug Pack and Delete output actions.
- **Stream header**: the existing `stream-header`, which already draws the
  parent link; it gains the full `ancestors` path, capped at 40 percent
  width with per-segment eviction fallback.
- **Empty state (New)**: the desktop hero branch of `MainApp.render`
  ("What are you working on?" with the paper name in the subtitle), the
  "Context and attachments" disclosure hosting the real `file-select-group`,
  which takes its selections from `Surface.launch` and its option lists from
  the `host` snapshot (8.1) as ordinary properties - not from
  `fileStateContext`, which lane 4 deletes along with the rest of
  `@lit/context`; that swap is part of lane 4, not a later cleanup, or the
  component renders with no state. An "Active
  now" strip that is `stream-tabs` filtered to `group !== 'recent'`, and
  the launch composer. Onboarding cards replace the hero while the funnel is
  pending; the five banners sit above the composer.
- **Composer**: one component in two states. Expanded: the textarea, chips
  for agent (with teams as a section and "Manage teams…"), model, mode
  (Interactive, Workflow), and working directory only with two or more
  roots; each chip's menu carries its "…settings" item; polish, dictation,
  attach, send. Compact: the follow-up line with the same trailing controls.
  Above it, "Goes to X · reply to parent instead" from `Surface.selected`,
  `parent`, and `followUpSupport`. Chips collapse into one popover below
  440 px (the existing container query).
- **Drawer** (sidebar) or **docked list** (editor tab, at or above 720 px):
  the real `stream-tabs` with top-level rows in one section per `group`
  arm, in union order - Running, Waiting on you, Interrupted, Recent - and
  the list is written as an exhaustive switch over the union rather than a
  hardcoded set, so a new arm cannot leave a stream with nowhere to appear
  (which is how `interrupted` was almost lost). An Interrupted row's
  primary action is Resume. A rollup pill from `rollup` on collapsed
  parents,
  the path expanded for `forceExpanded` - a pending approval or an
  interrupted descendant, either of which outranks a collapsed override -
  and the Surface's override elsewhere, a header with search and close - **not** a New task
  control, which the main header already carries (one home per action;
  a second button in the drawer is the duplicate that drifts) - and a
  footer with Open sessions in editor. Width `min(320px, 100% - 40px)`.
- **Dispatch card (E2)**: the existing `background-tasks-panel` moved to the
  dispatching row, listing each child's `StreamView` (status, last row,
  elapsed) with its own children indented, and a rollup pill in the summary.
- **Run board (W1)**, inside a workflow stream: a phase strip as
  `wa-tab-group` from `transcript.run` (filled marker for opened phases,
  hollow for declared, a warning badge for a phase with a waiting call), the
  selected phase's rows attention-first exactly as `workflowRunModel` orders
  them (needs a decision, failed, running, then counted folds), Retry and
  Skip on failed rows through the ownership scope, a "Review (y/n)" link on
  a waiting row that navigates to the child's request panel (approvals have
  one home), a tally line, and a controls bar (Next failed, Retry failed,
  Kill run) in place of the composer when `followUpSupport` says the stream
  has no chat.
- **Proposal card (W0)**: a restyle of the existing `ProposalRequestPanel`,
  which already lists phases from the run model; the invented estimate and
  "Open script" fields are dropped.
- **Tools sheet**: a bottom sheet hosting the real `latexdiffs-section` on
  props (base, edited, commit; Diff, Compare, Merge, Accept; Diff against
  commit; Pack, Delete output). Reachable from any state. The desktop gains
  it back; it drops it today.
- **Popped out**: the editor tab and the sidebar are two subscribers, so
  the sidebar shows the same conversation; no placeholder is needed.

### 12.2 Desktop: papers

- **Rail** (288 px, the existing `taskShell.css` classes): brand, New task,
  Search, then a Papers section with one collapsible row per open paper
  (initials, name, and subtitle from that paper's `host` display record, a
  badge from the paper-level `SessionView.rollup`, collapsed per
  `Shell.collapsed`) and its own
  `stream-tabs` nested beneath, then "Add paper…", then the existing footer
  (Terminal, Browser, Logs, Settings). Each paper is one `SessionView` from
  the `LayerMap`.
- **Conversation** (760 px column): the paper chip and stream title in the
  task header, the same conversation and composer as the extension, and a
  dock with the diff count, Compile PDF, and latexdiff-vs-last-commit
  shortcuts into the Tools sheet.
  The desktop keeps its auxiliary IPC alongside this protocol. A PTY streams
  `desktop:terminal:data`, `:exit`, and `:error` into xterm through
  `renderer/messageRoutes.ts:180-190`, which is a continuous byte stream, not
  a session event and not a request outcome - §8.1 and §8.4 carry neither.
  What lane 4 replaces is the **session** dispatcher; the terminal, PDF, and
  browser transports stay. They do not stay _unchanged_: each start message
  becomes session-keyed. `DesktopTerminalStartMessageSchema` carries only an
  id and geometry (`desktopWorkspaceMessages.ts:121-127`) and the one
  `DesktopPtyHost` is built with the process startup `workspacePath`
  (`main/index.ts:1079-1081`), so once §11 removes that root a terminal
  opened on paper B would still spawn in A, reading and writing the wrong
  paper. The transport is auxiliary; the cwd is not.

- **Workbench** (right pane, existing): PDF as a new tab kind (the PDF is a
  dialog overlay today, `pdfOverlay.ts`), editor, terminal (defaults to the
  bottom placement), browser, logs, and a Subagents tab that hosts the
  tree for the active stream and only navigates. No context column; the
  workbench is that surface.
- **Run board** in the conversation pane with a summary line above the
  phase strip; the task header carries only title and status
  (`stream-header` and `usage-panel` already own status and cost).

### 12.3 TUI

Same fields: the child list is `order` and `childIds` with `group`,
`rollup`, and `tone`; the workflow popup is `transcript.run`; the
transcript is `rows` with `settledRows` as the static boundary; Alt+1..9 is
Surface state.

### 12.4 Surface mapping

Every surface the current New view, Sessions view, editor tab, and host
commands render, and its home. "Same" means the component is unchanged.

| Today                                                                                                                                                                                                                                                                         | Home                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| New / Sessions tabs                                                                                                                                                                                                                                                           | Removed; New is the "+" action and the empty state; Sessions is the drawer or the docked list       |
| Open dashboard, Open sessions in editor, Back to sidebar                                                                                                                                                                                                                      | Gear in the header; the others in the overflow and the drawer footer                                |
| Loading skeleton, onboarding cards                                                                                                                                                                                                                                            | Empty-state body while the funnel is pending; same components                                       |
| API key, agent config, dependency, getting-started, login banners                                                                                                                                                                                                             | Above the composer in the empty state; a thin strip above the follow-up in a session; same          |
| Interactive / Workflow, Agent / Team radios                                                                                                                                                                                                                                   | Composer chips with menus                                                                           |
| Session hint callout                                                                                                                                                                                                                                                          | Under the composer; same                                                                            |
| Polish, dictation, image paste, file drop                                                                                                                                                                                                                                     | Composer, both states; same controllers                                                             |
| Working directory select                                                                                                                                                                                                                                                      | Composer chip, only with two or more roots                                                          |
| Agent, team, model selects and their settings gears                                                                                                                                                                                                                           | Chips; gear becomes a "…settings" menu item                                                         |
| Run agent (Cmd+Alt+E)                                                                                                                                                                                                                                                         | Send; accelerator stays                                                                             |
| Debug Pack output, Delete output files                                                                                                                                                                                                                                        | Overflow, debug section                                                                             |
| Input, Context, Media groups and their menus                                                                                                                                                                                                                                  | "Context and attachments" disclosure; wand and wrench items also in Tools; same `file-select-group` |
| LaTeXDiffs section                                                                                                                                                                                                                                                            | Tools sheet, any state, real component                                                              |
| Empty states, getting-started buttons                                                                                                                                                                                                                                         | The one empty state                                                                                 |
| Rail rows, tree, expand, delete                                                                                                                                                                                                                                               | Drawer or docked list; same `stream-tabs` plus groups and rollups                                   |
| Stream header and its toolbar (stop, fresh run, resume, setup in main view, task storage, export, copy context, latexdiff, clean, pack; bypass toggles; compact)                                                                                                              | Same; "Setup in main view" becomes "Edit as new task"; toggles become `setPolicy`                   |
| Tasks, Plan, Background tasks, Command panels                                                                                                                                                                                                                                 | Same; Background tasks becomes the dispatch card                                                    |
| Transcript rows, inline copy, compaction, terminal output; the completion chime moves to the host (one per process, not one per subscriber - `TaskGroupList.ts:299-311` plays it from a renderer transition hook today, so two open views would chime twice for one workflow) | Same                                                                                                |
| Request panels, approve split button                                                                                                                                                                                                                                          | Same; the run board's rows link here                                                                |
| Latexdiff results, generated files with per-file verbs                                                                                                                                                                                                                        | Same                                                                                                |
| Follow-up composer, queued messages                                                                                                                                                                                                                                           | Same, plus the "goes to" line                                                                       |
| Usage footer                                                                                                                                                                                                                                                                  | Same                                                                                                |
| view/title menus                                                                                                                                                                                                                                                              | Keyed on the re-derived context key; New Session is the "+" command                                 |
| Show Launcher, Show Progress, Toggle, Open in editor tab                                                                                                                                                                                                                      | New task; focus conversation; toggle drawer; unchanged                                              |
| Status bar item                                                                                                                                                                                                                                                               | Unchanged                                                                                           |
| Desktop-only hero, disclosure, composer dock, Run mode select, always-open follow-up                                                                                                                                                                                          | The shared empty state and composer on both hosts                                                   |

## 13. Ledger collapses outside the critical path

Independent pull requests, any time, files that lanes 3 and 4 do not touch:

- Desktop tour (second onboarding state machine, about 500 lines;
  `desktopOnboarding.ts:83`, `desktopOnboardingIpc.ts:74, 147`): delete or
  fold as a funnel state.
- "Refresh and post three catalogs" written four times and `loadOptions`
  twice (`MainViewStartupController.ts:71`, `mainViewCommands.ts:36-58`,
  `MainViewProvider.ts:266-292`, `desktopAgentSettingsController.ts:248-279`,
  `optionsLoader.ts:7-18`, `desktopMainViewStartup.ts:40-46`): one
  `loadMainViewOptions` in `src/controllers/mainView`.
- CLI team plan restating the catalog ports (`multiAgentRunPlan.ts:86, 104-113`);
  default agent picked twice with different orders (`defaultAgents.ts:39-50`
  vs `catalogSlice.ts:36-50`); default model twice (`runModel.ts:29` vs
  `mainViewActions.ts:95`): one `pickDefaultAgent`, one `decideRunModel`.
- Desktop settings handlers mirroring the extension's (`desktopSettingsIpc.ts:174-182, 319-416`):
  into `SettingsViewHost`. Settings snapshot poster tables twice: one table
  with two host hooks.
- Resume wrappers with the same latch idiom (`resumeFromResumeData.ts:18-38`,
  `desktopAgentResume.ts:38-78`): one controller in `resumeStreamPresentation.ts`.
- File-category enumerations, four copies: one `MULTI_FILE_LISTS` in
  `src/shared`. `gettingStarted` visibility with three producers: one owner.
- Status tone column and one terminal-state vocabulary (section 5.3);
  copy moves ("Thinking", todo labels, "No runs yet", "Approve this X (y)",
  "Latexdiff results (N)", "Phase N of M") into `src/shared/copy`.
- Validated launch as a tagged type (section 15).
- Desktop execution residue with extension twins never extracted either:
  pack and clean result switch, latexdiff context, recording, spill
  artifact, restore run config (`desktopAgentExecution.ts:130-137, 570-642,
1070-1139, 509-524, 733-761, 1148-1166` and their extension
  counterparts): into `src/controllers`.
- Open-file on the desktop drops the line number and bypasses the Monaco
  pane (`desktopPreviewHost.ts:61`): fix with the dispatcher collapse.

Inside lanes 3 and 4: bypass mirrors, decision mappers, inquiry dismiss,
merge config, launch parses, `UserMessage` summary re-derivation
(`UserMessage.ts:204-252`, paint `row.summary`), the tool-row predicates,
`childRowMetadataText`.

## 14. Build order

Critical path: lane 1, then lane 2, then lane 4, then lane 8. At most three
worktree lanes open. Each host switches in one pull request. Deletions ship
with their replacement.

| Lane                    | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Depends on                                                                                                                      | Parallel with | Touches                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------- |
| 1 Foundation            | `sessionView.ts`, `sessionFold.ts` (pure, incremental), `runtimeRequest.ts`, `requestErrors.ts`, the pure-fold test; all eight event changes of section 6, each landing with every consumer of that event in the same PR (see the note below); the `removeStream` to `stream.removed` rename, cut before add (section 6), with the NDJSON projection keeping its `removeStream` line byte-identical; local runtime state as a fold input; compensation and tombstone gates re-keyed; **decision 9's identity change, which this lane depends on** - fresh stream and execution ids per launch, `checkpointId` as the resume anchor on `run.start`, and the workflow launch lease moved to the checkpoint | nothing; in-memory; stays out of `src/transcript` stores, `src/agent/storage`, `persistedFlow` while the cutover branch is open | 6, 7          | `src/shared/session`, `src/agent/trace/events.ts`, `AgentLaunchContext.ts`, `SessionFactApplier.ts` |
| 2 Effect services       | `SessionEvents` with `listing()`, `all(fromCommit)`, `aggregate(id, fromSeq)`, one `data_version` poll per database, and the uninterruptible publish, `SessionViewService` with its subscription set as a fold input, `WorkspaceRoots`, `sessionLayer` through `LayerMap`, `toSignal`, `SessionRequests`, the process runtime at each entry, `loopbackLogin` migrated, `it.effect` suites with `TestClock`                                                                                                                                                                                                                                                                                               | 1                                                                                                                               | 6, 7          | `src/controllers/session`, `SessionEventHub.ts`, `src/shared/signals.ts`, host entries              |
| 3 TUI                   | section 10.1, one pull request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 2                                                                                                                               | 4, 5          | `packages/cli`                                                                                      |
| 4 Extension and desktop | section 10.2, one pull request; measure the bundle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 2                                                                                                                               | 3, 5          | `packages/extension`, `packages/desktop`, `src/controllers/progressView`                            |
| 5 Headless and SDK      | section 10.3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 2                                                                                                                               | 3, 4          | `packages/cli/src/runtime`, `packages/agent`                                                        |
| 6 Session roots         | section 11                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | none; coordinate with the cutover                                                                                               | 1, 2          | `SessionHandle.ts`, `storageFS.ts`, `workspaceFS.ts`, `packages/desktop/src/main`                   |
| 7 Ledger collapses      | section 13, disjoint ones as filler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | none                                                                                                                            | 1, 2, 6       | files lanes 3 and 4 do not touch                                                                    |
| 8 Shell                 | section 12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 4, 6                                                                                                                            |               | `packages/extension` frontends, `packages/desktop/src/renderer`                                     |

**On decision 9 in lane 1.** Final tombstones and reclaimed deterministic
ids cannot both be true: today a deleted workflow stream's id is reclaimed
(`claimStreamIdentity`), so a relaunch after this lane would collide with
its predecessor's tombstone, and every stale bare-id reference this lane
introduces would address the new run. The identity change is a prerequisite
of the fold, not a follow-up to it.

**On "every consumer" in lane 1.** The frozen wire is not the only one.
Deleting `setActiveStream` also touches `ProgressBackend.applySessionFact`,
the TUI's `sessionSignalsAdapter`, and `desktopProcessStores`, none of which
switch to `SessionView` before lanes 3 and 4 - so lane 1 adapts them to
`run.start` for creation and `run.activate` for activation, since a resume
mints no start and would otherwise bypass their activation and presentation
paths. It adapts `sessionProgressSubscription.ts` the same way, which
ignores `run.start` and forwards the goal and follow-up payloads verbatim.
Without this the "independently mergeable" claim is false: the tree either
fails to typecheck or runs with hosts that have lost creation, focus, and
activation handling.

### Acceptance per lane

- **1:** the fold is pure (no `effect`, no `platform()`, no Node built-ins;
  importable from the browser bundle); `fold` over a recorded event log of a
  fan-out session reproduces today's `stream-tabs` rows, `background-tasks`
  rows, and `workflowRunModel` output; the presentation-boundary test
  rejects draft and recording names in `sessionView.ts` and the durable
  session-fact schemas - **not** every shared schema, or it would reject
  `HostSnapshot.recording`, which is process state and belongs on the wire
  (8.1, 9); every stream kind
  has a `run.start`; a launch that fails after reservation folds to failed;
  the same log with an empty `local` folds every pending approval to
  interrupted, never waiting.
- **2:** one runtime per process entry; no `runSync` outside entries and
  bridges; `SessionEvents.publish` under one permit; a `TestClock` test
  shows the 16 ms framing and the live-owner waiting rule; `LayerMap`
  builds one graph per root and one only.
- **3 and 4:** the deletes column is empty; the host shows the same rows,
  groups, rollups, breadcrumbs, and run board as the other host for the
  same event log; the sidebar and the editor tab show the same conversation
  at once; the bundle delta is recorded.
- **5:** NDJSON output byte-identical to today's for a recorded session -
  the projection is unchanged and still reads events (10.3), so the lane
  proves the event stream reaching it is unchanged;
  `workflowPlainOutput`'s private fold gone.
- **6:** two papers open in one desktop process, each writing to its own
  root - including its own settings and workspace state, both steps of the
  root migration landed (section 11), since a half-migrated process is the
  bug nobody can reproduce; `WorkspaceProvider` and the relaunch code gone.
- **8:** every element on the canvas boards reads a named field; the surface
  mapping has no row without a home.

## 15. Enforcement

By construction:

- `HostInteractions` already has one implementation (`HostInteractions.ts:403`);
  hosts attach through `interactions.use()`. Lanes 3 and 4 delete the
  decision mappers that were the dual. No pin needed.
- `SessionRendererPort` is deleted by the **last** host lane to switch
  (lane 5 on the current order), not by lane 2. `sessionSignalsAdapter.ts`,
  `LitSessionRenderer.ts`, and `runProgressRenderer.ts` still implement or
  consume it until lanes 3, 4, and 5 respectively, so deleting it in lane 2
  would break the lane that is supposed to be independently mergeable. No
  pin needed either way.
- Workflow skip, retry, and kill exist only as methods on the
  `ExecutionInteractionScope` returned by `ownership.open()`.
- `@lit/context`: both providers deleted in lane 4; an eslint
  `no-restricted-imports` on the webview directories is the pin.
- Status tone: a `tone` field on the one `STREAM_STATUS_LABELS` table; a
  second map is dead code knip catches.
- File-list enumeration, default agent, default model: shared `as const`
  tables and one function each; duplicates become dead exports.
- Validated launch: `ValidatedExecutionRequest.config` becomes a tagged
  type constructible only inside `executionRequests.ts`; `runAgent` and
  `resumeRun` take that type, so the four raw host parses
  (`executeCommand.ts:46`, `setupAssistantCommand.ts:231`,
  `AgentReviewService.ts:293`, `chatSessionController.ts:450`) fail
  typecheck. This is the repo's first tagged type (none exist today); the
  two core-side synthetic configs (`bash.ts:505`, `claudeAgentConfig.ts:252`)
  route through the same function.

As tests:

- `sessionPresentationBoundary.vitest.ts` extended to fail on `followUpText`,
  `recording`, `polishedText`, `transcribedText`, `shouldFocusFollowUp` in
  `sessionView.ts` and the durable session-fact schemas - **not** in every
  shared schema, which would reject `HostSnapshot.recording` (§9), a
  process-fact that belongs on the wire and lives in the shared
  `sessionFrames.ts` by Appendix B. The rule is about what may become
  session state.
- Transitionally, one renderer-port implementation per host until lane 2
  lands.
- An architecture test that fails when a host package computes topology,
  grouping, rollups, ordering, settlement, or a run model from entries or
  facts rather than reading `SessionView` (hardcoded allowlist, like the
  existing kernel tests).

## 16. Risks

| Risk                                                                                       | Mitigation                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effect 4 is a release candidate; names move (`Schema.TaggedError` already renamed on main) | Pin the version the substrate pinned; use `Data.TaggedError`; Appendix A is the verified vocabulary; the guides are older than the package, the package wins                                  |
| Quadratic fold on fan-out sessions                                                         | Incremental per stream arm, run memoized on `(commitOrdinal, childRevision)`; measured against a recorded 31-call run at lane 1                                                               |
| Webview bundle growth                                                                      | 61 KB gzipped measured; Schema excluded; re-measure against a production build at lane 4                                                                                                      |
| Reconnect loses in-flight text                                                             | Chunks carry `from`/`to`, so adjacent ones coalesce losslessly and text never drops; a reconnect is answered with a `from: 0` chunk per in-flight row                                         |
| A late chunk mutates settled text                                                          | Durable text wins: a chunk for a row whose finalizing event has folded is discarded, so the merge order of the three arms cannot change the result (5.2)                                      |
| A webview folds another paper's events                                                     | `SessionFrames` is per session; the port is demultiplexed once at decode, so the key is not a runtime value below it (7.1)                                                                    |
| Owner liveness stale in a webview                                                          | Snapshot on every change and every subscribe; an empty snapshot folds to interrupted, the safe direction                                                                                      |
| Replay-then-tail gap                                                                       | There is no tail to race: one cursor-driven read of the table per observed commit level, so replay and live are the same code path (7.1)                                                      |
| Another process commits an event this one never sees (the hub is process-local)            | A poll of `PRAGMA data_version` joins the local level as a trigger, never a level; both only say the table moved, and every subscriber reads forward from its own position (7.1, contract C7) |
| Two event sources interleave out of order                                                  | There is one source: the table. The wakes carry no payload, so nothing can arrive ahead of the read they trigger (7.1)                                                                        |
| A commit lands between a read and its subscribe                                            | Both wakes replay on subscribe: the `SubscriptionRef` its current level, the poll its first `data_version` sample; neither is an edge (7.1)                                                   |
| Live text is invisible to a non-owning process                                             | Accepted and scoped: chunks never leave the owning process; others render the settled prefix, which the mandatory `finalText` keeps complete (5.2, 7.2)                                       |
| Async-local session lookup inside Effect fibers                                            | Forbidden in Effect code; roots from context; lint the import in `src/controllers/session`                                                                                                    |
| Two programs editing `SessionHandle`                                                       | Lane 6 before the cutover branch if ready; otherwise one-line swap after                                                                                                                      |
| Convergence adds lines                                                                     | Measured per lane; framed as one-state and deletion wins, not line counts                                                                                                                     |
| `TranscriptIndex` deletion regresses render                                                | Measure plain rebuild first; keep if it does not hold                                                                                                                                         |
| Three-column desktop needs width                                                           | Below about 1100 px the workbench collapses as it does today                                                                                                                                  |

## 17. Decisions for ratification

1. This PRD's rules G1 to G7, and the migration PRD's R1 to R3 and R5 to
   R10 as they apply to lane 2 onward.
2. Add `@effect/vitest` at the pinned release candidate (peers match the
   repo's vitest 4.1). The only package this PRD adds.
3. Amend the CLAUDE.md rule "serialize async work with `p-queue`" to: in
   Effect code, use `Semaphore`, `Queue`, and fiber supervision; `p-queue`
   remains the rule for the Promise tier until it is folded.
4. Name: `SessionView` for the value, `SessionViewService` for the service,
   `SessionState` for the class that owns it. The shape is settled; the
   names are the owner's.
5. Legacy transcripts are normalized into canonical events at the import
   boundary and the fold has no legacy arm (5.2, section 6). An old entry
   the canonical set cannot express is dropped by the importer with a
   `warn`. The exported-trace reader (`TraceStreamLogEntrySchema`) is a
   permanent boundary and is unchanged.
6. **Resolved by contract C7 (2026-09-04):** the cross-process wake is a
   poll of `PRAGMA data_version` followed by `all(cursor)` - a trigger only,
   never a level, because the pragma is connection-local, does not move for
   the connection's own commits, and resets on reconnect - and the only
   ordinal is the `AUTOINCREMENT` `commit` column. The earlier text, kept
   for the record: the durable store
   exposes `commits`, **the session's actual commit ordinal**, readable at
   any time (7.1). Not an independent generation: 7.1 merges it with this
   process's own level and compares once, so a source reporting 100 while
   the table is at 50 suppresses real ordinals 51-100 and leaves
   cross-process readers stale. The ordinal must **never decrease and never
   reuse a value** - a persisted generation or a non-reusing sequence, not a
   WAL frame count (a checkpoint resets it) and not `MAX(rowid)` (retention
   lowers it, and without `AUTOINCREMENT` the value is reused). A store that
   can offer neither wakes unconditionally on a timer instead. Without it a process that only reads
   goes stale whenever another process owns the run.
7. `WorkspaceProvider` leaves `platform()` rather than being re-pointed at
   a session (section 11). It has one implementation and its body is two
   pure functions of the root, so the port is the process-global, not a
   wrapper around one.
8. The frozen NDJSON wire is a projection of the event stream, not a reader
   of `SessionView` (10.3). The fold renders; the event stream serializes.
9. **A `StreamTabId` names a run, not a name: it is minted fresh per launch
   and never reused.** The deterministic workflow identity becomes a label
   on the stream rather than the stream's id.

   This one is answered rather than offered, and the evidence is why. A
   deleted deterministic stream is reclaimed today (`claimStreamIdentity`,
   `SessionState.ts:487-501`), so an id names a name, and every reference to
   one is ambiguous until it is paired with an `executionId`. Successive
   review rounds found that single ambiguity in **thirteen** places: the
   tombstone, the `parent` link, `setParentStream`, `run.activate`, every
   stream-scoped request, the misc request arms, conversation drafts, queued
   follow-ups, in-flight text, the dictation destination, and the unreadable
   holds. Each was found separately, each was individually correct, and none
   of them fell out of the design. Thirteen fences for one ambiguity is the
   definition of patching where the defect is not, and this repo's rule is
   to make a state unrepresentable before writing a guard for it.

   Minting per launch deletes all thirteen, plus `_streamIncarnations`,
   `_removedStreams`' generation compare, and the reset-on-`run.start` rule.
   A tombstone becomes final; `run.start` is seq 1 of its stream;
   `StreamKey` is a `StreamTabId` again; `target` is a bare id.

   **The anchor moves down one level, and that is the whole of the cost.**
   A workflow derives its execution id from its checkpoint and its stream id
   from that - `runExecutionId = deriveExecutionId({ checkpointId })`, then
   `runStreamId = getStreamTabId(STREAM_PREFIX, { executionId })`
   (`WorkflowScriptTool.ts:345-353`) - so a relaunch re-roots registration,
   stream, and grandchildren, and resume replays completed calls (#8712).
   The stable thing in that chain is the **checkpoint id**; deriving the
   other two from it conflated "which checkpoint" with "which run".

   So both ids mint per launch and `checkpointId` becomes the resume anchor:
   it rides the `run.start` payload, a relaunch finds its checkpoint by it,
   and replay is unchanged. **The lease moves with it.** The deterministic
   execution id is not only a resume anchor today, it is a mutual-exclusion
   key: a relaunch while the prior run is in flight shares that id, so the
   fresh-lease acquisition fails closed rather than starting a second run
   over one journal (`WorkflowScriptTool.ts:465-477`). Fresh ids would
   remove that guard, so a workflow launch takes a lease on its
   `checkpointId` as well as its execution - the journal is the shared
   resource, so the exclusion belongs on the journal's identity, not on a
   run id that happened to be derived from it. Same correction as the resume
   anchor, applied to exclusion. Reusing the execution id instead - what an
   earlier draft of this decision proposed - is not merely redundant but
   unsafe: two live rows would share one execution id, and deletion resolves
   a stream to its execution and deletes that execution's state
   (`SessionStores.ts:409-412, 447`), so deleting the older row would take
   the newer row's checkpoint with it.

   With both ids per launch, `executionId` is 1:1 with the stream id, the
   workflow arms take a bare `streamId`, and all thirteen fences go. What
   changes visibly is that a relaunched workflow appears as a new row rather
   than reusing its old tab - which is what the user asked for when the old
   row was deleted, and a behaviour change when it was not. That is the
   thing to weigh.

   **If the owner disagrees, reverting is mechanical** - re-pair each id with
   an `executionId` at the thirteen sites, whose individual arguments are in
   this PR's review history. What the document should not do is carry
   thirteen fences and call the question open.

Already agreed with the persistence owner and recorded in the companion
proposal (in flight in another branch, see Lineage): the eight event changes
of section 6; Effect Schema nowhere; the publisher
invariants of 7.1; `WorkspaceRoots` as the `Database` layer's parameter;
the two v4 traps.

## 18. Verified and not verified

Verified in this session: every file reference above (read directly or
reported by a read-only survey and spot-checked); every rc.112 API in
Appendix A against `node_modules/effect/dist`; the bundle numbers with the
repo's esbuild; the setup guide's toolchain finding (the language-service
patch cannot run under the TypeScript 7 native compiler; editor diagnostics
work through the TS 6 tsserver).

Corrected in this revision after re-checking the dist: the tail names are
`Stream.toQueue(stream, { capacity })` and `Stream.unwrap` (the v3
`toQueueScoped` and `unwrapScoped` are gone; 7.1 no longer needs the queue
at all); the Cause-tapping combinator
is `tapCause`, not `tapErrorCause`; and rc.112 exports no `catch` or
`catchAll` (the family is `catchTag`, `catchTags`, `catchCause`,
`catchDefect`, `catchReason(s)`, `catchIf`, `catchFilter`,
`catchNoSuchElement`, `catchCauseIf`, `catchCauseFilter`, `catchEager`).
`Stream.mergeAll(streams, { concurrency })` and `Effect.die` are present.

Not verified, to confirm at lane start: the `PRAGMA data_version` poll
interval and its cost on a laptop (contract C7; it is a trigger, not a
level, so no shape question remains); whether
`TranscriptIndex` can be deleted without a render regression; net lines
after each lane; the render cost of the memoized run model at fan-out
scale.

---

## Appendix A. Verified Effect 4 rc.112 vocabulary

| Concept           | rc.112 API                                                                                       | Import           | Note                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------- |
| Service key       | `class X extends Context.Service<X, Shape>()('@texra/…')`                                        | `effect`         | `Context.Tag`, `ServiceMap`, `Effect.Service` do not exist in rc.112                                 |
| Layer from effect | `Layer.effect(X, effect)`                                                                        | `effect`         | strips `Scope`; `Layer.scoped` does not exist in v4                                                  |
| Layer helpers     | `Layer.succeed`, `Layer.sync`, `Layer.mergeAll`, `Layer.provide`, `Layer.provideMerge`           | `effect`         | store parameterized layers in constants (memoized by reference)                                      |
| Keyed layers      | `LayerMap.make((key) => layer, { idleTimeToLive })`, `.invalidate`                               | `effect`         | RcMap-backed                                                                                         |
| Partial fakes     | `Layer.mock(X, partial)`                                                                         | `effect`         | real, @since 3.17; hand-written `testLayer` preferred                                                |
| Commit level      | `SubscriptionRef.make(0)`, `.update`, `SubscriptionRef.changes`                                  | `effect`         | replays its current value on subscribe, so no wake is missed (7.1); `PubSub` is an edge, not a level |
| Fold              | `Stream.scan(initial, f)`                                                                        | `effect`         | emits initial first, then one state per element                                                      |
| Merge inputs      | `Stream.merge(a, b)`, `Stream.mergeAll(streams, { concurrency })`                                | `effect`         | events, liveness, and text chunks into one fold; `concurrency` is required                           |
| Cursor read loop  | `Stream.unwrap(effect)`, `Stream.flatMap(f, { concurrency })`, `Ref.make`/`Ref.get`              | `effect`         | one ordered read per wake (7.1); the v3 `toQueueScoped` / `unwrapScoped` do not exist                |
| Poll trigger      | `Stream.tick(interval)`, `Stream.mapEffect`, `Stream.changes`, `Stream.filterEffect`             | `effect`         | the `data_version` poll (7.1): a trigger, never a level                                              |
| Subscription set  | `Stream.switchMap(f)`                                                                            | `effect`         | reopen the transcript reads when the set changes (7.2)                                               |
| Atomic section    | `Effect.uninterruptible(effect)`                                                                 | `effect`         | around append plus fan-out under the permit                                                          |
| Ref               | `SubscriptionRef.make(a)`, `SubscriptionRef.changes(ref)`, `.set`, `.update`, `.getUnsafe`       | `effect`         | no coalescing; no `Stream.fromSubscriptionRef`                                                       |
| Framing           | `Stream.groupedWithin(n, "16 millis")`, `Stream.buffer({ capacity, strategy })`, `Stream.concat` | `effect`         | `Duration.Input` accepts `"16 millis"`                                                               |
| Sink              | `Stream.runForEachArray(stream, f)`, `Stream.runForEach`                                         | `effect`         | coalesce by taking the last element                                                                  |
| Fork under scope  | `Effect.forkScoped(effect)`                                                                      | `effect`         | inside `Layer.effect`                                                                                |
| Resource          | `Effect.acquireRelease(acquire, release)`, `Effect.scoped`, `Scope`                              | `effect`         | interaction scope                                                                                    |
| Serialize         | `Semaphore.make(permits)`, `.withPermit`, `.withPermits(n)`                                      | `effect`         | own module; `Effect.makeSemaphore` does not exist                                                    |
| Queue             | `Queue.bounded/sliding/dropping/unbounded<A, E>`, `offer`, `take`, `takeAll`                     | `effect`         | v4 queues carry an error channel                                                                     |
| Errors            | `class E extends Data.TaggedError('E')<{…}> {}`                                                  | `effect`         | yieldable; `catchTag`, `catchTags`, `orDie`, `tapCause`; no `tapErrorCause`, no `catch`/`catchAll`   |
| Defect            | `Effect.die(defect)`                                                                             | `effect`         | no `Effect.dieMessage`; the transport layer's `publish` (7.1)                                        |
| Tracing           | `Effect.fn('X.method')(function* (…) {…})`                                                       | `effect`         | every named service method                                                                           |
| Runtime           | `ManagedRuntime.make(layer)`, `.runPromise(effect, { signal })`, `.runFork`, `.dispose()`        | `effect`         | one per process                                                                                      |
| Test clock        | `TestClock.adjust`, `TestClock.layer()`, `TestClock.withLive`                                    | `effect/testing` | also `TestConsole`, `FastCheck`                                                                      |
| Test runner       | `it.effect`, `it.layer`                                                                          | `@effect/vitest` | not installed; decision 2                                                                            |

## Appendix B. File layout

No barrels; import the defining module through the existing aliases.

```
src/shared/session/sessionView.ts        Zod SessionView (with folded: Map<AggregateId, Seq>), StreamView, TranscriptView; z.infer types
src/shared/session/sessionFold.ts        fold(view, input): pure; no effect import; no platform(); the per-aggregate seq rule, the residency drop, and the eviction on a subscription-set change (5.2)
src/shared/session/runtimeRequest.ts     Zod RuntimeRequest, HostRequest, Outcome
src/shared/session/requestErrors.ts      Data.TaggedError NotOwner | Unavailable | Rejected | Invalid
src/shared/signals.ts                    + toSignal(runtime, changes, initial)
src/shared/copy/streamStatus.ts          one status label table with tone; one terminal-state vocabulary
src/controllers/session/SessionEvents.ts     Context.Service; durableLayer (publish under one permit; the three reads listing(), all(fromCommit), aggregate(id, fromSeq); one data_version poll per database fanned out through one SubscriptionRef) and transportLayer
src/controllers/session/sessionSources.ts    LocalRuntimeSource, TextChunkSource, TranscriptSubscriptions (a SubscriptionRef of { id, fromSeq }[]); a runtime and a webview layer each; the runtime's TranscriptSubscriptions is fed by the subscribe handler, the webview's by the shell
src/shared/session/sessionFrames.ts          Zod EventsFrame, Subscribe, Response, TextChunk, LocalRuntimeState, HostSnapshot; SessionFrames (per session; listing(), events(fromCommit), aggregate(id, fromSeq))
src/controllers/session/SessionView.ts       Context.Service; ref + changes; subscription set as a fold input; cold hydrate listing() then the subscribed aggregates then all(now); fold fiber forkScoped
src/controllers/session/WorkspaceRoots.ts    Context.Service; Layer.succeed per session
src/controllers/session/SessionRequests.ts   request(): Effect<Outcome, RequestError>; ownership scope
src/controllers/session/sessionLayer.ts      per-session graph; LayerMap keyed by root
src/agent/runtime/SessionEventHub.ts         rewritten as the durable publisher + commit level (7.1)
<host entry per process>                     ManagedRuntime.make(processLayer); the only run* sites
src/test-kernel/controllers/session/*.vitest.ts     it.effect + TestClock
src/test-kernel/shared/session/sessionFold.vitest.ts plain vitest, pure
```

The fold lives in `src/shared` or `src/controllers`, never `src/utils` (the
browser-safe utils gate counts reachable modules). The event schema the fold
consumes is Zod under `src/shared/schemas`, so `src/shared` gains no
`@agent/*` import (`dependencyDirection.vitest.ts:57-67`).

## Appendix C. Evidence index

Layers and duals with their locations, as classified on 2026-09-03; the
full ledger with verdicts is `docs/proposals/2026-09-03-projection-adapter-ledger.md`.

- Session read path:
  - `src/controllers/progressView/backend/LitSessionRenderer.ts:47, 142, 211, 460, 503`
  - `WebviewBridge.ts:11, 33-35, 115-121, 132`
  - `packages/extension/src/progressView/frontend/slices/*` (1,205 lines)
  - `store.ts:88, 142`
  - `progressState.ts:119, 137, 145-168, 261, 385`
  - `streamTree.ts:22-25, 36-40, 86-99`
  - `components/messageIndex.ts:93, 228-559`
  - CLI `state/subscribeStreamLog.ts:56, 151, 520-575`, `transcriptFold.ts:550, 813, 900`, `streamViews.ts:26-34, 130-139, 180-206`, `childExecutions.ts:70-110`, `approvalQueue.ts:195-203`, `sessionSignalsAdapter.ts:53-109, 236, 262`
- Wire and infrastructure:
  - `src/shared/ipc.ts` (244 commands)
  - `src/shared/schemas/progressView/inbound.ts:262-312`
  - `mainView/inbound.ts:308-322`
  - `src/shared/signals.ts:39-54`
  - `streamContexts.ts:56-175`
  - `mainViewContexts.ts:19-24`
  - `MainApp.ts:229-234`
  - `StreamConversation.ts:87-142`
  - `src/shared/state/PersistedState.ts:18-36, 76`
  - `webview/frontend/persistence.ts:63, 174-309`
  - `progressView/frontend/webviewStorage.ts:12`
  - `pendingStateManager.ts:9-14`
  - `ProgressPresentationState.ts:13-49`
- Write path:
  - `HostInteractions.ts:353-378, 403`
  - `progressHostInteractions.ts:90, 105, 363-439`
  - `ProgressViewCommandHandlers.ts:133, 305-312, 334, 361, 378-395, 437, 449-455, 601-618`
  - `ProgressViewMessageHandler.ts:238, 515-524, 677-700, 699-808, 869-880`
  - `desktopAgentExecution.ts:284-447, 670, 771-794, 796-799, 925-926`
  - `progressFollowUpSubmit.ts:37-86`
  - `chatSubmitDriver.ts:118, 206, 233, 255-270, 279-338`
  - `chatSessionController.ts:408-430, 450-862`
  - `approvalAdapter.ts:53, 96, 151-153, 261-268`
  - `settleApprovals.ts:159`
  - `subscribeApprovals.ts:143, 156-176, 306-344, 861-874`
  - `workflowControlRegistry.ts:9-10, 30-41`
  - `executionInteractionOwnership.ts:34-56`
  - `executionRegistry.ts:125-131, 405-613`
- Facts and lifecycle:
  - `SessionEventHub.ts:23-55, 78-100`
  - `src/agent/trace/events.ts:91-105, 373-393, 410`
  - `AgentLaunchContext.ts:93, 412-421, 602-605`
  - `childStream.ts:124, 174`
  - `SessionFactApplier.ts:201, 255, 286-300, 641-646, 667-690, 772, 937-942`
  - `streamTabInfo.ts:57-63`
  - `streamInfoUtils.ts:24-42`
  - `RunContext.ts:78, 159-161`
  - `SessionHandle.ts:108-140, 679-687, 805-838`
- Roots and desktop:
  - `src/platform/platform.ts:38-75`
  - `storageFS.ts:18-20`
  - `workspaceFS.ts:21-26`
  - `StreamLogStore.ts:400-406`
  - `KVStore.ts:44-58`
  - `executionLease.ts:35-40, 267`
  - `runStorageFs.ts:29-38`
  - `agentWorkspaceOptions.ts:26-39`
  - `pathResolution.ts:167-179`
  - `bash.ts:391-393, 505`
  - `packages/desktop/src/main/index.ts:267-268, 276, 577-596, 1202-1232, 1366-1383`
  - `desktopTaskShell.ts:26-68, 472-476`
  - `pdfOverlay.ts:39-45`
  - `desktopPreviewHost.ts:61, 88-97`
  - `renderer/main.ts:288-294, 372-389, 416-470, 1031-1080`
  - `renderer/messageRoutes.ts:92-102`
  - `desktopIpcTypes.ts:119-139`
- Paint:
  - `src/shared/transcript/toolRowModel.ts:58-61, 287`
  - `toolRowSections.ts:565, 661`
  - `transcriptRow.ts:108-113, 185, 222-227, 237-241`
  - `projectTranscriptRow.ts:377, 557`
  - `streamStatusDisplay.ts:42-82, 174-212`
  - `statusIndicatorStyles.ts:26-55`
  - `StreamTab.styles.ts:29-46`
  - `groupStyles.ts:23-38`
  - `BackgroundTasksPanel.ts:248, 540-622`
  - `SubagentListDisplay.ts:22-40, 63, 70-89`
  - `toolFormatters.ts:60, 67, 78-93, 106, 131-136`
  - `toolRenderers.tsx:161-171, 259-272, 354-365`
  - `transcriptRowLines.ts:23-24, 36, 80, 130, 146-152`
  - `UserMessage.ts:204-252`
  - `workflowPlainOutput.ts:32-42, 65-66, 86-90, 114-137, 153-184`
  - `runProgressRenderer.ts:124-133, 180-203, 276-280, 410-420, 524-530`
  - `sessionProgressSubscription.ts:66-186`
  - `packages/agent/src/index.ts:78-150, 245`
- Shell:
  - `src/shared/wa/viewHeader.ts:34-75`
  - `MainViewProvider.ts:100-105, 213-236, 405-438`
  - `ProgressViewProvider.ts:50-60, 98-104, 213-231, 236, 248-257, 275-305, 318-322, 349, 430-438`
  - `ProgressViewMessageHandler.ts:300-307`
  - `packages/extension/package.json:652-677`
  - `InstructionPanel.ts` (784 lines)
  - `FollowUpInput.ts:79-104, 174-260`
  - `FollowUpInput.styles.ts:135`
  - `ConversationContent.styles.ts:116`
  - `StreamHeader.ts:309-375, 668-689`
  - `StreamTabs.ts:130-142, 380-398, 419-424, 506`
  - `LatexDiffsSection.ts:197-248`
  - `FileSelectGroup.ts:68`
  - `MainApp.ts:129, 141, 280-296, 529-583, 595-627`
  - `ProgressApp.ts:109-135, 138-200, 243, 268-272`
  - `packages/desktop/src/renderer/taskShell.css:9-135, 466-540, 706-800`
  - `taskShell.ts:40-200`
  - `docs/prds/2026-05-08-electron-shell-layout.md` sections 6, 12
