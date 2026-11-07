# T: the session database against pi-durable, mechanism by mechanism

Round 6, area T. Read-only audit of the session database layer, measured
against pi-durable, the peer the harness was compared with in October
(`../2026-10-30-harness-design-against-pi-durable-and-deepseek/pi-durable.md`,
decision `.agents/docs/implemented/architecture/2026-10-30-harness-design-against-pi-durable-and-deepseek.md`).

- **TeXRA read at** `main` `fcb53f7` (#14834, 2026-11-07 11:38 PST).
- **pi-durable read at** `earendil-works/pi` `a4ccccbd64d4ccea1644f5a07bb94ef09075b219`
  (2026-11-07 19:15 UTC), `packages/durable`; `badlogic/pi-mono` resolves to
  the same commit. The October evidence file read `31ade0e`; where the peer
  changed since, this report says so (group commit in 1.5.0, a new
  `session/writer.ts`, `session/conversation-tails.ts`).
- **Package E's format PR** (branch `simplify/e-format-batch`: the
  `process.output` gap-marker row, `event_blob.inline`, `section()`) was not
  open when this audit was written; no branch of that name existed. E's open
  branches (`simplify/e-r3-e2`, `simplify/e-lens-batch`) do not touch the
  store modules below. Nothing here reports what that PR is chartered to
  remove: F2 (`event_blob.inline`, the `blobDigests` regex), Y3 (the
  gap-marker row) and V-R2 are cited, not repeated.

The rules, flag species and output format are round 2's
(`../2026-11-06-design-red-flags-round-2/BRIEF.md`) with the round-3 and
round-4 additions: a finding already recorded is cited, the report ends with
an Effect-native mapping and an owner per finding.

## Summary

The owner's judgement holds, but not where the store's own documents look
for it. The SQL layer (one file, STRICT tables, one `BEGIN IMMEDIATE`
writer, the gate, content-addressed blobs, collection by reachability) is
sound and in places stronger than the peer. What is not as clean is the
layer between the writer and its readers: **TeXRA writes a batch and then
reads it back from SQLite, three ways, to learn what it wrote**, and it
keeps the machinery of a multi-process store (per-read projection checks,
busy retries, change records) on a store that one process holds. pi-durable
publishes each commit from memory, in line order, the moment storage
accepts it, and never reads its own writes back. That one difference is
most of the line count between the two.

Two catalogue rows are wrong about the code: B2/B3 ("three tails",
`order: true` jobs) and B6 (`mapDatabaseFailure` re-classifying defects) are
listed as landed by #14769 (R1), but their symbols are on `main`. #14769's
body lists what R1 deleted (claims, liveness, `PublisherJob`/`afterCommit`,
the per-write gate on project stores); the tails, the settle coordinates,
the ordering jobs and the defect re-classification are not in that list and
not in the compromises note (`.agents/docs/proposed/architecture/2026-11-06-root-designs-pr1-compromises.md`).

Six findings and one batch. By red flag: reinvented primitive 2 (T1, T2),
repetition/two representations 2 (T5, T6), errors not defined out of
existence 1 (T4), special and general code mixed 1 (T3), with T1 also
information leakage and change amplification. The fix plan is two PRs,
both after E's format PR.

## Numbers

| Measure                                         | TeXRA (`fcb53f7`)                                                                                                                                                                                                            | pi-durable (`a4ccccb`)                                                                                                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The area's modules (the list in the brief)      | 9,238 lines in 30 files                                                                                                                                                                                                      | `session/` 4,632 lines in 7 files; `storage/sqlite/` 1,646 in 6                                                                                                                 |
| Largest files                                   | `Database.ts` 945, `sessionStore.ts` 290 (plus `shared/session/sessionViewUpdate.ts` 1,105, `runState.ts` 588 as the folds)                                                                                                  | `session/session.ts` 2,105, `session/transaction.ts` 1,300, `storage/sqlite/storage.ts` 729                                                                                     |
| Comment share, worst files ≥ 200 lines          | `shared/session/sessionEvents.ts` 111/336 (33 %), `storeSchema.ts` 101/421 (24 %), `sessionStore.ts` 44/290 (15 %), `sessionInputs.ts` 43/287 (15 %), `Database.ts` 117/945 (12 %)                                           | n/a                                                                                                                                                                             |
| Tables                                          | 7 base (`event_sequence`, `event`, `blob`, `event_blob`, `stored_kind`, `current_value`, `input_history`) + 5 additive (`aggregate_change`, `projection_state`, `projected_row`, `listing_entry`, `run_usage`) + 3 triggers  | 9 (`durable_schema`, `durable_metadata`, `record_ids`, `conversations`, `entries`, `tasks`, `submissions`, `documents`, `document_revisions`), `storage/sqlite/schema.ts:10-20` |
| Modules a row crosses to disk                   | 7: `RunHistory` → `sessionStore.transaction` → `SessionEvents.transact` (queue + `Deferred`) → `Database.job`/`own`/`withTransaction` → `appendAll`/`appendRows`/`appendRow` → `rowCodec.encodeDraft` → `projections.follow` | 4: `Tx` → `Session` line → `writer.ts` → `Storage.commit` (`storage/sqlite/commit.ts`)                                                                                          |
| Ways back from disk to the writer's own process | 3 readers, 6 coordinates (T1)                                                                                                                                                                                                | 0: publication from memory (`session/writer.ts:1-19`)                                                                                                                           |
| Transaction modes                               | 3 (`read`, `write`, `derive`; `Database.ts:100-103`) + a second wrapper (`storeAside.ts:42-58`)                                                                                                                              | 1 commit path                                                                                                                                                                   |
| Busy retries                                    | `retryBusy` on every read (`Database.ts:280`) and every outermost transaction (`:468`), on project stores opened with `busyTimeout 0` (`:224`)                                                                               | none; one process owns a storage (`README.md:894`)                                                                                                                              |

