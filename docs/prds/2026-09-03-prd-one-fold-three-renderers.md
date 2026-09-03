---
created: 2026-09-03
updated: 2026-09-03
---

# PRD: One fold, three renderers

**Status:** Proposed; requires owner ratification of the four decisions in
section 17 before lane 2 starts. Lanes 1 and 6 may start on ratification of
decision 1 alone.

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
events, live text chunks, and owner liveness (5.2). Every process that shows
a session runs it. No process holds a mirror of another process's fold
output.

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
  // each carries streamId and requestId
  approvals: ApprovalRequest[],
  policy: Map<StreamTabId, ApprovalPolicySnapshot>,  // latest-of-type per run
  inquiries: InquiryThread[],
  // owner ids whose process is alive; a fold input, never persisted
  liveOwners: OwnerId[],
  queuedFollowUps: Map<StreamTabId, string[]>,
}

StreamView = discriminatedUnion('category', [ToolUseStreamView, WorkflowStreamView])
  // common
  id: StreamTabId
  // the run currently on this stream; a resume mints a new one, latest wins
  executionId: ExecutionId
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
  settledSeq: number,                        // last durable seq folded
  // workflow arm; retained-phase filter folded in
  run: WorkflowRunModel | null,
}
```

Types that die when this lands: `StreamTabInfo`, `StreamMetadata`, both
`StreamState` variants, `StreamExecutionState`, `SessionStreamMetadata`,
`ActiveChildInfo`. They were four slices of one record.

`SessionState` (the class in `src/controllers/session/SessionState.ts`)
stays a class because it owns stores and lifecycle; it gains `view:
SessionView` and loses its metadata cache and its own topology.

### 5.2 Fold rules

The fold's input is `FoldInput = SessionEvent | TextChunk | OwnerLiveness`.
Every fact below derives from the durable events of section 6 except owner
liveness, which is process state and not an event: the runtime's lease
reader (`executionLease.ts`, a pid probe on the lease owner) emits an
`OwnerLiveness` snapshot, the set of owner ids whose process is alive, on
every change and on every subscribe, and the fold keeps the latest snapshot
in `liveOwners`. The snapshot is transient like a text chunk: never durable,
never a seq. A replay with no snapshot folds with `liveOwners` empty, so
every pending approval reads as interrupted until the runtime says
otherwise, which is the safe direction. Agreed with the substrate owner on
2026-09-03 (the companion proposal, in flight).

- **Existence.** A stream exists iff its `run.start` event exists; it is
  seq 1 for the stream. `seq` is per stream, the `(stream_id, seq)` key of
  the event table; insert order across streams under the publish permit
  (7.1) is the session order a replay uses. Every stream kind gets one:
  agent, process (`bash@tool`), workflow script, through `RunIdentity.kind`.
- **Category, remote-ness, and owner** are launch facts on the `run.start`
  payload (section 6, item 6). `RunIdentity` deliberately does not encode
  `AgentCategory` (its header comment in `runIdentity.ts` says so), and
  remoteness is a registry lookup (`isRemoteAgent` at
  `streamTabInfo.ts:57-63`) that a browser fold cannot make, so the fold
  reads both from the payload and derives neither. `ownerId` is the lease
  owner token of the process that appended the event (the
  `event_sequence.owner_id` fence of the persistence proposal); it rides on
  every durable event and `StreamView.ownerId` is the latest one, so a
  resume in another process moves ownership without a new fact kind.
- **`group === 'waiting'`** iff an `approval.requested` exists without its
  `approval.resolved` AND `stream.ownerId` is in `liveOwners`. Without a
  live owner the same pair folds to `group === 'interrupted'`, never
  `'waiting'`, because nothing is listening for the answer; `'interrupted'`
  is the fourth arm of the union (5.1) and the group a host offers `resume`
  on. A stream with no unresolved approval keeps its status-derived group
  whether or not its owner is alive, so only an abandoned decision reads as
  interrupted.
- **`goal`** is per stream, on the toolUse arm. Today's
  `GoalStore.getForStream` and the `goalStateChanged` fact are keyed by
  stream id, and concurrent streams hold independent goals; one session
  field would let one stream's goal event overwrite another's.
- **`approval`** is `'own'` when the stream itself is waiting, `'descendant'`
  when any descendant is; hosts expand the path by default for
  `'descendant'` and add only their own override on top.
- **`rollup`** counts descendants by status; it has no waiting count because
  a waiting descendant expands the path, so a collapsed parent never hides
  one.
- **`ancestors`** walks `parentId`; an evicted parent contributes its last
  known label.
- **`order`** and `childIds` use `streamOrdering` (newest creation first,
  ties by name).
- **`executionId`** is the latest `run.start` for the stream. A stream
  outlives its executions - a resume mints a new `ExecutionId` on the same
  `StreamTabId` (`RunScope.ts:18`) - so it is a fold field, not identity
  (`RunIdentity` deliberately carries no execution id). Carrying it is what
  lets the execution-scoped requests of 8.2 (`skip`, `retry`, `kill`) name
  the execution the surface actually saw: a request against a superseded
  execution then fails as `Unavailable` instead of landing on its successor,
  which a `streamId`-only request could not distinguish.
- **`context`** is latest-of-type over `context.state`, already a canonical
  run fact. Both renderers show it live today - `UsagePanel` through
  `ToolUseStreamContent` and `WorkflowStreamContent`, and the TUI status
  bar's occupancy gauge - and it is cumulative-per-run, not derivable from
  `usage`.
- **`policy`** is latest-of-type over the approval-policy snapshot events.
- **`settledSeq`** is the last durable seq folded; text deltas do not
  advance it.
- **Incremental.** An event recomputes the arm for `event.streamId`, then
  walks `parentId` to the root updating each ancestor's `childIds`,
  `rollup`, `approval`, and `group`, then `order` when a top-level stream
  appeared or changed status: O(depth) work per event, never a whole-view
  pass. `transcript.run` is memoized on `(streamId, settledSeq)`.
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
  The rule is one line: splice at `from` iff `from <= length`, so a
  re-delivered chunk is idempotent, a chunk with `from > length` is a torn
  row (resubscribe, 7.4), and a chunk with `from: 0` covering the row
  replaces it. Replacement needs no second arm and resync needs no second
  message kind: a resync _is_ a `from: 0` chunk. `settledSeq` never moves.
  `OwnerLiveness` is the other transient arm.

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

The only contract between this PRD and the persistence cutover is the
durable event set. Emission for everything is `SessionHandle.events` and
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
   `approvalPolicyAuthorityRatchet.vitest.ts`). Never a toggle delta. Deletes
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
   `suppressViewSwitch` travels with the surface, never as an event. The
   frozen NDJSON wire keeps its `setActiveStream` line - the CLI projection
   emits it from `run.start`, which is what the line meant to an external
   reader (10.3). Deleting the internal fact does not touch the contract.
6. **`agentCategory`** (agent runs), **`isRemote`**, and **`ownerId`** are
   fields on the `run.start` payload; `ownerId` is on every durable event.
   The launcher has the category from the run config and remoteness from
   the registry at the reservation commit, and the fold consults neither.
   Today `StreamIdentityFields` (`stream.ts:227-228`) carries the first two
   beside the identity, sourced from the config, and the tab derivation
   recomputes remoteness (`streamTabInfo.ts:57-63`).

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
    readonly publish: (event: SessionEvent) => Effect.Effect<void>;
    readonly events: (
      streamId: StreamTabId,
      fromSeq: number,
    ) => Stream.Stream<SessionEvent>;
    // every stream: replay from the per-stream cursor, then the tail
    readonly all: (cursor: SessionCursor) => Stream.Stream<SessionEvent>;
  }
>()('@texra/session/SessionEvents') {
  // runtime processes: the durable table is the source of truth
  static readonly durableLayer = Layer.effect(
    SessionEvents,
    Effect.gen(function* () {
      const hub = yield* PubSub.unbounded<SessionEvent>();
      const gate = yield* Semaphore.make(1);
      // provided by the persistence cutover
      const durable = yield* DurableWrite;
      const publish = Effect.fn('SessionEvents.publish')(function* (event) {
        // uninterruptible: an append that fans out to nobody is a gap every
        // live subscriber carries until it resubscribes
        yield* gate.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              // assigns seq, INSERT under BEGIN IMMEDIATE
              if (isDurable(event)) {
                event = yield* durable.append(event);
              }
              yield* PubSub.publish(hub, event);
            }),
          ),
        );
      });
      // this process's own publishes, merged with every commit made by any
      // other process holding this session open (the cross-process feed)
      const tail = (cursor) =>
        Stream.merge(Stream.fromPubSub(hub), durable.changes(cursor));
      // open the live tail FIRST, then read the replay, then concat and
      // dedupe on (streamId, seq)
      const subscribeThenReplay = (cursor, replay) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // subscribed now
            const live = yield* Stream.toQueue(tail(cursor), { capacity });
            return Stream.concat(replay, Stream.fromQueue(live)).pipe(
              dedupeBySeq,
            );
          }),
        );
      const events = (streamId, fromSeq) =>
        subscribeThenReplay(
          cursorFor(streamId, fromSeq),
          durable.read(streamId, fromSeq),
        ).pipe(Stream.filter((e) => e.streamId === streamId));
      // insert order; rows at or below cursor[streamId] are skipped
      const all = (cursor) =>
        subscribeThenReplay(cursor, durable.readAll(cursor));
      return { publish, events, all };
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
        events: (streamId, fromSeq) =>
          frames
            .events(cursorFor(streamId, fromSeq))
            .pipe(Stream.filter((e) => e.streamId === streamId)),
        all: (cursor) => frames.events(cursor),
      };
    }),
  );
}
```

