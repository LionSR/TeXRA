# Area B: session composition, requests and the SQLite store

Read-only audit of `packages/harness/src/controllers/session/*`,
`agent/runtime/{SessionEvents,RunHistory,SessionHandle,rootLaunch,HostInteractions}.ts`
and `effect/*`, against the 2026-11-03 note's O1–O10 (read at
`.agents/docs/proposed/architecture/2026-11-03-one-fact-one-representation.md`).
Paths are relative to `packages/harness/src` unless they start with
`packages/` or `src/`. Consumer counts are files in `packages/*/src`
(production) and `packages/*/test` + `src/test-kernel` (non-production).

What the note already lists and I do not re-report: the claim protocol
(`hold`/`owns`/`acquireClaims`/`releaseClaims`/`claimOwner`/`claimStanding`/
`heldElsewhereBy`/`DeletionMode`/`DatabaseClaimRefused`), the liveness prover
(`controllers/session/ownerLiveness.ts`, `ProcessIdentity.owners`), `LocalRuntimeState.self`/`dead`,
`RunView.ownerId`/`ownedHere`/`readOnly`, `holdProcessRoot`, `RunAttempt`/
`attemptOf`, `withInactiveRunStep`'s claim half, and `storeOpenElsewhere` as
the lock probe. Where a finding below touches those, it is the angle the note
does not name: what the structure is once they are gone.

## Answers to the five key questions, in one paragraph each

**(1) How many services make a session.** `SessionServices`
(`agent/runtime/rootLaunch.ts:50-63`) is a union of 13 Context tags: `Runs`,
`SessionLog`, `SessionViewAccess`, `Approvals`, `RunHistory`, `HistoryQuery`,
`Inbox`, `Interactions`, `SessionRequests`, `ProjectTools`, `SessionRoots`,
`WorkspaceFs`, `StorageFs`. Beneath them the per-root graph
(`controllers/session/sessionLayer.ts:118-145`) serves 10 more: `Database`,
`SessionEvents`, `SessionInputs`, `SessionViewService`, `LocalRuntimeSource`,
`TextChunkSource`, `TranscriptSubscriptions`, `WorkspaceRoots`, the
`ownerLiveness` discard layer, and the private bag `SessionStoreParts`
(`controllers/session/sessionOwners.ts:91-127`). 23 tags over one SQLite file. Split by layer, not
by hidden knowledge: the session's roots are four tags (`WorkspaceRoots`,
`SessionRoots`, `WorkspaceFs`, `StorageFs`, all built from one
`WorkspaceRoots` value: `controllers/session/sessionLayer.ts:143`, `controllers/session/sessionOwners.ts:145,148`;
`SessionView.key` is the same `storage` string a fifth time); the view is two
tags (`SessionViewService` `{ref, changes}` and `SessionViewAccess`, which
wraps it with `run/read/inputs/subscribe` delegations, `controllers/session/SessionView.ts:182-228`);
the fold's non-durable input is three tags, each a bare `{ref: SubscriptionRef}`
(`controllers/session/sessionSources.ts:30-48,81-93,95-142`). Split by time: `Approvals`,
`Interactions` and `SessionRequests` together own "a question to a person"
(finding 5). Split by abstraction and justified: `RunHistory` over `SessionLog`
(`agent/runtime/RunHistory.ts:310`, a pure function of the log and a deep module),
`HistoryQuery`, `Inbox`.