## The questions, answered

**How many modules stand between a row and the disk, and what does each
add?** Seven (table above). Four add something: `RunHistory` folds before it
publishes (`agent/runtime/RunHistory.ts:292-297`), `SessionEvents` orders
jobs (`agent/runtime/SessionEvents.ts:186-195`), `Database.appendRow`
enforces the aggregate rules, `rowCodec` owns the stored shape. Two are
pass-throughs that add one wait each: `sessionStore.transaction`
(`controllers/session/sessionStore.ts:141-164`) adds only "wait until the
tail and the view read my commit back" (T1), and `Database` stacks four
wrappers over one transaction (`own` 461-475, `transaction` 476-480,
`transact` 484-490, `job` 865-875), each re-mapping errors (T4). pi: the
line, the writer, the storage.

**How many representations does one row have?** A `run.description` today:
the draft schema (`shared/schemas`), the stored encoding (`rowCodec.encodeDraft`,
with `$`-key escaping and inline blobs), the decoded `SessionRow`
(`rowCodec.decodeRow`), the `listing_entry` key (`listingKeyOf`,
`shared/schemas/sessionEvent.ts:477-490`), the `RunRows.title`/`label`
fold (`shared/session/runRowReads.ts:168-176`), `RunView` in
`sessionViewUpdate.ts`, and the listing row read back for the cold view.
Seven. pi: the record JSON in its table and the in-memory record; the
transcript's model context is the only derived form (`harness/context.ts`).
T5 and T6 are the two representations the peer comparison shows are not
paying for themselves.

**Where does TeXRA hold state in optional fields or sentinels that the peer
holds as a row?** Less than before: `RunView.status` (C1), `child.park`
(C4) and the halted position (C3) have landed. What remains is state the
peer holds in memory and TeXRA holds in SQL or in process maps fed by
read-back: `rowReader`'s `unopenable`/`earlier`/`scanned`/`warned`
(`controllers/session/rowReader.ts:196-206`), a per-process cache of a
store fact filled by whichever read meets a bad row first; the display
pager's `tombstones` map (`Database.ts:727-750`); `aggregate_change`
(`storeSchema.ts:117-128`) as an existence log for a reader that no longer
needs one (F13, below).

**Which guarantees cost how many lines?**

| Guarantee                                | TeXRA                                                                                                                                                                           | pi-durable                                                                                                        | Verdict                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| One writer, commit order = enqueue order | `SessionEvents.ts` 298 + the tails and `tailFrom` in `shared/session/sessionEvents.ts:190-336` (147) + `sessionStore.ts` settle (`:96-164`, 69)                                 | `session/writer.ts` 361 (group commit, publication in line order)                                                 | TeXRA's publisher is right-sized (≈190 lines with `detach` and the close deadline); the read-back around it is the excess (T1) |
| Cross-process exclusion                  | 15 lines: `locking_mode = EXCLUSIVE` + one `BEGIN IMMEDIATE`/`COMMIT` at open (`Database.ts:248-261`)                                                                           | none: "One process owns a storage at a time; there is no cross-process locking" (`README.md:894`)                 | TeXRA stronger, for less                                                                                                       |
| Store gate / format refusal              | `storeGate`, `readableVersion`, `rowRefusal`, `EARLIER_RUNS` (`rowCodec.ts:126-170, 366-404`, ≈90), `rowReader` scan and marks (≈110), `rowVersions.ts` 335, spec §2.4 72 lines | Chord's forward migrations (`storage/sqlite/migrations.ts` 138); records carry no per-kind version                | TeXRA's costs more and does more (partial readability: a damaged run lists, others resume); keep, see "Good"                   |
| Crash conformance                        | `src/test-kernel/support/crashConformance.ts` 1,416 + `storeFaults.ts` 624, a real store truncated at every commit                                                              | `src/testing/storage-conformance.ts` 2,099 (backend contract); crashes simulated by an in-process storage `Proxy` | TeXRA stronger per line                                                                                                        |
| Blob reachability                        | `event_blob` + `dependentBlobs`/`collectBlobs` (`Database.ts:329-334`) + `inflateBlob`/`blobDigests` (`rowReader.ts:105-123`): ≈45 lines                                        | no content addressing (`store/commit.ts` passes `fingerprint: ""`, October file §2.9)                             | keep; the three addressing schemes around it are T6                                                                            |
| Deletion and collection                  | `deletionCleanup.ts` 316, `Database.runRemoval`/`deletions` (`:820-864`) 45, `reclaimFreePages` 30, `sweepLeftoverRuns.ts` 81                                                   | none for conversations; task-scoped documents retire with their task                                              | TeXRA does more; its one excess is the read-back hop (T1)                                                                      |