Invariants: the durable write is in the publish path, under the same
permit as seq assignment and fan-out, so seq order and insert order cannot
diverge and no subscriber persists anything. The hub is unbounded because
bounded parks the publisher behind the slowest subscriber (which would
stall the durable write path) and sliding or dropping lose durable events.
The invariant that makes unbounded safe: no subscriber fiber ever awaits a
remote; backpressure lives at each transport framer (7.4). The live
subscription opens before the replay read or `concat` has a gap. The rc.112
names are `Stream.toQueue(stream, { capacity })` (already scoped) and
`Stream.unwrap`; the v3 `toQueueScoped` and `unwrapScoped` are gone. Both
are verified against `node_modules/effect/dist/Stream.d.ts`.

The hub is process-local, so it is a latency optimization and never the
whole tail: when a second TeXRA process has the same session open (a CLI
run beside the extension, a resume that moved ownership), its commits reach
this process only through the store. `durable.changes(cursor)` is that
cross-process feed - a notify or a polled table tail, the persistence
owner's choice - and the tail is the merge of the two, deduped on
`(streamId, seq)`, so a subscriber that publishes nothing itself still
converges. Waiting for a seq gap would not do: a gap is only visible once a
_later_ row for the same stream arrives locally, which for a stream owned
by another process never happens. This is decision 6, not yet agreed with
the persistence owner.