**(2) The publisher model, and the store's interface once one process writes.**
Today a write is: `SessionLog.transact` (`controllers/session/sessionStore.ts:307-317`) →
`transaction` (claim bookkeeping, `:203-256`) → `SessionEvents.transact`
(a `Deferred` per job on an unbounded `Queue` drained by one fiber,
`agent/runtime/SessionEvents.ts:187-255`) → `Database.job` (`committing` over `own('write')`
with busy retry and the per-write store gate, `controllers/session/Database.ts:436-456,974-990`) →
then `settleTo(committed)` waits for the view fold to apply the commit
(`controllers/session/sessionStore.ts:253-254,116-135`). The parts that exist only for several
writers of one file: the busy retry and the "job may run again whole" rule
(`controllers/session/Database.ts:433-435`, `controllers/session/storeAside.ts:70-84`), the per-write `storeGate`
(`controllers/session/Database.ts:446`, `controllers/session/rowCodec.ts:384-393`), `provingOwners`/`ProvenOwners`/
`OwnersUnproven` (`controllers/session/storeAside.ts:86-149`), the `data_version` poll for a
project store (`controllers/session/Database.ts:336-365`), `claimHolds` (`controllers/session/sessionStore.ts:147-197`),
`transaction`'s `owned`/`release` (`:214-225,252-254`), `prepareRunRemoval`'s
off-lock proofs (`controllers/session/Database.ts:897-932`), `prepareStore`'s re-check loops
(`controllers/session/storeSchema.ts:246-311`), `underCopy`'s `data_version` compare
(`controllers/session/storeAside.ts:179-214`). What is not multi-process but is reinvented
(finding 2, 3): three tails over one log, six commit coordinates, the
post-commit hook list, and the `order: true` job mode. The store's interface
once a process is its only writer: `append(rows): Effect<SessionEvent[]>`
in one `BEGIN IMMEDIATE` on one connection (SQLite serializes; a `Semaphore(1)`
or the connection's reservation is the queue), the typed reads, and one
`SubscriptionRef<CommitOrdinal>` moved by the connection's own commits.

**(3) How many times "which runs are live / interrupted / owned here" is
derived.** Thirteen representations, in nine files: `event_sequence.owner_id`
(`controllers/session/Database.ts:116-123`), `ProcessIdentity.ownerId`, `LocalRuntimeState.self`
and `dead` (`controllers/session/sessionSources.ts:40-44`), `view.runs[].ownerId`
(`shared/session/sessionViewUpdate.ts:185-189`), the fold fields `ownedHere`, `readOnly`,
`live`, `runsHere` (`:446-509`), `AggregateClaim.liveness === 'self'`
(`controllers/session/Database.ts:836-848`), `ClaimStanding.kind === 'self'` (`shared/session/database.ts:83-88`),
`SessionLog.owns` (`controllers/session/sessionStore.ts:344-351`), `SessionRequests`' `heldHere`
(`controllers/session/SessionRequests.ts:439-441`, 15 reads in the file), `RunRegistry.activations`
(`agent/runtime/runRegistry.ts:140`, read as `runs.get(id) !== undefined` at
`controllers/session/SessionRequests.ts:421`, `effect/sessionPrograms.ts:154`, `withInactiveRunStep`),
and the cold read's `NO_LOCAL_STATE` (`controllers/session/readSessionView.ts:42-46`).
The note's O1 deletes nine of these; finding 4 is about the two that survive
and the channel they travel on.

**(4) One owner of a question and its answer?** No. The `request.decided`
draft is spelled by five writers (`agent/runtime/requestPolicy.ts:191-196` policy answer
in the opening batch, `:312-314` a surface's checked decision,
`agent/runtime/RunHistory.ts:346-356` activation cancels, `agent/storage/runLifecycle.ts:193-206` end
cancels, `agent/runtime/ModelInvoker.ts:100-103` the invoker's own retry answer); the row is
waited for by three readers (`agent/runtime/requestPolicy.ts:368` inside `ask`,
`agent/runtime/ModelInvoker.ts:692-694`, `agent/runtime/delegation/AgentTool.ts:208`); the answer's
fitness is checked three times (`effect/requestAnswerer.ts:63`,
`controllers/session/SessionRequests.ts:276`, `agent/runtime/requestPolicy.ts:273-283` at read-back, which dies).
`SessionRequestsShape.decide`'s doc says "the one writer of a decision"
(`agent/runtime/SessionHandle.ts:114`): false. Finding 5.

**(5) Deletion.** Three entry points reach `deleteAdmittedRun`
(`request('run.delete')` `controllers/session/SessionRequests.ts:329-330`; `SessionRequests.removeRun`
`:449-466`; `LocalSession.deleteRuns` `effect/sessionReads.ts:150-176`, which
calls the second) plus the sweep (`controllers/session/sweepLeftoverRuns.ts:44-53`), each with
its own admission wording. The marker-then-collect design is sound (good
modules). The option, the pass-through interface and the error ladder are
finding 9.

---

## Finding 1. The session is assembled by time, with a services bag carrying state between the layers

**Red flags:** temporal decomposition; services bag (banned by AGENTS.md "No
services bag"); shallow modules; overexposure.

**Evidence.** `sessionOwnersLayer` (`controllers/session/sessionOwners.ts:297-320`) is seven
layers piped in build order: `SessionStoreParts` → `projectLayer` →
`inboxLayer` → `Interactions` → `approvalsLayer` → `requestsLayer` →
`runsLayer` → `consumersLayer`. The comments say the split is by WHEN:
"Disposed first, so no run is admitted over a session that is unwinding"
(`:185-187`), "closed last so the teardown publishes and settles while the
tails and the view live; the runs' fibers, interrupted after the owners above
are disposed and before the publisher drains" (`:84-90`). To make that order
work a private service `SessionStoreParts` holds `{store, view, consumers,
fibers, collectDeletions, cohort}` (`:91-101`) and is read by four of the
seven layers (`:134,154,177,192,218`). `cohort` is the run list read at open
(`:119`) and carried to the sweep in the last layer (`:255`); `consumers` is a
hand-made `Scope` (`:106-109`) so one layer can fork into another layer's
lifetime (`:226,253`).

The `requestsLayer` builds `SessionRequests` by spreading the raw `Database`
service into a `log` field and overriding one method
(`:159-163`: `log: { ...(yield* Database), removeRun: … tap(collectDeletions) }`),
and captures `Effect.context<RunServices>()` (`:166`) to re-provide later
(`controllers/session/SessionRequests.ts:442-446`). So the request handler reads the claim table
directly (`controllers/session/SessionRequests.ts:86-90`: `Pick<Database, 'aggregateState' |
'claimOwner'>`), below the `SessionLog` "doors" that `sessionStore.ts:56-58`
says are the one way in ("nothing else reaches its transactions").

Shallow public services: `SessionViewAccess` (`controllers/session/SessionView.ts:182-228`) is
`{ref, changes}` from `SessionViewService` plus four one-line delegations;
`SessionRoots`/`WorkspaceFs`/`StorageFs`/`WorkspaceRoots` are four tags over
one value (`controllers/session/sessionLayer.ts:143`, `controllers/session/sessionOwners.ts:145,148`;
`controllers/session/WorkspaceRoots.ts` is 28 lines, 17 of them comment explaining why it exists).
`SessionOwner.holds(root, runs)` (`agent/runtime/rootLaunch.ts:86-89`, one caller `:127`)
learns "is this session still open" by identity-comparing the `Runs` object
held in the map entry (`controllers/session/sessionLayer.ts:462-467`) — the scope that would be
closed is the Effect scope the session already runs in.

Comment share of the worst files in this cluster: `effect/sessions.ts` 54%
(an interface file; acceptable), `agent/runtime/SessionHandle.ts` 46%, `effect/processLayer.ts` 37%,
`agent/runtime/rootLaunch.ts` 27%, `agent/runtime/HostInteractions.ts` 25%, `controllers/session/sessionLayer.ts` 22%,
`controllers/session/sessionOwners.ts` 13% but `:84-90` and `:185-187` are hand-off protocol prose.

**The design decision behind it.** "Which owner releases before which" is
decided by the layer order and the bag, instead of by one scope whose
finalizers run in reverse acquisition order (which Effect's `Scope` already
guarantees). The build was split by the time each piece is needed, not by
what each hides.

**The better design.** One `Layer.scoped(SessionServices…, Effect.gen …)`
that acquires in order and lets the scope release in reverse:

```
store  = yield* openStore(roots)            // Database + append + reads
view   = yield* openView(store, roots)       // SessionViewService: one tag
inter  = yield* Interactions.make(opened)    // host presentation
runs   = yield* RunRegistry.make({ store, view, inter, fork })
yield* Effect.addFinalizer(() => runs.stopAll + awaitDrained within budget)
yield* forkScoped(consumers(store.tail))     // the one folded-row reader
return Context.make(SessionLog, store.log).add(…)
```

Delete: `SessionStoreParts` (1 file, 0 tests), the seven layer constants, the
`consumers` scope and `fibers` set (use the layer's own scope + `FiberSet`
made there), `cohort` (the sweep reads `view.read([])` itself), `SessionOwner
.holds` (1 caller: `rootRun` checks `Scope` liveness or simply fails on the
closed `Runs`, which `RunRegistry.start` already refuses when `disposed`),
and the `requestsLayer` spread (`SessionRequests` takes `SessionLog` and the
registry, never `Database`). Collapse the roots to one tag: keep `SessionRoots`
(29 importing files) with the two rooted filesystems as fields, delete
`WorkspaceRoots` (17 files; the webview's remote view takes `storage` as a
string parameter, which it already does: `controllers/session/SessionView.ts:147-171`),
`WorkspaceFs`, `StorageFs` as tags. Collapse `SessionViewService` into
`SessionViewAccess` (5 files name `SessionViewService`).

**What we give up.** The ability to swap one layer in a test
(`src/test-kernel/controllers/session/sessionEvents.vitest.ts` and
`src/test-kernel/controllers/session/sessionStore.vitest.ts` build `sessionEventsLayer` and `makeSessionStore`
alone; they would build the one session layer over an ephemeral store). Risk:
teardown order mistakes are exactly what the current prose documents; the
replacement must put the run stop before the store's finalizer in the same
scope, which a single `Effect.gen` makes visible in one screen.

**Change amplification.** "A session gains one more non-durable input the
fold reads" (say per-run tool progress): today `controllers/session/sessionSources.ts` (a new
tag), `controllers/session/sessionLayer.ts:136-141`, `controllers/session/sessionInputs.ts:132-139,184-186`,
`controllers/session/readSessionView.ts:101-109`, `controllers/session/SessionView.ts:164-166`,
`shared/schemas` (`SessionViewInput` arm), `shared/session/sessionViewUpdate.ts`, plus the
transport framer: 7–8 files. After: the one `FoldInputs` ref gains a field,
`controllers/session/sessionInputs.ts` and the fold: 3 files.

---

## Finding 2. Three tails over one log and six commit coordinates, so that "published" can mean "folded"

**Red flags:** reinvented Effect primitives; information leakage (every reader
knows the commit-coordinate protocol); change amplification; silent cost.

**Evidence.** The same committed rows are read back from SQLite three times
in one process:

1. `logTails` (`shared/session/sessionEvents.ts:353-399`): one `forwardReads`
   over `Database.readDisplay`, fanned out through a `PubSub`; subscribed by
   `SessionStore.deliver` (`controllers/session/sessionStore.ts:366-385`, sets the `delivered`
   ref) and by every host `log.tail` reader.
2. `SessionInputs.read` (`controllers/session/sessionInputs.ts:160-240`): its own
   `readInputBatch` on every `log.level` wake, applied by
   `SessionViewService`'s update fiber to `view.ref` (`controllers/session/SessionView.ts:68-101`).
3. `SessionStore.folded` (`controllers/session/sessionStore.ts:360-365`): a third `tailFrom`
   over `Database.readDisplay`, gated by `settle.cursor` = `min(view.cursor,
   delivered)` (`:104-108`), consumed by `consumersLayer`
   (`controllers/session/sessionOwners.ts:231-254`) for `onHeldResult`, `announceWrites` and
   `presentTerminalResult`.

The coordinates that stitch them: `Database.level` (wake counter), `Database
.observedCommit`, `Database.currentCommit` (a SQL read of `sqlite_sequence`),
`SessionStore.delivered`, `view.cursor`, `foldedRead`
(`controllers/session/sessionStore.ts:282-291`). A `transact` returns only after (1) and (2) have
each read its commit (`:253-254`); `settled` additionally enqueues an
ordering job, reads `currentCommit`, then waits for (3) (`:296-298`); the
run's `lost()` and every `Run.result` wait on `settled`
(`controllers/session/runTrace.ts:165-166`, `effect/runHandle.ts:53-55`). The `settlement`
helper dies with a hand-written message when either side ends first
(`:118-134`): a `Deferred` racing a stream head racing another stream head.

`announceWrites` and `presentTerminalResult` are the only reason the third
tail exists: they want "the view holds this row's state" before they act
(`controllers/session/sessionOwners.ts:227-229`). `onHeldResult` goes with O5.

**The design decision behind it.** "A caller that reads the view next sees
what it wrote" (`controllers/session/sessionStore.ts:5-7`) is implemented by making every write
wait for an asynchronous reader pipeline instead of by applying the written
rows to the view in the writing transaction's continuation.

**The better design.** One tail. The writer already holds the rows it
committed (`appendAll` returns them, `controllers/session/Database.ts:989-998`). Apply them to
the view updater on the writing fiber, in commit order, under the same
`SynchronizedRef` the update fiber uses (the updater is a pure reducer,
`makeSessionViewUpdater`); then the view holds the commit the moment
`transact` returns, with no read-back. Readers that want display rows after a
commit subscribe to one `PubSub<readonly SessionEvent[]>` the writer publishes
to after commit, and a cold reader catches up with one `readDisplay(from)`
then joins the PubSub (what `logTails` does, kept as the one tail).
`settled` becomes "the PubSub has delivered everything published so far":
one `Effect<void>` over a `Deferred` per publish, or simply the writer's own
return. Delete: `SessionStore.folded`, `foldedRead`, `foldedLevel`,
`settlement` (`controllers/session/sessionStore.ts:99-137`), `delivered`, `tailEnded`,
`SessionStore.deliver` (its `trace.committed` text-dropping and `inbox.forget`
move to the writer's post-commit step), `Database.observedCommit` and `now()`
(the writer knows its commit), and, under O1, the `data_version` poll and
`Database.level` for project stores (the global store keeps a poll, since the
service record is multi-process). Consumer counts: `settled` is named in 98
production files but almost all are unrelated words; the service members are
`SessionLog.settled` (runTrace, runHandle, Inbox, sessionReads) and
`SessionEvents.all` (sessionStore, requestPolicy `decision`, runHandle).

**What we give up.** The claim in `LocalSession.view.events` that "another
process's commit reaches this stream" (`effect/sessions.ts:246-251`): under O1
there is no other writer of a project store, so nothing is lost; for the
global store the poll stays. Risk: `RemoteSessionView` (a window over the
service) still builds its view from transport inputs, so the input framer
must be fed from the writer's post-commit publish rather than from
`SessionInputs.read`'s own reads: that is the same PubSub.

**Change amplification.** "A reader must act once a row is visible in the
view" (what `presentTerminalResult` needs): today it learns the
`settle.cursor`/`folded`/`consumers` protocol (`controllers/session/sessionOwners.ts:211-259`,
`controllers/session/sessionStore.ts:96-137,286-298,360-365`): 2 files, ~90 lines. After: a
subscriber on the one PubSub, which fires after the view applied the rows: 1
file, ~10 lines.

---

## Finding 3. A hand-rolled post-commit hook list and an "ordering job" mode on the SQLite write lane

**Red flags:** reinvented Effect primitive (`Context.Reference` + mutable
array as a transaction hook); option for a special case (`order: true`);
special and general code mixed (in-memory text through the row publisher).

**Evidence.** `PublisherJob` is a `Context.Reference<{ committed:
Effect<void>[] } | null>` (`shared/session/sessionEvents.ts:49-53`);
`afterCommit(action)` pushes onto it or runs now (`:59-66`); `committing`
provides it, runs the job, then runs the list (`:73-91`). It is read in 9
production files, 0 tests. Every use is an action the caller could run after
`transact` returns: `agent/followUp/Inbox.ts:162` (notify a reader), `:213` (forget a
reader), `:285` (notify), `agent/runtime/runRegistry.ts:636` (clear `unbornParent`),
`agent/runtime/childTurnResult.ts:72` (log a warning), `agent/storage/runLifecycle.ts:376` (log a
warning), `agent/runtime/SessionEvents.ts:173` (track open work). Its one real reason is
"a job may run again whole" (busy retry, `controllers/session/Database.ts:433-435`), which O1
removes.

`JobOptions.order` (`:97-100`) makes a job that "writes no row" run in its
inbox position with no transaction: used by the `settled` barrier
(`controllers/session/sessionStore.ts:297`), the empty-batch barrier (`:315`) and, in
`controllers/session/runTrace.ts:133-135`, to append a `stream.chunk`'s text to the in-memory
`TextChunkSource` ref _through the SQLite publisher inbox_, so that the text
is ordered after the rows enqueued before it. Every streamed token therefore
takes a turn on the single-fiber write queue (`agent/runtime/SessionEvents.ts:190-194`,
`disableYield: true`). `ordering`'s `append` is a `die` (`:139-141`).

**The design decision behind it.** The log's commit order was chosen as the
one total order for everything in the session, including things that are not
rows, and the retry-able transaction made "after commit" a protocol rather
than sequencing.

**The better design.** With one writer and no retry (finding 2, O1), a
transaction is `Effect.acquireUseRelease(BEGIN, body, COMMIT|ROLLBACK)` as
`inImmediateTransaction` already is (`controllers/session/storeAside.ts:48-63`); "after commit"
is `Effect.tap` on its result at the call site. Delete `PublisherJob`,
`afterCommit`, `committing`, `JobOptions.order`, `ordering`, `reentered`
(`agent/runtime/SessionEvents.ts:139-148`), `SessionLogShape.afterCommit`
(`shared/session/sessionLog.ts:97`). Text chunks go straight to the `TextChunkSource` ref;
the fold already reads "text first, then the level" (`controllers/session/sessionInputs.ts:182-186`)
so a chunk never precedes the `stream.start` row it belongs to, which is the
only ordering the comment at `controllers/session/runTrace.ts:141-146` needs; `stream.end`'s
`finalText` is read from the ref at append time. The `settled` barrier is
finding 2's.

**What we give up.** The guarantee that a detached trace row and the loop's
next batch commit in program order across fibers: with `publish` an Effect
run on the loop's fiber (or a `Queue` the loop drains before its batch), the
order is the caller's sequence, which is what program order meant. Risk: a
plugin that publishes from a non-Effect callback (the hooks' `onToolOutput`)
needs the `Queue.offerUnsafe` door kept for rows, not for text.

**Change amplification.** "Add a second kind of transient text (a tool's
live stdout as its own row kind)": today `controllers/session/runTrace.ts` (`publish` branch +
`committed` drop rule), `agent/runtime/SessionEvents.ts` `openWorkTracker`,
`controllers/session/sessionInputs.ts` `textChunks`, the fold: 4 files. After: the ref and the
fold: 2.

---

## Finding 4. After O1, two ownership facts survive, and both travel through the wrong channel

**Red flags:** two representations of one fact; a durable fact routed through
in-memory state with dedup logic; a cold read that fakes a process.

**Evidence.** The fold takes a `local` input (`shared/session/sessionViewUpdate.ts:255`,
`controllers/session/sessionInputs.ts:126,202-204`) from `LocalRuntimeSource.ref`
(`controllers/session/sessionSources.ts:30-48`), a `{self, dead, unreadable}` record. O1
deletes `self` and `dead`. What is left:

- `unreadable` is a store fact: `readInputBatch` returns `damaged: reader
  .damaged` from the same read that returns the rows (`Database.ts:874`), and
  `controllers/session/sessionInputs.ts:123,152` writes it into the in-memory ref with
  `markDamaged` (`:250-264`), whose comment explains why it must dedupe ("an
  unchanged one would wake this reader again for nothing, forever"). The ref
  change then wakes the same reader (`:135`) to emit a `local` input the fold
  reads (`:465-467`). A row the DB said does not decode makes a round trip
  through memory to reach the fold that is reading that DB.
- `runsHere` (the registry's activation set) will be the one in-process
  fact. Today it reaches the fold as `self: [ownerId]` compared against
  `run.ownerId` (`:447`), i.e. through the claim column. After O1 it must be
  a fold input of its own, and `SessionRequests`' 15 `heldHere` reads
  (`controllers/session/SessionRequests.ts:124-136,185,243,439-441`) and `presentTerminalResult`'s
  `self.includes(end.origin)` (`agent/runtime/HostInteractions.ts:313`) read it as
  `runs.get(id) !== undefined` or `view.run(id).runsHere`.
- `readSessionView` (`controllers/session/readSessionView.ts:77-127`) builds a whole
  `SessionInputs` layer over a fresh `LocalRuntimeSource` with `self: []`,
  replays, then probes dead owners and applies a second `local` input
  (`:97-118`) to produce "interrupted" for a store nobody holds. Under O1 a
  cold read is the rows alone: not ended and not running here is interrupted
  by definition (`:457`), and a held store answers BUSY.

**The design decision behind it.** The fold was given one escape hatch,
"local", for everything the rows cannot say, and the claim column was used as
the carrier for "this process runs it", so a store fact (`unreadable`) and a
process fact (`runsHere`) share one in-memory channel with the liveness
verdicts.

**The better design.** Two facts, two homes. `unreadable` rides the
`drained`/`replay.complete` marker beside `existence` (`controllers/session/sessionInputs.ts:128,216`;
`ExistenceReconciliation` already carries per-aggregate facts from the same
read): delete `LocalRuntimeState.unreadable`, `markDamaged`, and the
`local`-ref write from the reader. `runsHere` is the registry's
`SubscriptionRef<ReadonlySet<RunId>>` (the activation map it already keeps,
`agent/runtime/runRegistry.ts:140`), the fold's one non-durable per-run input; with O1's
deletions `LocalRuntimeSource` becomes that ref and `LocalRuntimeState`
(51 files mention `unreadable`, most as the fold field, 75 host lines) shrinks
to `{ runsHere }`. `readSessionView` then needs no `LocalRuntimeSource`, no
`deadOwners`, no `NO_LOCAL_STATE`: it is `readListing` + the updater over the
listing (the `read([])` path `controllers/session/SessionView.ts:199-221` already is that).

**What we give up.** The `held` status notice with a pid
(`shared/session/sessionViewUpdate.ts:494-495`), already listed by O1. Risk: the webview's
`RemoteSessionView` must receive `runsHere` over the wire as it receives
`local` today (same `_tag`, narrower shape).

**Change amplification.** "A run gets a third non-durable reason it cannot
be acted on here" (e.g. its plugin is being reloaded): today `LocalRuntimeState`
schema, `LocalRuntimeSource`, the writer, `controllers/session/sessionInputs.ts` dedup, the fold,
`readSessionView`, `SessionRequests.admit`: 6 files. After: the registry's
ref and the fold's one `runsHere` read: 2.

---

## Finding 5. "A question to the person and its answer" has five writers, three waiters and a one-caller callback

**Red flags:** information leakage (the `request.opened`/`decided` protocol
known by 8 files); callback parameter with one shape (`AskOptions.open`);
a doc comment that explains a hand-off protocol instead of a structure; a
false comment.

**Evidence.**

- Writers of the `request.decided` draft: `agent/runtime/requestPolicy.ts:191-196`
  (policy's own answer committed beside the `request.opened`),
  `:312-314` (`decisionRow`, a surface's checked decision),
  `agent/runtime/RunHistory.ts:346-356` (cancel every unbound request on activation),
  `agent/storage/runLifecycle.ts:193-206` (cancel every open request on end),
  `agent/runtime/ModelInvoker.ts:100-103` (`PERSONAL_RETRY`, the invoker answering its
  own retry request). `agent/runtime/SessionHandle.ts:114` calls `decide` "the one writer
  of a decision".
- Waiters for the decided row, each a `log.tail(from)` filter: `ask`
  (`agent/runtime/requestPolicy.ts:318-336,368`), `agent/runtime/ModelInvoker.ts:692-694` (because the
  invoker builds its own `request.opened` in `failedRows`, `:620-630`, and
  cannot use `ask`), `agent/runtime/delegation/AgentTool.ts:208` (a script's agent request re-entered
  on resume).
- Fitness of an answer checked at `effect/requestAnswerer.ts:63` (handler's answer),
  `controllers/session/SessionRequests.ts:276` (surface's `request.decide`), and again when the
  asker reads the row back (`recordedDecision`, `agent/runtime/requestPolicy.ts:273-283`,
  which `die`s).
- `AskOptions.open` (`agent/runtime/SessionHandle.ts:62-78`, 8 comment lines) is a callback
  "how the request's rows commit"; its only supplier is `agent/runtime/loop/toolGuard.ts:354-372`,
  which routes the rows through the run's `RunCell` instead of the session
  log so they ride the tool call's batch, and re-derives `from` from
  `cell.opened.commit` on re-entry. `ask` therefore has two bodies depending
  on a parameter: the session-log one (`agent/runtime/requestPolicy.ts:348-355`) and the
  cell one.
- The surface path (`controllers/session/SessionRequests.ts:229-284`): `pendingOf` from the view,
  `blocksCaller && !heldHere` refusal, a plugin's `decision.record` side
  effect run _before_ the row is written (`:259-269`, `Effect.orDie`), then
  `decideUnderGrant` → `requests.decide`, all under `withPerKeyLane` and
  `withRunClaim`. The SDK host path (`effect/requestAnswerer.ts:135-175`) re-asks
  the same `request.decide` with `Effect.retry(times: 3)` and holds the
  fiber with `Effect.never` until the view drops the request, "so the fold
  catching up cannot re-ask it" (`:160-162`): a consequence of finding 2
  (the view lags the write).

**The design decision behind it.** The request is a row of the run's history
(it is in `RunState.requests`, `shared/session/runState.ts:246`), but the door that writes it
was put on the session (`SessionRequests`) with the run's cell reachable only
through a callback, so every run-side writer (policy answer, activation
cancel, end cancel, invoker retry) spells the row itself, and every reader
tails the session log.

**The better design.** The request is the run's. One module,
`agent/runtime/requests.ts`:

```
openRequest(cell, payload, blobs?): Effect<Decision>   // rows through cell.append; policy answer in the same batch; waits on the cell's row stream
decideRequest(runId, requestId, decision): Effect<boolean>   // the checked append any surface or policy uses; the one spelling of the decided row
cancelOpenRequests(state, cause): RequestRow[]         // what activation and end append
```

`openRequest` always commits through `RunCell.append` (the invoker, the tool
guard and the script's agent request all hold a cell), so `AskOptions.open`,
the session-log branch, `recordedDecision`'s read-back check and the
`decision(runId, id, from)` tail become one: the cell's `refresh` already
re-reads a surface's decision (`shared/session/runHistory.ts:242-252`). `decideRequest` is
what `SessionRequests.request('request.decide')`, `approvePendingUnderBypass`
(`agent/runtime/runApprovalQueue.ts:215-240`), `retireStanding` (`agent/runtime/loop/toolGuard.ts:311-321`) and
the invoker's `PERSONAL_RETRY` call; the plugin `decision.record` side effect
runs after the row lands, as a post-commit `tap`, or is refused. Delete:
`AskOptions` (1 supplier), `SessionRequestsShape.ask/decide/decision`
(`agent/runtime/SessionHandle.ts:108-131`), `requestAsks` (2 files), the three `tail`
waiters, two of the three `answerMismatch` sites (one at the boundary:
`SessionRequests.request`), `DecidedDraft`/`decidedRows` as separate from
`decideRequest`.

**What we give up.** `request.decide` from a surface answering a request on a
run the process does not hold: today refused when the request blocks its
caller (`controllers/session/SessionRequests.ts:243-247`) and allowed otherwise; under O1 the
process holds every run of its store, so the branch goes. Risk: the invoker's
retry request is opened inside `failedRows` in the same batch as the `failed`
row (AGENTS.md "a `request.opened` precedes the `failed` attempt that asks
it"); `openRequest` must accept rows to append beside the request (the cell's
`alongside`/batch form already allows it).

**Change amplification.** "A new kind of question a run asks (pick one of
N files)": today the payload schema, `answerFor`'s switch
(`agent/runtime/requestPolicy.ts:121-174`), `answerMismatch`/`decisionFits`, the `ask`
caller, the host answerer, and `SessionRequests.decideRequest`'s `plugin`
branch: 6 files. After: the payload schema, `answerFor`, one caller: 3.

---

## Finding 6. A defect inside a transaction body is re-classified as a disk failure, and the store gate runs on every write

**Red flags:** error handling that should be defined out of existence; a
catch site that re-classifies; a check for a condition the design makes
impossible.

**Evidence.** `mapDatabaseFailure` (`controllers/session/Database.ts:1049-1060`) does
`Effect.catchDefect(defect => defect instanceof OwnersUnproven ? die : fail(defect))`
then `mapError(failed)`. `transact` (`:458-467`) routes through it, so every
`invariant()` `die` in `appendRow` (`:108`; "A run must begin with exactly one
run.start" `:650-658`, "Child creation requires an open parent" `:672-680`,
"Deletion requires the dependent claim" `:748-757`, "No commit assigned"
`:709-712`) leaves `appendAll` (`:989-998`) as a typed `DatabaseWriteFailed`
with the invariant's message as `cause`. `findStorageRefusal`
(`shared/session/runHistory.ts:106-121`) then matches it, `endRun` records the run as
failed, and `RunTrace.lost` reports "Rows this run published were not
written" (`controllers/session/runTrace.ts:165-175`). A caller's bug is presented as a storage
refusal, with the run's state consistent (nothing written) and nobody told it
was a bug. `job` (`:974-990`) is careful to keep non-SQL defects as defects;
`transact` is not, and `appendAll` inside a `job` goes through `transact`.

`storeGate` (`controllers/session/rowCodec.ts:384-393`: `SELECT type, version FROM stored_kind`
then compare to the build's kinds) runs inside every outermost write and
derive transaction (`controllers/session/Database.ts:436-447`, `gated` default) and before every
deletion collect (`:947`), "a store holding a kind this build does not read
takes no write from it". The gate already ran at open (`:279`). It guards
against a newer build writing the same file while this one holds it; under
O1 no other process writes a project store, so the per-write SELECT is a
check on a condition the design makes impossible. `releaseClaims` needs a
`gated = false` parameter to escape it (`:963-972`), itself a special case.

**The design decision behind it.** The transaction wrapper was made total
over its error channel ("Interruption stays; a failure or a driver defect
becomes `failed`'s", `:1047-1048`) so that the typed `Database*Failed` would
be the only thing a caller sees, which turned every defect into one.

**The better design.** `mapDatabaseFailure` catches `isSqlError` only (as
`job` does at `:983-985`); any other defect dies through. Delete
`OwnersUnproven`'s special case there (goes with O1 anyway). Move `storeGate`
to open only (`:279`) and delete the `gated` parameter and the `:947` call;
`DatabaseStoreNewer` stays an open-time refusal.

**What we give up.** Nothing a user sees: an invariant violation today ends
the run with a misleading message; after, it is a defect with the invariant's
message. Risk: a test that pins `DatabaseWriteFailed` on a contract violation
(none found under `src/test-kernel/controllers/session`).

**Change amplification.** "A new store invariant" (say, a `run.detach` on a
run with no parent): today the `invariant` text, plus whichever presenter
turns a `DatabaseWriteFailed` into words, plus the `lost` message: the bug
surfaces in three wordings. After: one `die`.

---

## Finding 7. `SessionHostInteractions` is a state machine in three optional fields with a Proxy overlay

**Red flags:** state machine in optional fields; reinvented Effect primitive
(a `SubscriptionRef<Option<Host>>` + a `Queue`); an interface whose every
member is optional; a `Proxy` to override two members.

**Evidence.** `HostInteractions` (`agent/runtime/HostInteractions.ts:45-72`) has four
members, all optional (`emit?`, `approvalPromptsUnavailable?`,
`approvalDenied?`, `dispose?`). `SessionHostInteractions` (`:118-281`) keeps
`attached: HostInteractions | undefined`, `opened: HostInteractions |
undefined`, `disposed: boolean` and `pendingPresentationReplays:
PresentationProgram[]` capped at 256 with an oldest-drop warning
(`:36,241-255`). `use(host)` (`:138-162`) returns a detach _closure_ with its
own `detached` flag, after replaying the queue (`:257-280`, a `while` over
`shift()`). `attachHost` (`effect/requestAnswerer.ts:183-203`) wraps that closure in
`acquireRelease`, adds a `Deferred ended` completed by a `dispose` injected
through a `Proxy` (`overlay`, `:218-230`) that also rewrites
`approvalPromptsUnavailable` to `false` for a host with `approve`, binding
every function to the target. Every `emit` has three outcomes (live host,
queue, dropped-when-disposed) and two fallback layers (`:171-205`).

**The design decision behind it.** "One host at a time, notices queued while
none" was built as a class with flags rather than as a
`SubscriptionRef<Option<HostInteractions>>` and a bounded `Queue<Notice>`
drained on attach.

**The better design.** `Interactions` = `{ host: SubscriptionRef<Option<H>>,
notices: Queue<Notice> (sliding, 256) }`. `attach(host)` =
`Effect.acquireRelease(SubscriptionRef.set(Some(host)) + drain queue into
host, () => set(None))`, scoped: the caller's scope is the detach, no
closure, no `disposed`. `emit` = `host.get` → present or `Queue.offer`.
`approvalPromptsUnavailable` = a required boolean on a `SessionHost`
(`canAnswer`), never a getter that walks `attached ?? opened`. The overlay
Proxy goes: the SDK's `SessionHost` is converted once into a plain
`HostInteractions` record. Delete `SessionHostInteractions` (3 files),
`PresentationProgram`, `queuePresentationReplay`, `replayPendingPresentations`,
`overlay`, the `ended` Deferred.

**What we give up.** A class-based host keeping its receiver through the
Proxy (`effect/requestAnswerer.ts:222-228`): a record of bound functions built once at attach does
the same. Risk: `HostInteractions.dispose` semantics for the opened host
(`:223-239`): a finalizer on the session scope.

**Change amplification.** "A host adds a surface" (a second window attaching
to one session): today a defect (`:144-149`); after, `host` becomes
`SubscriptionRef<ReadonlyArray<H>>` and `emit` maps over it: 1 file.

---

## Finding 8. "The caller let go of the run" is handled twice, and `onAdmitted` is a callback whose every caller completes a Deferred

**Red flags:** two representations of one fact; callback parameter with one
shape; pass-through.

**Evidence.** `rootRun` (`agent/runtime/rootLaunch.ts:131-161`) makes a `Deferred opened`,
passes `onAdmitted = Deferred.succeed(opened, …)` down two levels
(`:132-133,138,172,205` → `agent/runtime/executeAgent.ts:138`), races it against the
fiber's exit under `uninterruptibleMask`, reads `Deferred.isDoneUnsafe`, and
on interrupt interrupts the fiber (`:154-158`, "A caller interrupted as the
run opened never holds it"). `sessionPrograms.start` (`:159-178`) adds a
second `opened` boolean set in `Effect.map` and a second `onInterrupt` that
calls `registry.interrupt(runId)`, with the same comment ("A caller
interrupted after the run opened, before this hands its handle back, never
holds the run either"). Every supplier of `onAdmitted` does the same thing:
`agent/runtime/delegation/subagentRun.ts:137`, `tools/codemode/backgroundScript.ts:119`, `agent/runtime/resumeRun.ts:309`,
`agent/runtime/rootLaunch.ts:132` all `Deferred.succeed(opened, commit)`.

**The design decision behind it.** The run's "opened" event was exposed as a
callback instead of as a value the launch returns, so each caller rebuilds
the Deferred and the race, and the SDK layer repeats the interruption rule
once more at its own boundary.

**The better design.** `RunRegistry.start` returns `{ fiber, opened:
Deferred<CommitOrdinal> }` (or `executeAgent` completes a `Deferred` it is
handed as a value, not a function). `rootRun` becomes `Deferred.await(opened)`
raced with the fiber's failure, once, and `sessionPrograms.start` does no
interruption bookkeeping: an interrupted caller's scope closing is the one
signal, handled in `rootRun`. Delete `ExecuteAgentOptions.onAdmitted` (7
files), the `opened` boolean and `onInterrupt` in `effect/sessionPrograms.ts:165-178`,
`activationIfOpened`.

**What we give up.** Nothing: both sites implement the rule "an interrupted
launch stops the run it opened". Risk: `Effect.uninterruptibleMask` in
`rootRun` must remain around the fork so the registry entry is never
half-made; the note's run-lifecycle cluster owns that.

**Change amplification.** "A launch gets a second milestone" (the first model
call accepted): today a second callback threaded through `executeAgent`,
`nativeSubagentStrategy`, four suppliers: 6 files. After: a second field on
the returned record: 2.

---

## Finding 9 (batched, smaller). Deletion: an option with two identical values, a decorated method, a per-call scan, an error ladder

**Red flags:** option for a special case; pass-through decoration at the
layer; conjoined error re-classification.

- `DeletionMode = 'single' | 'bulk' | 'automatic'` (`shared/session/database.ts:48-50`,
  7 files): the only reader is `mode === 'single'` (`controllers/session/Database.ts:533`,
  `reclaimable`); `'bulk'` and `'automatic'` are indistinguishable. The note
  deletes `DeletionMode` with the claims; what survives after O1 is a boolean
  nobody needs (every deletion refuses a live run by `RunLive`).
- `requestsLayer` wraps `removeRun` as `tap(store.removeRun(...),
  collectDeletions)` (`sessionOwners.ts:161-162`) and `collectDeletions`
  forks a scan of _every_ pending marker per call (`controllers/session/deletionCleanup.ts:134-158`):
  N removals in a bulk delete fork N full scans concurrently. The collection
  pass belongs to the store (`Database.deletions`) as one scoped fiber woken
  by a marker commit, and `removeRun` returns when the marker commits.
- `InactiveRunStep` (`controllers/session/deletionCleanup.ts:203-208`) re-declares a one-method
  slice of `RunRegistry` to pass it; `deleteAdmittedRun`'s `mapError`
  (`:237-255`) turns `RunLive`, two `DatabaseClaimRefused` verdicts and
  "anything else" into four wordings. After O1: `RunLive` → `Unavailable`,
  one line.
- Three entry points (`request('run.delete')`, `SessionRequests.removeRun`,
  `LocalSession.deleteRuns`) each do admission (`admit` + `expectedStartCommit`
  compare, `controllers/session/SessionRequests.ts:457-463`, and `prepareRunRemoval` compares it
  again at `controllers/session/Database.ts:914-917`); `deleteRuns` maps `NotOwner` → `active`
  (`effect/sessionReads.ts:172`). One `removeRun(runId, atCommit)` with the compare
  in the transaction only.

Good: the marker-then-collect two-phase design (`controllers/session/Database.ts:934-961`,
idempotent `closedBy` check, filesystem before rows, `reclaimFreePages`) is
right and stays.

---

## The store's open / aside / schema-stamp path against "Silent degradation is a defect"

Mostly sound; the failures it handles are real and each is logged at warn
and surfaced once (`storeMovedAside`, shown by four hosts:
`packages/cli/src/runtime/cliService.ts:174`, `packages/cli/src/runtime/initPlatform.ts:336`,
`packages/desktop/src/main/desktopProjects.ts:305`,
`packages/extension/src/extension.ts:449`). Specifically:

- A pre-1.0 store is copied whole (`VACUUM INTO`) to a free `.pre1` name, the
  tables dropped, the schema stamped (`controllers/session/storeSchema.ts:246-311`,
  `controllers/session/storeAside.ts:179-214`); a damaged file at open is renamed with its WAL
  and SHM files and a fresh store opened (`:347-419`). Both keep the data,
  as AGENTS.md "never delete existing user data" asks, and refuse a foreign
  SQLite file or a newer schema outright (`checkStamps`, `:206-233`). Not
  silent.
- Honest edge: `openStore` decides "damaged" from `SQLITE_CORRUPT`/`NOTADB`
  at open (`controllers/session/storeAside.ts:270-272`); mid-session corruption fails the read
  (`:343-345` comment). A file corrupted past its first page but readable at
  open is therefore a `DatabaseReadFailed` on some later read, retried five
  times by the view (`controllers/session/sessionInputs.ts:45-60`) then `orDie`, which ends the
  view's updates with a logged error (`controllers/session/SessionView.ts:94-99`). Loud enough.
- The multi-process defensive loops are what O1 retires: `prepareStore`'s
  `for (;;)` with "another process stamped the file while this one waited"
  (`:261-275`), `underCopy`'s `data_version` compare and `null` restart
  (`controllers/session/storeAside.ts:190-213`), the identity re-check before moving a damaged file
  (`:385-400`). With one opener per store these collapse to straight-line
  code; the double `checkStamps` (read-only probe then real connection,
  `:358-367` and `:262`) stays, since WAL is enabled by the real connection.
- Warn-and-continue sites that _are_ masked failures, all claim-model:
  `claimHolds.decide` ("the claim was not released; the next process proves
  this one dead", `controllers/session/sessionStore.ts:153-160`) and `transaction.release`
  (`:215-224`) swallow a failed `releaseClaims`. Both go with O1.
- `reclaimFreePages` swallows its failure with a warning (`controllers/session/storeSchema.ts:320-341`):
  acceptable, the next collection retries and the only cost is file size.
- `readSessionView.absent` (`:52-68`) answers `false` on an `fs.exists`
  failure with a warning: the open's own failure then stands, so nothing is
  hidden.
- `requiredRead` (`controllers/session/sessionInputs.ts:45-60`): five retries then die; the
  view's `changes` fails every reader with the defect (`controllers/session/SessionView.ts:106-117`).
  Loud.
- `controllers/session/Database.ts:338-365` (the `data_version` poll) logs and retries on
  failure with `READ_RETRY` then `orDie`: loud. Under O1 the project-store
  poll is unnecessary (finding 2).

Verdict: the aside path is not silent degradation. The one re-classification
that hides a bug is finding 6 (`mapDatabaseFailure`).

---

## Good modules in this area (keep, and copy)

- `RunCell` and `makeRunHistory.commit` (`agent/runtime/RunHistory.ts:234-303,366-405`):
  the batch is applied to the state _before_ it is published, so a row the
  handlers reject is never committed; one `SynchronizedRef` serializes
  appends; the interface is `append/refresh/current` over a lot of behavior.
  The deep module the brief asks to copy.
- `inImmediateTransaction` (`controllers/session/storeAside.ts:48-63`): one `acquireUseRelease`
  with a `keep` predicate; `underCopy`'s staged-copy-then-rename under the
  lock; `freeName`. Small, total, no flags.
- `controllers/session/storeSchema.ts` `TABLES`/`ADDITIVE`/`checkStamps`: the DDL, the
  additive set, the three refusals; `SCHEMA_VERSION` separate from row
  versions.
- `Database.deletions.collect` (`controllers/session/Database.ts:934-961`): idempotent, files
  before rows, blob collection by reachability.
- `logTails` (`shared/session/sessionEvents.ts:353-399`): one read per commit however many
  tails; the one tail finding 2 keeps.
- `currentValues.modify` (`shared/session/database.ts:216-222`): read-modify-write under the
  write lock returning `[A] | [A, next]`.
- `followPendingRequests` (`effect/requestAnswerer.ts:93-124`): a `FiberMap` keyed
  by request, interrupted when the view drops it. The right Effect primitive.
- `SessionKey` + `LayerMap` with `Layer.fresh` (`controllers/session/sessionLayer.ts:97-180`):
  one session per root by key equality, correctly `invalidate`d on a failed
  build.

## Already settled, left alone

- The `SessionEvents` publisher as "many producers, one commit order"
  (2026-09-20 note §3). Kept as the one write lane; findings 2–3 take only
  the hook list, the `order` mode and the three tails off it. The rationale
  "many producers" holds while `publish(runId, event): void` is a synchronous
  door for fiberless producers (`shared/session/sessionLog.ts:83`), which the run-loop rules
  in `packages/harness/AGENTS.md` ("What a tool prints while running is
  transient text on the card id") depend on.
- The `PRAGMA data_version` poll and `busy_timeout` (same §3, "two processes
  on one root"): settled for the global store, whose service record is
  multi-process by the owner's O1 decision; for a project store the
  rationale is beaten by O1 itself, so finding 2 names it as a consequence,
  not a new ruling.
- `withPerKeyLane(rootLanes, root)` around `openSession`/`closeSession`
  (`controllers/session/sessionLayer.ts:185,222,296`): guards a real race (a close holding the
  entry for its budget while an open lands); `withPerKeyLane` is the
  documented primitive (root AGENTS.md "Effect").
- The uninterruptible durable append (`agent/runtime/RunHistory.ts:395`) and the 5 s close
  budget (`agent/runtime/SessionEvents.ts:44-49`): `packages/harness/AGENTS.md` "Interruption
  is the fiber's. A durable append is uninterruptible."
- `Schema.declare`-free row codec with `DatabaseRowEarlier` for a kind
  bump (`packages/harness/AGENTS.md` "Storage format"): not touched.
- `Settings`/`controllers/session/appStateStore.ts` over `current_value` (AGENTS.md
  "Configuration, storage, and workspace files"): read and found plain; the
  `workspace-store` record write that "is logged at warn and the project
  still opens" (`controllers/session/appStateStore.ts:102-110`) is a documented, bounded
  degradation (the prune lists one fewer orphan).