**What is reinvented that SQLite, Effect or Node provides?** The writer's
post-commit publication is reinvented as a read-back pipeline over a wake
counter (T1): Effect's `PubSub` after the commit is the thing, and the
publisher already applies its own commits in memory for one fact
(`openWorkTracker`, `SessionEvents.ts:76-114`). The per-read projection
check is a hand-rolled snapshot-isolation proof that SQLite's single writer
already gives (T2). The busy retry is SQLite's `busy_timeout` reimplemented
on the fiber, needed for the global store only. The incremental vacuum and
the inbox are not reinvented: `incremental_vacuum` is SQLite's, and the
inbox is a `Queue` (refuted candidate `EFF-ADOPT-per-key-lane-semaphore`
explains why a `Semaphore` would not keep `detach`'s call-time order).

**Which errors could be defined out of existence?** T4: a protocol
violation that dies, then is caught and re-typed as a disk failure; a
`DatabaseStoreNewer` branch in `job` that a project store cannot reach; a
deletion's stale admission as a plain `Error` string that reaches the user
as "could not be removed".

**Where is the design right, and the peer simpler only because it does
less?** See "Good, left alone": the exclusive lock, one backend, partial
readability, truncation-based crash conformance, deletion with
collection, resume as the same fold. pi has none of the first, five
backends with repeated validation, no partial readability (any storage
throw fails the session, `GuardedStorage`), crash simulation by proxy, no
conversation deletion, and resume by checkpoint discipline (rule 6, read
before write) pushed onto every task author.

## Findings

### T1. The writer reads its own commits back from SQLite, three ways, to learn what it wrote

**Red flags:** reinvented Effect primitive; information leakage (every
caller of `transact` waits on a reader protocol); change amplification.
**Status:** FOUND as B2 and B3 (round 1) and designed as R1's interface
(`.agents/docs/proposed/architecture/2026-11-05-root-designs-effect-native.md`
§R1 "Design" and "Deletes"). The catalogue lists both as landed (#14769);
they are not. This entry corrects the status and adds the peer comparison;
it does not re-derive B2.

**Evidence, on `fcb53f7`.** Every symbol R1's "Deletes" names for this half
is present:

- `SessionStore.folded`, `foldedRead`, `foldedLevel`, `settlement`,
  `delivered`, `tailEnded`, `SessionStore.deliver`
  (`controllers/session/sessionStore.ts:96-137, 186-196, 248-279`).
- `Database.observedCommit` (`Database.ts:263-267`, `:405-422`, set inside
  the connection's release finalizer) and `SessionLog.now()`
  (`sessionStore.ts:226`; 4 callers: `HistoryQuery.ts:326`,
  `toolGuard.ts:370`, `AgentTool.ts:201`, `followUpMessages.ts:144`).
- `JobOptions.order`, `ordering`, `reentered` (`SessionEvents.ts:139-148`),
  used by the `settled` barrier (`sessionStore.ts:199-202`), the empty-batch
  barrier (`:219`) and `runTrace.ts:134`, which routes streamed text
  through the SQLite write inbox.
- The three readers: `logTails` over `readDisplay`
  (`shared/session/sessionEvents.ts:290-336`), `SessionInputs` calling
  `readInputBatch` on every `level` wake (`controllers/session/sessionInputs.ts:104, 134`),
  and `folded`, a third `tailFrom` over `readDisplay` gated by
  `min(view.cursor, delivered)` (`sessionStore.ts:248-253`).

The cost a caller sees: `sessionStore.transaction` returns only after the
`deliver` tail has re-read and decoded its commit and the view has folded
the `readInputBatch` re-read (`:160-163`); `settled` (16 call sites in 13
files) additionally enqueues an ordering job and waits for the third
reader. A request's answer is found by re-reading the tail
(`agent/runtime/requests.ts:327`, `decisionOf`) though this process wrote
the `request.decided`. A deletion marker returned in memory by
`removeRun` (`SessionEvents.ts:255-261`) reaches the collector only after
`deliver` reads it back (`sessionOwners.ts:265-270`), through a second
queue fiber (`deletionCleanup.ts:158-161`).

**Peer.** pi's writer publishes each admitted part "in line order, once it
is durable (with its seq)" (`session/writer.ts:13-19`, `PartSpec.publish`);
watches, views and the scheduler see the commit from that call. Its newest
entry per conversation is kept "current from the Session's commits":
"every entry is written by one of its commits, so `apply` keeps both
current" (`session/conversation-tails.ts:12-21`). Nothing reads its own
write back. TeXRA already does this for one fact: `openWorkTracker`
applies committed rows in memory (`SessionEvents.ts:76-114, 179`).

**The design decision behind it.** "A caller that reads the view next sees
what it wrote" was implemented by waiting for asynchronous readers instead
of applying the written rows on the writer's fiber. Under O1 there is no
other writer of a project store, so nothing the read-back finds is news.

**Better design.** R1's, unchanged: the publisher job, after its commit,
applies the rows it holds to the view updater (as `track` does for open
work) and publishes them to one `PubSub<readonly SessionRow[]>`; `logTails`
is that PubSub plus one `readDisplay(from)` for a cold reader; `settled` is
the job's own return; `decisionOf` and the deletion collector subscribe to
the PubSub (or take `removeRun`'s return). Delete: the symbols listed
above, `Database.level` on project stores, `readInputBatch`'s `since`/
`change` coordinate (with F13), and `SessionInputs`' own read loop for the
local view (`RemoteSessionView` keeps transport inputs). About 350 lines.

**What we give up.** Program order across fibers for a detached trace row
against the loop's next batch becomes the caller's sequence (R1 already
accepted this). The crash suite records commit points from
`observedCommit` (`crashConformance.ts` header); it reads them from the
transaction results instead. The global store keeps its poll.

**Change amplification.** "A reader must act once the view holds a row"
(what `presentTerminalResult` needs): today `sessionOwners.ts:271-293` plus
`sessionStore.ts`'s settle protocol, 2 files and ≈90 lines; after, one
PubSub subscriber.

**Owner / depends on:** E (store), after E's format PR. Biggest single
item in the plan.

### T2. Projection currency is re-proved on every read, though one process writes the store and the append keeps it current

**Red flags:** reinvented primitive (a hand-rolled isolation proof);
special case kept as a general path; a mode for one caller. New.

**Evidence.** Five reads go through `projected` (`Database.ts:539-558`):
`readDisplay`, `readListing`, `readRunRecords`, `readDisplayAggregate`,
`readInputBatch` (`:731, 761, 764, 784, 793`). Each opens a read
transaction, reads `projection_state`, compares every projector with the
current commit (`projections.ts:276-283`), and on a miss runs a `derive`
transaction (`TxMode` third value, `Database.ts:100-103`) in a loop until
caught up, then reads again. Its comment states the reason: "so another
build's rebuild never hands it a half-built one" (`:535-538`). Meanwhile
`appendRows` calls `upkeep.follow` in the same transaction as every append
(`:577`; `projections.ts:328-345`), so a projection current before a batch
is current after it.

After O1 a project store has one writer, this process. A projection can be
behind only when the store was last written by a build with another
projector version, which is known at open. The global store holds no event
rows (`GlobalDatabase` is `values` and `inputHistory`,
`shared/session/database.ts:310-321`), so it never needs a projection.

**Peer.** pi has no projections: it stores the current record per task,
submission and conversation and reads them through indexes
(`tasks_by_status`, `submissions_by_conversation`;
`storage/sqlite/schema.ts:22-38`). Fair: TeXRA's listing over an event log
needs a projection, and rebuilding it from rows when a projector changes
(P6 of the store review) is better than pi's record migrations. The
excess is only the per-read proof.

**Better design.** Catch up every projection once, at open, inside the
open's write transaction (the code is `upkeep.catchUp` looped, as now);
from then on `follow` keeps them current and every read is a plain
`query`. Delete `projected`, the `derive` mode and its branches in `own`
and `acquireConnection`, `upkeep.current`, and `follow`'s "current through
`before`" filter (`projections.ts:338-341`) together with `isCurrent`'s
second caller. About 45 lines; one mode fewer in `TxMode`.

**What we give up.** A store with a very large backlog for a changed
projector opens slower (the rebuild runs before the first read instead of
during it). The rebuild already blocks the first read today, so the user
waits the same time.

**Change amplification.** "Add a third projection": today a projector entry
plus every read that must name `projected`; after, the projector entry.

**Owner / depends on:** E; independent of T1, cheapest item in the plan.

### T3. One plugin's transition rule, and one read per draft, inside the store's append

**Red flags:** special and general code mixed; repeated work the batch
could do once. New.

**Evidence.** `appendRow` (`Database.ts:580-721`) does, per draft: one
`readState` for a reparent (`:588-599`, two when the parent changes), one
for a declared parent (`:648-665`), and for every `plugin.fact` it reads
and fully decodes every `plugin.fact` row of the aggregate
(`pluginRows`, `:500-501, 609-617`) to find the last row of one name, then
asks that kind's `accepts`. One fact kind in the codebase defines
`accepts`: `externalInquiry` (`packages/texra/src/shared/plugins/externalInquiry.ts:226`).
The read runs before the check, for every fact kind, so an aggregate with
_n_ facts pays O(_n_) decodes per fact append, O(*n*²) over its life, to
serve one plugin's rule.

**Peer.** pi 1.5.0+ "reads the check state of all batches up front, checks
them in memory, and writes the accepted batches per table in multi-row
statements" (`CHANGELOG.md` `[Unreleased]` "Changed"); its storage holds no
per-kind transition hook, and owner rules are checked once per commit in
`Transaction.#validateOwners`.

**Better design.** The plugin owns its rule: it reads its last fact with
`SessionLog.runRows(id, 'facts')` and decides inside the same publisher job
before it appends (one job is one transaction, so read-then-append is
atomic). Delete `FactKind.accepts`, `pluginRows` and the branch
(`Database.ts:609-626`). Batch the existence reads: one `READ_STATE` over
every aggregate and parent the batch names, before the first insert.

**What we give up.** A rule the store enforced for any writer becomes the
plugin's writer's to keep; there is one writer per fact kind.

**Change amplification.** "A second plugin wants a transition rule":
today the store's append path; after, that plugin's module.

**Owner / depends on:** E for the store half, with C's owner for
`externalInquiry.ts` (app plugin).

### T4. Errors the store's shape could remove

**Red flags:** errors not defined out of existence; one rule re-classified
at four wrappers. **Status:** the first item is FOUND as B6 and listed as
landed (#14769, R1); it is not. The others are new.

**Evidence.**

- `mapDatabaseFailure` still catches every defect and re-types it as the
  operation's failure (`Database.ts:934-945`: `Effect.catchDefect((defect)
  => Effect.fail(defect))`), and its comment now names the store's own
  `invariant()` dies as included. R1's design: "`mapDatabaseFailure` catches
  `isSqlError` and lets a defect die". So a draft that breaks the seq-1
  rule ends its run as `DatabaseWriteFailed`, a disk failure, and the
  defect is lost.
- `job` re-classifies again (`:865-875`): `isSqlError(e) || e instanceof
  DatabaseStoreNewer` to `writeFailed`. A project store runs the gate at
  open only (`:287-292, 310`) and is held exclusively, so
  `DatabaseStoreNewer` cannot arise in a project store's job; the branch
  serves the global store, which runs no jobs.
- `runRemoval` refuses with plain `Error` strings ("Deletion target is
  missing or closed", "changed since admission", `:826-832`), and
  `deleteAdmittedRun` maps every non-`RunLive` failure to "could not be
  removed from the listing" (`deletionCleanup.ts:252-265`): a stale
  admission and a disk failure read the same.

**Peer.** One rule: any storage throw fails the session into one reopenable
state (`GuardedStorage`, October file §4 and §6 "Credit where due"). pi's
peer lesson is not to copy the latch (TeXRA's per-run refusal is better),
but to keep one classification point.

**Better design.** `mapDatabaseFailure` maps `isSqlError` only; `invariant`
dies. `job` drops the `DatabaseStoreNewer` branch (the global store keeps
its gate in `own`). A stale deletion is `DatabaseAggregateClosed` (target
closed) or a typed `RunChanged` that `deleteAdmittedRun` reports as such.
Net about −10 lines and one class of misreport.

**What we give up.** A store-protocol violation now crashes the run's fiber
as a defect instead of ending it with a write failure; the run reads as
interrupted at its next open, which is the existing contract for a refused
end.

**Owner / depends on:** E; lands with T1 (the same module).

### T5. "Latest row per key" is written twice: once for the SQL projection, once for the fold over its output

**Red flags:** repetition/two representations; information leakage. New
(C10, landed in #14788, reshaped `RunRows`; this is the pair it left).

**Evidence.** The listing projection keeps one row per `(aggregate, key)`
where the key is `listingKeyOf` (`shared/schemas/sessionEvent.ts:477-490`)
or `pendingKeyOf` (`:495-510`), written by `projections.ts:105-122`.
`readRunRecords` reads exactly those rows (`rowReader.ts:87-92`), and
`runRowsFrom` folds them again with `recordFacts`
(`shared/session/runRowReads.ts:139-230`, a 40-case switch) to compute
"its latest `run.report`, `process.exit`, `run.config`…"
(`shared/session/runRowsShape.ts:79-110`) over rows that are already the
latest. The two rules can disagree: "a user's title stands until the user
renames again" lives only in the fold (`runRowReads.ts:168-176`); the
projection keeps both titles under `run.description/<by>` and relies on
the fold to choose (`sessionEvent.ts:486-488`). `RunView` in
`sessionViewUpdate.ts` keeps a third copy ("The session view keeps its own
on `RunView`", `runRowsShape.ts:76-77`).

**Peer.** pi stores the current record and replaces it whole
(`TaskRecord`, a checkpoint per phase); "latest" is never derived. Fair:
TeXRA's event log is the authority on purpose (resume is the same fold,
`packages/harness/docs/spec.md` §5.5), so a derived record is the price.
The excess is deriving it twice.

**Better design.** One owner for "what a run's record is": the projector
writes one `run_record` row per run (its fields as `RunRows` declares
them, the title rule included), `SessionLog.facts` reads that row, and
`recordFacts`/`runRowsFrom` go. `RunView` initialises from the same row on
a cold read. A projector version bump rebuilds it (P6). Medium: about −60
lines in `shared/session`, +40 in `projections.ts`.

**What we give up.** `RunRows` stops being computable from an arbitrary
row slice (the `input` read in `RUN_ROW_READS` uses `runRowsFrom` over its
own selection, `runRowReads.ts:86-89`); that read keeps a narrow fold of
the four lifecycle fields it needs.

**Change amplification.** "A run gains a record field": today
`listingKeyOf` or `ROW_KINDS[...].listing`, `recordFacts`, `RunRows`, and
`sessionViewUpdate.ts`: 4 files; after, the projector and `RunRows`: 2.

**Owner / depends on:** E; after T2 (projections caught up at open) and
after E's format PR.

### T6. Three content-addressing schemes for one need, and one content stored under two digests

**Red flags:** repetition/two representations; nonobvious code. New;
borders F2/#14741 (`event_blob.inline`, E's format PR), which separates two
of the three in the link table and does not touch the third.

**Evidence.**

1. Inline blobs: any payload string of 4,096 characters or more is replaced
   by `{ $b: sha256(JSON(text)) }`, and a payload's own `$`-prefixed keys are
   escaped so they never collide (`rowCodec.ts:66-79, 211-220`).
2. Brought blobs: a caller hands media bytes with their address, stored
   once, or linked when `text` is absent (`rowCodec.ts:200-208`).
3. The `context.blob` row kind: a model request's canonical JSON stored in
   `event.data` under its own sha256 (`rowCodec.ts:192-198`), read by
   `runState.ts`, `forkRun.ts` and `run/requestContext.ts`.

A request of 4,096 characters or more is both: scheme 3 stores
`{ digest, value: canonical }`, and scheme 1 then moves `value` to the
`blob` table under `sha256(JSON.stringify(canonical))`, a second digest
for the same content. The store review's F14 records the cost of scheme 3
being a row: an additive change to request JSON regenerates the golden
store.

**Peer.** pi stores no content address (documents are a delta log with
caller-decided bases, `fingerprint: ""`); a repeated system prompt is
stored again. Fair: TeXRA's dedup earns its keep (request text repeats
every turn); the excess is having three ways to do it.

**Better design.** One scheme: the `blob` table under one digest per
content. A request's canonical JSON is a brought blob whose address is its
digest; `model.message` names it as today; the `context.blob` kind is
retired (`execution`, so runs that hold it read as an earlier build's,
which before the freeze is the policy). Scheme 1 stays for incidental long
strings. Delete the `context.blob` arm of `encodeDraft`, its row kind and
its readers' row lookups. Format change: it must ride E's batch or the
next one.

**What we give up.** A request is no longer readable by a plain `SELECT` of
the event table; it was not readable that way above 4,096 characters
anyway.

**Change amplification.** "Store a tool's large input once": today pick
one of three; after, one.

**Owner / depends on:** E; inside or after E's format PR (a row kind
retired).

### T7 (batched). Smaller items

- **a. A value subscriber re-reads on every event commit.**
  `CurrentValues.changes` wakes on `level` (`currentValues.ts:163-164`),
  which every event write moves (`Database.ts:405-422`), so each streamed
  trace batch on a project store re-runs `SNAPSHOT` for every subscribed
  family (workspace state uses project values,
  `appStateStore.ts:113-136`). After T1 `level` is the values' own write
  counter on a project store. Owner E, with T1.
- **b. The codec ratchet the store review leans on is gone.** The review's
  "Kept" list names `storedShapeBoundary.vitest.ts` ("no SQL reads a
  payload field, nothing above the codec sees a version"), and so does the
  storage-v1 design; no such file exists at `fcb53f7`. Either the rule is
  stated as a convention (AGENTS.md "conventions with no mechanical check")
  or the review is corrected. Owner: owner's call (docs).
- **c. Multi-process comments on single-process paths.** "Already
  collected (by this pass before, or another process)" (`Database.ts:843`),
  "may run twice, in one process or two" (`deletionCleanup.ts:130-131`):
  false for a project store since O1. A false comment is a bug (AGENTS.md
  "Plain names and comments"). Owner E, with T1.

## Recorded, still open on `main`

Items an earlier note found; listed so the fix session sees them on one
page. None is repeated as a finding.

| Item                                                                                                                                                                                | Where recorded                                             | State at `fcb53f7`                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `aggregate_change`, its three triggers (one, `claimed`, fires on the dead `owner_id`), `CHANGED_SINCE`, `readInputBatch`'s `since`/`change`                                         | F13, store review §5 (ruled: delete inside the lock slice) | present (`storeSchema.ts:117-128`, `Database.ts:141-144, 792-819`); the lock slice landed (#14769) without it. Goes with T1 |
| `DISPLAY_PAGE_END` and the `at`-equality batch rule                                                                                                                                 | F3 / S3                                                    | present (`Database.ts:152-161`)                                                                                             |
| `event_blob.inline`, the `blobDigests` regex and `decodable` pre-check                                                                                                              | F2 / S2, #14741, V-R2                                      | present (`rowReader.ts:114-123`); E's format PR                                                                             |
| Forward-step table, guarded `ADD COLUMN`                                                                                                                                            | F4 / S4                                                    | absent (`checkStamps` refuses any other stamp, `storeSchema.ts:216-228`)                                                    |
| `StoreConnection` out of `Database.ts`; closure bags into `currentValues`, `projectionUpkeep`, `rowReader`                                                                          | F5 / S5                                                    | present (`Database.ts:534, 765-774`; `currentValues.ts:72-92`)                                                              |
| `ValuesStore` split; the global store opens the full event store with an empty tool registry                                                                                        | storage-errors note §1 (accepted 2026-11-04)               | present (`Database.ts:918-932`)                                                                                             |
| `databaseLayer(mode)`'s four values; one busy policy                                                                                                                                | storage-errors note §1                                     | present (`Database.ts:176-247`; `retryBusy` at `:280, 468`, `storeSchema.ts:327`)                                           |
| A1 to A9 (text-chunk keys, `recordOf` as a type test, aside names, `texra.db` literal, the roots copy, `GeneratedRootRedirected`, draft re-validation, `sessionViewUpdate` helpers) | store and test-support debts note                          | A3 done (`Schema.encodeSync` at `currentValues.ts:128`); A4 landed in part (#14689); the rest present                       |

## Good, left alone

- **The exclusive lock** (`Database.ts:248-261`): fifteen lines give what pi
  leaves to its caller ("6 of 7 downstream apps add their own lock", October
  file header) and what dsh needs a kernel lock module for.
- **One backend.** pi ships five storages (memory, SQLite, JSONL,
  IndexedDB, `StoreStorage`) that repeat `checkGlobalIds`, `isAliveAt` and
  `prepareDocumentActions` with the same error strings (October file §1).
  TeXRA's one SQLite file is the reason its gate and its blob collection can
  be SQL.
- **Partial readability.** A damaged or earlier-build row fails only its
  run; the listing still shows it (`rowReader.ts:299-319`, `bareStart`). pi
  fails the whole session on any storage throw.
- **Crash conformance by truncating a real store at every commit**
  (`crashConformance.ts`, spec §9), plus one real kill
  (`goldenStore.vitest.ts`). pi simulates a crash with an in-process storage
  `Proxy` and has no test that runs two writers (October file §7).
- **Resume is the same fold.** `RunCell.append` folds before it publishes
  and is a `SynchronizedRef` (`RunHistory.ts:368-395`); no task author
  splits work at every effect or obeys read-before-write, which pi's spec
  §12 lists as 46 footguns.
- **Deletion with collection and page reclaim** (`Database.ts:820-864`,
  `storeSchema.ts:322-341`). pi deletes no conversation.
- **The publisher itself** (`SessionEvents.ts`, without the read-back): an
  unbounded `Queue`, one consumer fiber, a close deadline, `detach` for
  fiberless producers. The refuted candidate
  `EFF-ADOPT-per-key-lane-semaphore` explains why a `Semaphore` would not
  keep call-time order.
- **Corruption moved aside, network filesystems refused**
  (`storeSchema.ts:349-421`, `localDatabasePath.ts`): neither peer does both.

## Design it twice

**A. The store as pi-durable would shape it, over TeXRA's requirements.**
Record tables per kind (`run`, `request`, `followup`, `call`), each row the
current record replaced whole in the commit that changes it; an
append-only `entry` table for the transcript; a session writer that
publishes each commit from memory; the run loop resumes from the `run`
record's checkpoint. Gains: no projections, no `RunRows` fold, no
"latest" rule, listing is `SELECT * FROM run`. Costs: resume is no longer
the same function as live (a checkpoint is a second representation of the
loop state, which pi pays for with rule 6 and read-before-write); crash
conformance must check checkpoint/entry agreement instead of truncating a
log; every stored-record change is a migration of live rows instead of a
projector rebuild; the event log as audit and as the source of the
transcript goes. It reopens the 1.0 ruling (SQLite event log, projections
rebuilt from history) for a gain the next option gets for less.

**B. The current shape** (event log, folds, projections) with its read-back
and multi-process residue.

**C. Chosen: B's data model with A's publication.** Keep the event log and
the folds; take from pi the one mechanism that matters: the writer
publishes what it committed from memory, and nothing re-reads its own
writes. Then remove what O1 made dead: per-read projection checks, the
`derive` mode, `aggregate_change`, project-store busy retries; and store
the derived run record once (T5). This keeps every guarantee in
"Good" and deletes the layer the owner's judgement is about.

## Fix plan

Both PRs land after E's format PR (it rewrites `rowCodec.ts`, `rowReader.ts`
and regenerates the golden store; starting before it means two golden
regenerations from different bases, store review F14).

**PR 1: the writer publishes; nothing reads its own writes back** (T1, T2,
T4, T7a, T7c, F13). About −450 lines.

1. T2 first (smallest, independent): projections caught up once in the
   open's transaction; delete `projected`, `TxMode 'derive'`,
   `upkeep.current`. Files: `controllers/session/Database.ts`,
   `controllers/session/projections.ts`, `controllers/session/storeSchema.ts`
   (call site in the open).
2. T1: the publisher job applies committed rows to the view updater and
   publishes them to one `PubSub`; `logTails` becomes that PubSub with a cold
   `readDisplay`; delete `folded`, `foldedRead`, `settlement`, `delivered`,
   `tailEnded`, `deliver`, `observedCommit`, `now()`, `order`, `ordering`,
   `level` on project stores, `readInputBatch`'s `since`/`change` and
   `aggregate_change` with its triggers (left in place as dead DDL only if
   S4 has not landed: a dropped table needs no rebuild, so it can go).
   Files: `agent/runtime/SessionEvents.ts`, `shared/session/sessionEvents.ts`,
   `controllers/session/sessionStore.ts`, `controllers/session/sessionInputs.ts`,
   `controllers/session/SessionView.ts`, `controllers/session/sessionOwners.ts`,
   `controllers/session/deletionCleanup.ts`, `controllers/session/runTrace.ts`,
   `shared/session/sessionLog.ts`, `shared/session/database.ts`,
   `agent/runtime/requests.ts`, the four `now()` callers,
   `src/test-kernel/support/crashConformance.ts` (commit points from results).
3. T4 and T7a/c in the same files: `mapDatabaseFailure` on `isSqlError`
   only, `job` without the gate branch, a typed stale-deletion error;
   `values.changes` on its own write counter; the two false comments.
4. Correct the catalogue rows B2, B3, B6 and R1 in
   `.agents/docs/evidence/2026-11-07-design-red-flags-lenses/catalogue.md`
   in the same PR.

Tests: no new tests (a refactor); the crash-conformance shards, the
session-store and session-events suites and the golden store must stay
green.

**PR 2: one record per run, one addressing scheme, the plugin's rule at the
plugin** (T3, T5, T6). About −120 lines net, one projector added, one row
kind retired.

1. T3: `FactKind.accepts` and `pluginRows` out of `Database.appendRow`;
   `externalInquiry`'s writer checks in its job; one batched existence read.
   Files: `controllers/session/Database.ts`, `tools/plugins.ts`,
   `packages/texra/src/shared/plugins/externalInquiry.ts`.
2. T5: a `run_record` projector (version 1) and `SessionLog.facts` over it;
   `recordFacts`/`runRowsFrom` reduced to the `input` read's lifecycle
   fields. Files: `controllers/session/projections.ts`,
   `controllers/session/rowReader.ts`, `controllers/session/sessionStore.ts`,
   `shared/session/runRowReads.ts`, `shared/session/runRowsShape.ts`,
   `shared/session/sessionViewUpdate.ts` (cold read),
   `shared/schemas/sessionEvent.ts` (`listingKeyOf`).
3. T6: requests as brought blobs; `context.blob` retired as `execution`;
   its readers read the blob by the digest `model.message` names. Files:
   `controllers/session/rowCodec.ts`, `shared/schemas/rowVersions.ts`,
   `shared/schemas/sessionEvent.ts`, `shared/session/runState.ts`,
   `agent/runtime/forkRun.ts`, `agent/runtime/run/requestContext.ts`;
   golden store regenerated once, on `main` per F14.

If the owner wants PR 2's format change inside E's batch instead, T6 moves
there and PR 2 is T3 and T5 only.

## Effect-native mapping

Checked against `node_modules/effect` 4.1.2.

| Finding | Primitive or structure                                                                                       | Declaration checked                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| T1      | `PubSub.unbounded` published after commit; `Stream.fromPubSub` per reader; the job's own return as `settled` | `effect/dist/PubSub.d.ts` (`unbounded`, `publish`, `subscribe`), `Stream.fromPubSub` |
| T2      | none: SQLite's one writer; catch-up as a loop in the open's `Layer.effect`                                   | `Layer.effect` (provides a `Scope`; there is no `Layer.scoped`)                      |
| T3      | the publisher job (one transaction) as the atomic read-then-append                                           | `SessionEvents.transact` (repo)                                                      |
| T4      | `Effect.catchIf(isSqlError, …)`; a `Schema.TaggedError` for a stale deletion                                 | `effect/sql/SqlError` (`isSqlError`), `Schema.TaggedError`                           |
| T5      | a projector row, rebuilt on version change                                                                   | `projections.ts` (repo)                                                              |
| T6      | the `blob` table and `event_blob` link                                                                       | `storeSchema.ts` (repo)                                                              |
| T7a     | `SubscriptionRef` per store moved by value writes only                                                       | `effect/dist/SubscriptionRef.d.ts`                                                   |

## Owners

| Finding                                | Owner                                                       |
| -------------------------------------- | ----------------------------------------------------------- |
| T1, T2, T4, T7a, T7c                   | E (store), PR 1                                             |
| T3                                     | E, with the app plugin's owner (C) for `externalInquiry.ts` |
| T5, T6                                 | E, PR 2 (T6 may move into E's format batch: owner's call)   |
| T7b                                    | owner's call (docs)                                         |
| Catalogue corrections (B2, B3, B6, R1) | E, in PR 1                                                  |

## Verified

- Every TeXRA path and line cited was read at `fcb53f7`; symbol counts were
  taken with `grep -rn` over `packages/harness/src` (`settled`: 16 sites in
  13 files; `log.now()`: 4; `log.tail` consumers: `requests.ts`,
  `followUpMessages.ts`, `runHandle.ts`, `sessionReads.ts`; `accepts:`
  implementers: 1).
- The B2/B3/B6/R1 status was checked against #14769's body (its R1 section
  lists the claim model, `PublisherJob`/`afterCommit` and the gate's busy
  retry as deleted) and the compromises note, which names none of the
  remaining symbols.
- pi-durable was read from a sparse clone at `a4ccccb`: `session/writer.ts`,
  `session/conversation-tails.ts`, `storage/sqlite/schema.ts`,
  `storage/sqlite/migrations.ts`, `README.md:869-905`, `CHANGELOG.md`
  `[Unreleased]` and 1.5.0. Line totals by `wc -l`. Claims about pi older
  than 1.5.0 come from the October evidence file at `31ade0e`.
- No branch `simplify/e-format-batch` and no open PR from E existed while
  this was written; `simplify/e-r3-e2` and `simplify/e-lens-batch` were
  diffed against their merge bases and touch none of the store modules.
- Not run: the test suite, any timing of the per-read projection check or
  the O(*n*²) fact append.