The permit section is `Effect.uninterruptible`, so neither an interrupt nor
a failure can land between the append and the fan-out: the append either
fails before anything is visible or its event reaches the hub, and
`PubSub.publish` on an unbounded hub does not suspend. A subscriber that
observes a seq gap treats it as overflow and resubscribes (7.4) - a repair,
not the cross-process mechanism, which is the paragraph above. `SessionCursor` is the per-stream `settledSeq` map the view already
holds, so `all(cursorOf(view))` is the resubscribe call; a stream absent
from the cursor replays from its `run.start`. `events(streamId, fromSeq)`
stays for single-stream readers (the trace viewer, the NDJSON subscription).

Two layers implement this one shape. `durableLayer` runs in the extension
host, the desktop main process, and the CLI, and is the only one that
resolves `DurableWrite`. `transportLayer` runs in a webview, where there is
no database and no publisher: it decodes the `EventsFrame`s of 8.1 through
`SessionFrames`, the one service a webview's process layer provides, whose
three fields are exactly the three fold arms - `events`, `chunks`, and
`owners` (7.2). A webview that reaches for `publish` is a defect, not a
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
      // lease reader in the runtime; the frames' owners field in a webview
      const liveness = yield* OwnerLivenessSource;
      // the delta path in the runtime; the frames' chunks field in a webview
      const chunks = yield* TextChunkSource;
      const ref = yield* SubscriptionRef.make(emptySessionView);
      yield* Effect.forkScoped(
        Stream.mergeAll(
          [events.all(emptyCursor), liveness.changes, chunks.changes],
          { concurrency: 3 },
        ).pipe(
          Stream.scan(emptySessionView, fold),
          Stream.runForEach((v) => SubscriptionRef.set(ref, v)),
        ),
      );
      return { ref, changes: SubscriptionRef.changes(ref) };
    }),
  );
}
```

`Layer.effect` strips `Scope` from the requirements, so the forked fold
fiber is owned by the layer's scope and ends on `runtime.dispose()`.
`Layer.scoped` does not exist in v4 (the migration PRD's section 8.3 example
needs the same correction). `SubscriptionRef` does not coalesce; the bridge
does (7.5). Synchronous reads use `SubscriptionRef.getUnsafe`, never
`runSync`. The three merged streams are exactly the three arms of
`FoldInput` (5.2), and each transient one has a source service with a
process-specific layer, so the fold fiber is the same code everywhere.
`OwnerLivenessSource` is the lease reader's `SubscriptionRef` in the
runtime and the `owners` field of each frame (8.1) in a webview.
`TextChunkSource` is the model handler's existing delta path in the runtime
(the stream `StreamingTextAccumulator` consumes today) and the `chunks`
field of each frame in a webview. Without that third arm the in-process
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
      Layer.mergeAll(OwnerLivenessSource.layer, TextChunkSource.layer),
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

Down, per subscriber: `all(cursor)` then `Stream.groupedWithin(n, "16
millis")` then `Stream.buffer({ capacity, strategy: 'suspend' })` for
durable events, which must not drop; suspension parks the framer, never the
publisher, because the hub is unbounded. Text chunks are append deltas, not
snapshots, so they are never buffered with the sliding strategy: a slid
chunk is lost text that no replay recovers, because deltas are not durable.
Text rides a dropping buffer per stream, and the repair is the chunk's own
`from`/`to` offsets (5.2): the subscriber applies a chunk iff `from` equals
the row's current length, so a drop is detected on the _next_ chunk, by the
one party that knows the row's length, with no chunk index to maintain and
no dedupe pass. A torn row resubscribes through `all(cursorOf(view))`, and
the reply is an ordinary chunk with `from: 0` carrying that row's complete
in-flight text, which replaces it by the same splice rule. There is no
resync message kind and no replacement arm: the offsets are what make an
append and a replacement the same operation. A seq gap in durable events is
handled the same way (7.1). Frame volume equals
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
type RequestError = NotOwner | Unavailable | Rejected | Invalid;

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
`tapCause` sees). A request naming a stream that the seq
proves must exist is a defect. Error payloads cross the bridge as plain
tagged objects under the Zod union. Effect Schema is used nowhere: it
measures 188 KB minified and 56 KB gzipped, and rc.112's `Schema.TaggedError`
is already renamed upstream, so the pinned name would break on the next
bump.

### 7.7 Runtime per process

One `ManagedRuntime.make(processLayer)` per process, module-owned at the
existing entry, disposed on the existing shutdown path. The runtime
processes take `SessionEvents.durableLayer` with the runtime's
`OwnerLivenessSource` and `TextChunkSource`; every webview entry takes
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
(`Effect`, `Layer`, `Stream`, `PubSub`, `SubscriptionRef`, `Schedule`,
`Scope`, `Semaphore`, `Queue`, `Data`) is 188 KB minified, 61 KB gzipped;
with Effect Schema it would be 376 KB and 117 KB. The current progress
bundle is 2.57 MB raw, 730 KB gzipped, as a development build. Accepted,
and the reason Schema stays out. Re-measure at the end of lane 4 against a
production build.

## 8. The protocol

Four messages: events and responses down, two requests up. The CLI calls
the same functions in process.

### 8.1 Down: `events`

```ts
EventsFrame = { session: SessionKey, events: SessionEvent[], chunks: TextChunk[], owners: OwnerLiveness | null }
Subscribe   = { session: SessionKey, cursor: SessionCursor }     // per surface and session, every stream
```

Three messages, not four: a resync is a `Subscribe` whose frames answer
with `from: 0` chunks for the streaming rows (5.2, 7.4), so the protocol
needs no `Resync` shape and the fold no replacement arm. Every event
carries its `streamId` and `seq`, and every chunk its stream and its
`from`/`to`, so a frame needs no per-stream range. `owners` is the
latest liveness snapshot, sent on every change and on every subscribe; a
surface that has never received one folds with `liveOwners` empty (5.2).

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

- stream: `stop`, `delete`, `deleteAll`, `compact`, `resume`, `runNew`,
  `restoreState`
- follow-up: `send { streamId, text, images }`, `retry`, `cancelRetry`,
  `polish`
- decisions: `toolEdit`, `bash`, `proposal`, `plan`, `userQuestion`,
  `externalInquiry { draft | submit | drop }`
- policy: `setPolicy { streamId, snapshot }` (replaces three toggles and two
  enable commands; one runtime transaction instead of the read, set, drop
  sequence at `ProgressViewCommandHandlers.ts:378-395`)
- workflow: `skip { executionId, callIndex }`, `retry`, `kill { detachActiveChildren }`
- misc: `runCompileFixer`, `exportTranscript`
- launch: `execute { validatedRequest }`, `polishInstruction`

Outcome is a typed value the host renders; the nine toasts hardcoded in the
shared handler (`ProgressViewCommandHandlers.ts:305-312, 383-395, 601-618`)
become outcomes. The follow-up admission latch already lives in the
controller (`progressFollowUpSubmit.ts:42-47`); returning it as the outcome
deletes `FOLLOW_UP_RESULT`.

### 8.3 Up: `host.request`

Same envelope: a `session` and a `requestId`, answered by 8.4.
Capabilities mapped onto `platform()` and `@hosts/*` ports: `openFile`,
`openSpillArtifact`, `openTaskStorage`, `compare`, `accept`, `merge`,
`latexdiff`, `openLabel`, `pack`, `clean`, `restoreIntoLauncher`,
`showDiff`, `previewProposed`, `showLatexdiff` (for a pending edit),
`record { start | stop }`, `popOut`, `popBack`, `pickFiles`, `openSettings`,
`openUrl`, and the launcher's file pickers. The own-API-key retry is a host
credential flow whose completion issues a `runtime.request`.

### 8.4 Down: `response`

```ts
Response = {
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

### 8.5 What does not cross the bridge

Interaction state: `SWITCH_STREAM`'s round trip and persistence, the
external-inquiry draft, `SETTLE_STREAM_SELECTION`, `SET_PLACEMENT`. The
transport handshake (`WEBVIEW_READY`) becomes the subscribe message.

## 9. The Surface

One per view instance (sidebar webview, editor-tab webview, Electron
renderer, TUI screen) and open session, owned by the renderer, in signals:

```
Surface = {
  // which paper this surface is showing; the LayerMap key (7.3)
  session: SessionKey
  selected: StreamTabId | null
  drafts: Map<StreamTabId, Draft>
  // the new-task composer: the existing MainViewPersistedState, per session
  launch: LaunchSurface
  recording: boolean
  // override on top of approval === 'descendant'
  expanded: Map<StreamTabId, 'expanded' | 'collapsed'>
  focusedRow: RowId | null
  scroll: Map<StreamTabId, number>
  drawerOpen: boolean
  workbench: WorkbenchLayout                               // desktop only
}
```

`Draft` is `{ text, images: PastedImage[], polished: string | null,
transcribed: string | null }`. A desktop renderer holds one `Surface` per
open paper, so a paper with no streams at all is still a distinct surface
with its own `session` and its own composer, rather than one of many
indistinguishable `selected: null`s.

`LaunchSurface` is not a new type: it is `MainViewPersistedState`
(`store.ts:26`, `MainViewPersistedStateSchema`) moved under `Surface` and
keyed per session. It already owns every launcher selection the composer
needs to build a `validatedRequest` - `sessionType`, `launchTarget`,
`selectedTeamId`, `workingDirectory`, `agent` and `model`, `commit`, the
single, multi, and context file selections, the checkbox values, and the
per-category instruction drafts, which are the new-task draft. The roughly
twenty module-level signals in `mainViewState.ts:76-122` become reads of
that one record, which is what makes them survive a paper switch and a
remount instead of resetting through the tracked-signal registry. Two
things that look adjacent are deliberately _not_ Surface: the option
catalogs (`modelOptions$`, `agentOptions$`, `teamOptions$`,
`workspaceRootOptions$`) are host-provided data, not the user's choices,
and the banners are request outcomes and host state. The test is whether a
second surface on the same session may hold a different value: a selection
may, a catalog may not. Two surfaces on one session may select
different streams. Launch returns
the stream id (`onBeforeActivation` already hands it out,
`AgentLaunchContext.ts:93`) and the launching surface selects it. "Reply to
parent instead" moves the draft to the parent. Persisted per view through
the existing `PersistedState` owner for that view, interaction state only.
The signal record holds Maps; the persisted form is a Zod schema beside it
in which each Map is an entry array (`[StreamTabId, V][]`), parsed and
rebuilt into Maps at load, because webview state crosses `JSON.stringify`
and a Map serializes to `{}`. Persisted per view and session: `selected`, `launch` (as
today), `drafts` (text only; images and the polished and transcribed
variants are not), `expanded`, `scroll`, `drawerOpen`, `workbench`. Not persisted:
`session` (it is the key), `recording`, `focusedRow`.

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
  `renderer/messageRoutes.ts` (201) and `desktopIpcTypes.createCommandHandler`
  in favor of one dispatcher over one schema family, `desktopProgressIpc`'s
  outer parse (`:97`).
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
produced a line. It stays a per-event projection and reads
`SessionEvents.all()` directly. That is the division: the fold is what
_renders_, the event stream is what _serializes_, and the projection is the
one place internal vocabulary is translated to the frozen wire - including
the `setActiveStream` line, which survives the deletion of the fact
(section 6, item 5) because the projection emits it from `run.start`. `workflowPlainOutput.ts` (204 lines, its own event
fold, terminal gate, status table, and model-label swap) renders
`transcript.run` to text. `packages/agent` exports `SessionViewService` and
the request union so external consumers stop re-folding raw events
(`src/index.ts:78-150`). The trace viewer already reads the shared renderer
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
from there and call those functions. One root read per operation, from
context, and no process-global workspace left for a second paper to
disagree with. Every caller stays unchanged because every caller is
run-scoped or host-scoped. In Effect
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
  "Context and attachments" disclosure hosting the real `file-select-group`
  (still inside `<main-app>` so it keeps `fileStateContext`), an "Active
  now" strip that is `stream-tabs` filtered to `group !== 'recent'`, and
  the launch composer. Onboarding cards replace the hero while the funnel is
  pending; the five banners sit above the composer.
- **Composer**: one component in two states. Expanded: the textarea, chips
  for agent (with teams as a section and "Manage teams…"), model, mode
  (Interactive, Workflow), and working directory only with two or more
  roots; each chip's menu carries its "…settings" item; polish, dictation,
  attach, send. Compact: the follow-up line with the same trailing controls.
  Above it, "Goes to X · reply to parent instead" from `Surface.selected`,
  `parentId`, and `followUpSupport`. Chips collapse into one popover below
  440 px (the existing container query).
- **Drawer** (sidebar) or **docked list** (editor tab, at or above 720 px):
  the real `stream-tabs` with top-level rows grouped by `group` (Running,
  Waiting on you, Recent), a rollup pill from `rollup` on collapsed parents,
  the path expanded for `approval === 'descendant'` plus the Surface's
  override, a header with search, new, and close, and a footer with Open
  sessions in editor. Width `min(320px, 100% - 40px)`.
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
  (initials mark, name, one-line subtitle, running count badge) and its own
  `stream-tabs` nested beneath, then "Add paper…", then the existing footer
  (Terminal, Browser, Logs, Settings). Each paper is one `SessionView` from
  the `LayerMap`.
- **Conversation** (760 px column): the paper chip and stream title in the
  task header, the same conversation and composer as the extension, and a
  dock with the diff count, Compile PDF, and latexdiff-vs-last-commit
  shortcuts into the Tools sheet.
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
transcript is `rows` with `settledSeq` as the static boundary; Alt+1..9 is
Surface state.

### 12.4 Surface mapping

Every surface the current New view, Sessions view, editor tab, and host
commands render, and its home. "Same" means the component is unchanged.

| Today                                                                                                                                                            | Home                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| New / Sessions tabs                                                                                                                                              | Removed; New is the "+" action and the empty state; Sessions is the drawer or the docked list       |
| Open dashboard, Open sessions in editor, Back to sidebar                                                                                                         | Gear in the header; the others in the overflow and the drawer footer                                |
| Loading skeleton, onboarding cards                                                                                                                               | Empty-state body while the funnel is pending; same components                                       |
| API key, agent config, dependency, getting-started, login banners                                                                                                | Above the composer in the empty state; a thin strip above the follow-up in a session; same          |
| Interactive / Workflow, Agent / Team radios                                                                                                                      | Composer chips with menus                                                                           |
| Session hint callout                                                                                                                                             | Under the composer; same                                                                            |
| Polish, dictation, image paste, file drop                                                                                                                        | Composer, both states; same controllers                                                             |
| Working directory select                                                                                                                                         | Composer chip, only with two or more roots                                                          |
| Agent, team, model selects and their settings gears                                                                                                              | Chips; gear becomes a "…settings" menu item                                                         |
| Run agent (Cmd+Alt+E)                                                                                                                                            | Send; accelerator stays                                                                             |
| Debug Pack output, Delete output files                                                                                                                           | Overflow, debug section                                                                             |
| Input, Context, Media groups and their menus                                                                                                                     | "Context and attachments" disclosure; wand and wrench items also in Tools; same `file-select-group` |
| LaTeXDiffs section                                                                                                                                               | Tools sheet, any state, real component                                                              |
| Empty states, getting-started buttons                                                                                                                            | The one empty state                                                                                 |
| Rail rows, tree, expand, delete                                                                                                                                  | Drawer or docked list; same `stream-tabs` plus groups and rollups                                   |
| Stream header and its toolbar (stop, fresh run, resume, setup in main view, task storage, export, copy context, latexdiff, clean, pack; bypass toggles; compact) | Same; "Setup in main view" becomes "Edit as new task"; toggles become `setPolicy`                   |
| Tasks, Plan, Background tasks, Command panels                                                                                                                    | Same; Background tasks becomes the dispatch card                                                    |
| Transcript rows, inline copy, compaction, terminal output, chime                                                                                                 | Same                                                                                                |
| Request panels, approve split button                                                                                                                             | Same; the run board's rows link here                                                                |
| Latexdiff results, generated files with per-file verbs                                                                                                           | Same                                                                                                |
| Follow-up composer, queued messages                                                                                                                              | Same, plus the "goes to" line                                                                       |
| Usage footer                                                                                                                                                     | Same                                                                                                |
| view/title menus                                                                                                                                                 | Keyed on the re-derived context key; New Session is the "+" command                                 |
| Show Launcher, Show Progress, Toggle, Open in editor tab                                                                                                         | New task; focus conversation; toggle drawer; unchanged                                              |
| Status bar item                                                                                                                                                  | Unchanged                                                                                           |
| Desktop-only hero, disclosure, composer dock, Run mode select, always-open follow-up                                                                             | The shared empty state and composer on both hosts                                                   |

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

| Lane                    | Content                                                                                                                                                                                                                                                                        | Depends on                                                                                                                      | Parallel with | Touches                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------- |
| 1 Foundation            | `sessionView.ts`, `sessionFold.ts` (pure, incremental), `runtimeRequest.ts`, `requestErrors.ts`, the pure-fold test; the six event changes of section 6; owner liveness as a fold input; compensation and tombstone gates re-keyed                                             | nothing; in-memory; stays out of `src/transcript` stores, `src/agent/storage`, `persistedFlow` while the cutover branch is open | 6, 7          | `src/shared/session`, `src/agent/trace/events.ts`, `AgentLaunchContext.ts`, `SessionFactApplier.ts` |
| 2 Effect services       | `SessionEvents` with `all(cursor)` and the uninterruptible publish, `SessionViewService`, `WorkspaceRoots`, `sessionLayer` through `LayerMap`, `toSignal`, `SessionRequests`, the process runtime at each entry, `loopbackLogin` migrated, `it.effect` suites with `TestClock` | 1                                                                                                                               | 6, 7          | `src/controllers/session`, `SessionEventHub.ts`, `src/shared/signals.ts`, host entries              |
| 3 TUI                   | section 10.1, one pull request                                                                                                                                                                                                                                                 | 2                                                                                                                               | 4, 5          | `packages/cli`                                                                                      |
| 4 Extension and desktop | section 10.2, one pull request; measure the bundle                                                                                                                                                                                                                             | 2                                                                                                                               | 3, 5          | `packages/extension`, `packages/desktop`, `src/controllers/progressView`                            |
| 5 Headless and SDK      | section 10.3                                                                                                                                                                                                                                                                   | 2                                                                                                                               | 3, 4          | `packages/cli/src/runtime`, `packages/agent`                                                        |
| 6 Session roots         | section 11                                                                                                                                                                                                                                                                     | none; coordinate with the cutover                                                                                               | 1, 2          | `SessionHandle.ts`, `storageFS.ts`, `workspaceFS.ts`, `packages/desktop/src/main`                   |
| 7 Ledger collapses      | section 13, disjoint ones as filler                                                                                                                                                                                                                                            | none                                                                                                                            | 1, 2, 6       | files lanes 3 and 4 do not touch                                                                    |
| 8 Shell                 | section 12                                                                                                                                                                                                                                                                     | 4, 6                                                                                                                            |               | `packages/extension` frontends, `packages/desktop/src/renderer`                                     |

### Acceptance per lane

- **1:** the fold is pure (no `effect`, no `platform()`, no Node built-ins;
  importable from the browser bundle); `fold` over a recorded event log of a
  fan-out session reproduces today's `stream-tabs` rows, `background-tasks`
  rows, and `workflowRunModel` output; the presentation-boundary test
  rejects draft and recording names in `sessionView.ts`; every stream kind
  has a `run.start`; a launch that fails after reservation folds to failed;
  the same log with an empty `liveOwners` folds every pending approval to
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
  root; relaunch code gone.
- **8:** every element on the canvas boards reads a named field; the surface
  mapping has no row without a home.

## 15. Enforcement

By construction:

- `HostInteractions` already has one implementation (`HostInteractions.ts:403`);
  hosts attach through `interactions.use()`. Lanes 3 and 4 delete the
  decision mappers that were the dual. No pin needed.
- `SessionRendererPort` is deleted by lane 2. No pin needed.
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
  any shared schema.
- Transitionally, one renderer-port implementation per host until lane 2
  lands.
- An architecture test that fails when a host package computes topology,
  grouping, rollups, ordering, settlement, or a run model from entries or
  facts rather than reading `SessionView` (hardcoded allowlist, like the
  existing kernel tests).

## 16. Risks

| Risk                                                                                       | Mitigation                                                                                                                                                   |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Effect 4 is a release candidate; names move (`Schema.TaggedError` already renamed on main) | Pin the version the substrate pinned; use `Data.TaggedError`; Appendix A is the verified vocabulary; the guides are older than the package, the package wins |
| Quadratic fold on fan-out sessions                                                         | Incremental per stream arm, run memoized on `settledSeq`; measured against a recorded 31-call run at lane 1                                                  |
| Webview bundle growth                                                                      | 61 KB gzipped measured; Schema excluded; re-measure against a production build at lane 4                                                                     |
| Reconnect loses in-flight text                                                             | Chunks carry `from`/`to`, so a drop is caught on the next chunk and the repair is a `from: 0` chunk with the row's full text; text buffers drop, never slide |
| A webview folds another paper's events                                                     | `SessionFrames` is per session; the port is demultiplexed once at decode, so the key is not a runtime value below it (7.1)                                   |
| Owner liveness stale in a webview                                                          | Snapshot on every change and every subscribe; an empty snapshot folds to interrupted, the safe direction                                                     |
| Replay-then-tail gap                                                                       | Subscribe the live tail before the replay read; dedupe on seq                                                                                                |
| Another process commits an event this one never sees (the hub is process-local)            | The tail is the local hub merged with the store's `changes(cursor)` feed, deduped on `(streamId, seq)`; a seq gap alone cannot detect it (7.1, decision 6)   |
| Async-local session lookup inside Effect fibers                                            | Forbidden in Effect code; roots from context; lint the import in `src/controllers/session`                                                                   |
| Two programs editing `SessionHandle`                                                       | Lane 6 before the cutover branch if ready; otherwise one-line swap after                                                                                     |
| Convergence adds lines                                                                     | Measured per lane; framed as one-state and deletion wins, not line counts                                                                                    |
| `TranscriptIndex` deletion regresses render                                                | Measure plain rebuild first; keep if it does not hold                                                                                                        |
| Three-column desktop needs width                                                           | Below about 1100 px the workbench collapses as it does today                                                                                                 |

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
6. **With the persistence owner, not yet agreed:** the durable store
   exposes `changes(cursor)`, a cross-process feed of committed events,
   beside `read` and `readAll` (7.1). Without it a process that only reads
   goes stale whenever another process owns the run.
7. `WorkspaceProvider` leaves `platform()` rather than being re-pointed at
   a session (section 11). It has one implementation and its body is two
   pure functions of the root, so the port is the process-global, not a
   wrapper around one.
8. The frozen NDJSON wire is a projection of the event stream, not a reader
   of `SessionView` (10.3). The fold renders; the event stream serializes.

Already agreed with the persistence owner and recorded in the companion
proposal (in flight in another branch, see Lineage): the six event changes
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
`toQueueScoped` and `unwrapScoped` are gone); the Cause-tapping combinator
is `tapCause`, not `tapErrorCause`; and rc.112 exports no `catch` or
`catchAll` (the family is `catchTag`, `catchTags`, `catchCause`,
`catchDefect`, `catchReason(s)`, `catchIf`, `catchFilter`,
`catchNoSuchElement`, `catchCauseIf`, `catchCauseFilter`, `catchEager`).
`Stream.mergeAll(streams, { concurrency })` and `Effect.die` are present.

Not verified, to confirm at lane start: the shape the persistence cutover
gives `changes(cursor)` (a notify or a polled tail; decision 6); whether
`TranscriptIndex` can be deleted without a render regression; net lines
after each lane; the render cost of the memoized run model at fan-out
scale.

---

## Appendix A. Verified Effect 4 rc.112 vocabulary

| Concept             | rc.112 API                                                                                       | Import           | Note                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------- |
| Service key         | `class X extends Context.Service<X, Shape>()('@texra/…')`                                        | `effect`         | `Context.Tag`, `ServiceMap`, `Effect.Service` do not exist in rc.112                               |
| Layer from effect   | `Layer.effect(X, effect)`                                                                        | `effect`         | strips `Scope`; `Layer.scoped` does not exist in v4                                                |
| Layer helpers       | `Layer.succeed`, `Layer.sync`, `Layer.mergeAll`, `Layer.provide`, `Layer.provideMerge`           | `effect`         | store parameterized layers in constants (memoized by reference)                                    |
| Keyed layers        | `LayerMap.make((key) => layer, { idleTimeToLive })`, `.invalidate`                               | `effect`         | RcMap-backed                                                                                       |
| Partial fakes       | `Layer.mock(X, partial)`                                                                         | `effect`         | real, @since 3.17; hand-written `testLayer` preferred                                              |
| Hub                 | `PubSub.unbounded<A>()`, `PubSub.publish(hub, a): Effect<boolean>`, `PubSub.subscribe`           | `effect`         | bounded parks publishers; sliding/dropping lose events                                             |
| Subscribe as stream | `Stream.fromPubSub(hub)`                                                                         | `effect`         | subscribes when run; open before replay                                                            |
| Fold                | `Stream.scan(initial, f)`                                                                        | `effect`         | emits initial first, then one state per element                                                    |
| Merge inputs        | `Stream.merge(a, b)`, `Stream.mergeAll(streams, { concurrency })`                                | `effect`         | events, liveness, and text chunks into one fold; `concurrency` is required                         |
| Tail into a queue   | `Stream.toQueue(stream, { capacity })`, `Stream.unwrap(effect)`, `Stream.fromQueue`              | `effect`         | already scoped; the v3 `toQueueScoped` / `unwrapScoped` do not exist                               |
| Atomic section      | `Effect.uninterruptible(effect)`                                                                 | `effect`         | around append plus fan-out under the permit                                                        |
| Ref                 | `SubscriptionRef.make(a)`, `SubscriptionRef.changes(ref)`, `.set`, `.update`, `.getUnsafe`       | `effect`         | no coalescing; no `Stream.fromSubscriptionRef`                                                     |
| Framing             | `Stream.groupedWithin(n, "16 millis")`, `Stream.buffer({ capacity, strategy })`, `Stream.concat` | `effect`         | `Duration.Input` accepts `"16 millis"`                                                             |
| Sink                | `Stream.runForEachArray(stream, f)`, `Stream.runForEach`                                         | `effect`         | coalesce by taking the last element                                                                |
| Fork under scope    | `Effect.forkScoped(effect)`                                                                      | `effect`         | inside `Layer.effect`                                                                              |
| Resource            | `Effect.acquireRelease(acquire, release)`, `Effect.scoped`, `Scope`                              | `effect`         | interaction scope                                                                                  |
| Serialize           | `Semaphore.make(permits)`, `.withPermit`, `.withPermits(n)`                                      | `effect`         | own module; `Effect.makeSemaphore` does not exist                                                  |
| Queue               | `Queue.bounded/sliding/dropping/unbounded<A, E>`, `offer`, `take`, `takeAll`                     | `effect`         | v4 queues carry an error channel                                                                   |
| Errors              | `class E extends Data.TaggedError('E')<{…}> {}`                                                  | `effect`         | yieldable; `catchTag`, `catchTags`, `orDie`, `tapCause`; no `tapErrorCause`, no `catch`/`catchAll` |
| Defect              | `Effect.die(defect)`                                                                             | `effect`         | no `Effect.dieMessage`; the transport layer's `publish` (7.1)                                      |
| Tracing             | `Effect.fn('X.method')(function* (…) {…})`                                                       | `effect`         | every named service method                                                                         |
| Runtime             | `ManagedRuntime.make(layer)`, `.runPromise(effect, { signal })`, `.runFork`, `.dispose()`        | `effect`         | one per process                                                                                    |
| Test clock          | `TestClock.adjust`, `TestClock.layer()`, `TestClock.withLive`                                    | `effect/testing` | also `TestConsole`, `FastCheck`                                                                    |
| Test runner         | `it.effect`, `it.layer`                                                                          | `@effect/vitest` | not installed; decision 2                                                                          |

## Appendix B. File layout

No barrels; import the defining module through the existing aliases.

```
src/shared/session/sessionView.ts        Zod SessionView, StreamView, TranscriptView; z.infer types
src/shared/session/sessionFold.ts        fold(view, input): pure; no effect import; no platform()
src/shared/session/runtimeRequest.ts     Zod RuntimeRequest, HostRequest, Outcome
src/shared/session/requestErrors.ts      Data.TaggedError NotOwner | Unavailable | Rejected | Invalid
src/shared/signals.ts                    + toSignal(runtime, changes, initial)
src/shared/copy/streamStatus.ts          one status label table with tone; one terminal-state vocabulary
src/controllers/session/SessionEvents.ts     Context.Service; durableLayer (publish under one permit, all(cursor), events(streamId, fromSeq)) and transportLayer
src/controllers/session/sessionSources.ts    OwnerLivenessSource, TextChunkSource; a runtime and a webview layer each
src/shared/session/sessionFrames.ts          Zod EventsFrame, Subscribe, Response, TextChunk; SessionFrames service shape (per session)
src/controllers/session/SessionView.ts       Context.Service; ref + changes; fold fiber forkScoped
src/controllers/session/WorkspaceRoots.ts    Context.Service; Layer.succeed per session
src/controllers/session/SessionRequests.ts   request(): Effect<Outcome, RequestError>; ownership scope
src/controllers/session/sessionLayer.ts      per-session graph; LayerMap keyed by root
src/agent/runtime/SessionEventHub.ts         rewritten as the PubSub publisher (7.1)
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
