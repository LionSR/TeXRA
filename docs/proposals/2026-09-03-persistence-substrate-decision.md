# The persistence substrate: one event table, one cutover (2026-09-03)

> **Status:** survey + decision proposal, revised the same day after reading
> OpenCode's V2 session core. Grounded on `main` at `1fbcaa0108`. Companion to
> `2026-09-03-startup-repair-is-the-wrong-shape.md`, which owns the lifecycle
> side (what boot may do, where terminal facts are written, ownership as a
> lock on open-for-write) and defers the storage engine as its S7. This
> document owns S7: what the store is, how the two competing PRDs resolve,
> and how the migration is run without a dual system. Peer codebases were
> read from source on 2026-09-03 (Claude Code readable snapshot; Codex and
> OpenCode cloned at HEAD). Every claim carries a `path:line`; re-open before
> acting.

## 0. Why this exists

Two facts sat side by side on 2026-09-03:

1. `texra chat` takes 48 to 112 s to show a prompt in a workspace with ~4,100
   execution directories (measured in the companion proposal §1). The
   companion diagnoses the pass that spends the time. This document is about
   why every such pass is expensive in the first place: existence is "a
   directory exists", listing is "open every meta", resumability is "parse a
   600 KB checkpoint", and every write is a whole-file rewrite.
2. The repo holds two merged PRDs that each claim to supersede the other on
   exactly this question, neither has a line of code behind it, and no open
   issue tracks the work (§3). Every persistence PR since 2026-08-17 has been
   lifecycle work on the unchanged substrate.

The peer tools that were in the same shape have moved: OpenCode cut over from
JSON-per-record files to one SQLite database in 2026-02 and is now building a
durable event log inside it; Codex kept append-only JSONL as the source of
truth and added a SQLite mirror for metadata and paging; Claude Code never had
a rewrite path to leave (§4). None of the three rewrites a growing document,
persists streaming deltas, or opens transcript bodies to list sessions. TeXRA
does all three.

## 1. The substrate today

Every persisted artifact goes through `KVStore` (`src/common/storage/KVStore.ts`):
`encodeURIComponent(key).json`, read is `JSON.parse` of the whole file (:61),
write is `StorageFS.writeAtomic` (:72) → `platform().fs.writeFileAtomic` →
`write-file-atomic`. The `appendFile` port exists (`src/platform/interfaces.ts:123`)
and serves generated response output (`ResponseCycleFlow.ts:334`) and CLI
input history (`inputHistory.ts:84`); desktop logging instead calls
`node:fs.appendFileSync` (`desktopAppLog.ts:131`). **There is no append
path and no event journal anywhere in the run/session persistence system.**
`SessionEventHub` (`src/agent/runtime/SessionEventHub.ts`, 177 LoC) is an
in-memory multicast; durability comes only from three projections of it.

| Artifact                                    | Layout                                                                              | Write shape                                                                                            | Owner                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Transcript `streamLogs/<id>.json`           | one JSON array of `StreamLogEntry` per stream                                       | whole array re-serialized every 300 ms while streaming (`StreamLogStore.ts:43,1229`)                   | `StreamLogStore.ts` (1,491 LoC) via `TexraTranscriptRecorder` (905)                                        |
| Summary `streamLogSummaries/<id>.json`      | derived listing row                                                                 | rewritten per batch and per meta change; mtime-vs-log staleness (`StreamSummaryCacheStore.ts:280-303`) | `StreamSummaryCacheStore.ts` (363)                                                                         |
| Sidecars `streamData/<id>/*.json`           | six files: meta, outputFiles, missingOutputs, compileFailures, usageStats, workPlan | each file rewritten whole per mutation (`StreamSnapshotStore.ts:914,942,1361,1633`)                    | `StreamSnapshotStore.ts` (2,119), `SidecarWriteCoordinator.ts` (191), `StagedDeletionCoordinator.ts` (665) |
| Execution KV `executions/<id>/*.json`       | meta, config, report, result-meta, turn-state, child-\*, todos, workspace-files     | `meta.json` read-modify-write per outcome/description (`executionLifecycle.ts:79-83,267`)              | `ExecutionKVStore.ts` (422), `executionListing.ts` (442)                                                   |
| Checkpoint `executions/<id>/flow_<id>.json` | envelope + full provider-native `shared.messages`                                   | whole record rewritten per node transition (`persistedFlow.ts:505-509`)                                | `persistedFlow.ts` (531)                                                                                   |
| Lease `executionLeases/<id>/<token>.json`   | v3 claim, written once with `O_EXCL`; v2 shadow still written                       | append-once (the only one); shadow retires 2026-11-24 (`executionLease.ts:538-541`)                    | `executionLease.ts` (848)                                                                                  |

Two structural facts follow from the table.

**Run content is stored twice, in two shapes.** The rendered log
(`StreamLogEntry[]`, what the UI shows) and the model-visible conversation
(`shared.messages` in the checkpoint, what resume needs) are written by
different owners from the same live events. Seven transcript-like
representations exist in total (trace `AgentEvent`; persisted entries;
summary; sidecar snapshot; `TranscriptRow` projection, `projectTranscriptRow.ts`
588 LoC; checkpoint conversation; reconstructed conversation in
`completedRunArchive.ts:326`), and the extension webview keeps both `entries`
and `rows` for the active stream (`store.ts:27-64`), a third in-process copy.

**Every question about history is a directory walk plus a full parse.**
`listExecutionStreamReferences` is a readdir plus one stat per execution plus
one meta read per checkpointed execution (`executionListing.ts:166`), and is
called up to four times per launch (the scan inside `runRestartRepair`,
`SessionHandle.ts:329`; the `readExecutionStreamIndex` fallback at :389;
`SessionStores.ts:783,872`). `deriveResumability` reads meta and the full
checkpoint to check a two-field cursor (`resumability.ts:60-119`). Startup per
seeded stream is one readdir plus up to eight sidecar and execution reads
(`StreamSnapshotStore.ts:850`, `streamSnapshotRead.ts:206`,
`StreamSnapshotStore.ts:1878`).

## 2. Footprint on one developer machine (2026-09-03)

| Bucket                    | Total  | `executions/` | `streamLogs/` | `streamData/` | dirs                      |
| ------------------------- | ------ | ------------- | ------------- | ------------- | ------------------------- |
| all 478 workspace buckets | 8.5 GB |               |               |               |                           |
| TNLean                    | 5.2 GB | 3.0 GB        | 2.1 GB        | 44 MB         | 4,148 exec, 3,789 streams |
| MIPStarRE                 | 1.5 GB |               |               |               | 1,277 exec                |
| coauthor                  | 1.1 GB |               |               |               | 1,196 exec                |

In TNLean, 3,125 executions still hold a `flow_<id>.json`; 17 of those exceed
2 MB. `streamData/` is small because it holds only the six sidecar files; the
transcript bodies are the 2.1 GB in `streamLogs/`. Raw read plus `JSON.parse`
of all 3,125 checkpoints is about 7 s (companion §1), which bounds what a
one-shot importer costs.

Generations coexist on disk because retirement has been per-feature, not
per-substrate: 151 buckets have `streamLogs` + `streamLogSummaries`, 138 have
`streamData`, 96 have `executionLeases` next to 92 with the retired
`executionLocks`, 5 hold `streamData.deleting` leftovers, and
`global-storage/` carries two orphaned `write-file-atomic` temp files from
July. None of this is corrupt; all of it is a cost the next reader pays, and
it is what per-store migration produces. This proposal does one migration.

Of the 4,610 stream sidecars measured on 2026-08-08, zero carried the current
`identity` shape (they predate #9705/#9755), so the whole history hydrates with
`identity === undefined`. That cohort is what the importer meets.

## 3. The decision record, and where it contradicts itself

| Date       | Document / ruling                                                        | Said about the substrate                                                                                                                                                                                                                         | Status                                                                                             |
| ---------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| 2026-02-22 | #2748 creates `StreamLogStore`                                           | per-stream JSON array, whole-file rewrite, from day one                                                                                                                                                                                          | live                                                                                               |
| 2026-06-06 | #5441 creates `StreamSnapshotStore`                                      | six sidecar files per stream                                                                                                                                                                                                                     | live                                                                                               |
| 2026-07-03 | `2026-07-03-session-scoped-runtime-architecture.md` A6 (:296-299,805)    | formats stay separate; ownership unifies                                                                                                                                                                                                         | shipped (#9234, #11334)                                                                            |
| 2026-08-11 | `docs/prds/2026-08-11-transcript-memory-architecture.md` (#9952)         | keep the substrate; fix residency, deltas, bounded startup; explicitly rejects sidecar collapse and an event-log rewrite of `PersistedFlow` (:414-439)                                                                                           | shipped in full (#9965-#10572)                                                                     |
| 2026-08-16 | `docs/prds/2026-08-16-sqlite-workspace-state.md`                         | one `node:sqlite` DB per workspace, transcript entries as rows, eight-stage migration; "supersedes the JSONL prescription in #10773" (:12); §8 "no Effect or any framework buy-in"                                                               | merged as a doc; **zero code**; Stage 0 spike never run                                            |
| 2026-08-17 | #10773 family closed (#10774, #10817, #10819, #10820, #10841, #10842-45) | JSONL journal work closed as "divergent from the settled single Stream-tab authority direction"                                                                                                                                                  | closed                                                                                             |
| 2026-08-18 | `docs/prds/2026-08-18-session-event-journal.md` (#10849)                 | append-only `streamJournals/<id>.jsonl` as SSOT, fold-derived sidecars; "the SQLite PRD stays parked" (:45-49)                                                                                                                                   | "draft for owner ratification"; all eight follow-ups (#10878-#10885) closed NOT_PLANNED; zero code |
| 2026-08-20 | maintainer comment on #10773                                             | "Prescription superseded by the now-merged storage PRD [SQLite] … transcript entries become rows"                                                                                                                                                | most recent ruling                                                                                 |
| 2026-08-23 | `2026-08-23-single-owner-sessions.md` §6 (:521-536)                      | a journal "helps partly"; the checkpoint cannot be a fold of an admission-redacted journal (thinking signatures, `previous_response_id`); the checkpoint, not the transcript, is the largest write amplifier (p50 547 KB per outer-node rewrite) | shipped (seven PRs) on the old substrate                                                           |
| 2026-09-02 | two round-2 surveys                                                      | treat the SQLite PRD as the superseding storage decision; withdraw in-place persistence bound as "a storage-engine concern"                                                                                                                      | recorded                                                                                           |

Contradictions nobody has closed:

- The journal PRD and the SQLite PRD each say the other is parked or
  superseded, and neither has recorded the 2026-08-20 ruling in its own
  status line. The journal PRD's own ratification protocol (:22-27) requires
  a rulings-ledger entry; none exists. §5 below shows the two are not
  alternatives, which is why the standoff never resolved.
- The memory PRD refuses collapsing the six sidecar files (cross-host data
  loss under version skew, :414-418); the SQLite PRD §1 lists the six-file
  seed chain as a defect to remove. Both are "current".
- The 2026-07-03 A6 ruling (formats stay separate) is contradicted by the
  SQLite PRD's single schema. Not reconciled in either doc.
- The SQLite PRD §8 forbids Effect; `effect@4.0.0-rc.112` is already a root
  and `packages/agent` dependency with one production user
  (`src/auth/oauth`) and an AGENTS.md section ("Effect Best Practices").
- The summary cache the journal PRD retires (§3.3) is doing more work than
  before: #11762 now mirrors cumulative usage into it.

No open issue tracks: the SQLite Stage 0 spike; the journal PRD's
disposition; the sidecar-collapse contradiction; the checkpoint amplifier; the
Effect ruling. The only open persistence issues are compatibility retirements
and two rulings requests (#11014, #11731, #11771, #10753).

## 4. What the peers do, from source

| Property                      | Claude Code                                                        | Codex (`codex-rs`)                                                 | OpenCode V1 (shipped)                         | OpenCode V2 (in tree, not yet the served path)                                                                                  | TeXRA                                                            |
| ----------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Content SSOT                  | per-session JSONL, append-only                                     | per-rollout JSONL, append-only, never rewritten                    | `message` and `part` rows in one SQLite DB    | `event` table keyed `(aggregate_id, seq)`; every other table is a projection                                                    | per-stream JSON array + separate checkpoint blob, both rewritten |
| What a record is              | model message with `parentUuid` chain + last-wins metadata entries | `RolloutLine{timestamp, ordinal, item}`                            | part rows with JSON `data`, whole-part upsert | versioned typed event with JSON `data`; 28 durable of 32 types                                                                  | rendered `StreamLogEntry` separate from model messages           |
| Streaming deltas persisted    | no                                                                 | no (`rollout/src/policy.rs:141-204`)                               | no (`PartDelta` not durable)                  | no (`text.delta`, `reasoning.delta`, `tool.input.delta`, `compaction.delta` live-only, `session-event.ts:448-511`)              | yes, via 300 ms whole-array rewrite                              |
| Mutation of past content      | append a tombstone/boundary                                        | append `ThreadRolledBack`; revert = new immutable file + pointer   | `INSERT … ON CONFLICT DO UPDATE` on one row   | projector `UPDATE` inside the event's own `BEGIN IMMEDIATE` (`packages/core/src/event.ts:237-352`)                              | rewrite the whole stream file                                    |
| Listing                       | readdir + stat, then 64 KB head/tail scrape, first 50              | FS head scan read-repairing a SQLite `threads` mirror              | one indexed SQL query                         | one indexed SQL query; `session_message.seq` = event seq (`session/sql.ts:133`)                                                 | readdir + one meta read per execution, 3 to 4 times per launch   |
| Resume                        | one file, byte-level skip of dead branches                         | reverse JSONL scan from EOF                                        | page by `(time_created, id)`                  | messages from the latest compaction; `session_context_epoch` holds the system baseline and its seq (`session/history.ts:24-53`) | parse the full checkpoint                                        |
| Ownership / replay            | pid file, skip not lock                                            | OS file lock per thread on open-for-write                          | in-process                                    | `event_sequence.owner_id` fence; replay dies on divergence or gap (`event.ts:254-302`)                                          | per-execution lease inspected for all runs at boot               |
| Boot work over history        | none                                                               | none after backfill flag = complete                                | schema migrations only                        | schema migrations only                                                                                                          | restart repair + two orphan sweeps, O(history)                   |
| Size of the persistence layer | one ~5k-line `sessionStorage.ts` plus helpers                      | ~50k LoC Rust across `rollout`, `history`, `state`, `thread-store` | ~6.7k LoC + 872 LoC migrations                | event core ~600 LoC + projector ~450 + reducer ~400                                                                             | ~11k LoC across the modules in §1 plus hosts' projections        |

Three lessons from the migrations themselves:

- **OpenCode V1** (#10597, 2026-02-14): hard cutover, one-shot importer at
  first start with a progress bar and 1,000-row batches,
  `onConflictDoNothing` idempotency, no dual-write. The importer was deleted
  3.5 months later (#30461). Two follow-up PRs (#14326 WAL concern, #16884
  "make migration truly one-time") show the cutover itself was rocky.
- **OpenCode V2** shows what the database is for once it exists. Publishing a
  durable event opens one `BEGIN IMMEDIATE` transaction, runs every
  registered projector for that type, then inserts the event row
  (`event.ts:237-352`); a projection can never drift from the log. The same
  reducer serves the SQLite projector and in-memory replay through a small
  adapter (`session/message-updater.ts:10-17`). Compaction is a durable
  `compaction.ended` event that projects one hidden message; the full
  transcript stays. V2 runs beside V1 as a separate HttpApi, the TUI still
  speaks V1, and two June migrations wiped the V2 tables outright, so it is a
  design in progress, not a shipped path. Its structure is nevertheless the
  one that reconciles TeXRA's two PRDs (§5).
- **Codex** kept JSONL as truth and paid for it with a mirror that must be
  read-repaired on every listing, a leased backfill with a completion flag,
  and a second projection database. That is the dual-system cost of not
  choosing one engine.

The deepest divergence is not the engine. Codex and Claude Code persist the
model-visible items and derive the UI at read time; OpenCode V2 persists
lifecycle events and projects both; TeXRA persists a rendered log and,
separately, the model messages. This proposal gives both a `seq` in one
engine (§6 Stage 3, Stage 5); the view-state fold then removes the duplicate
display copy (§9).

## 5. Verdict: the journal is a table, and the table is the only store

The whole-file-rewrite primitive is the root defect, exactly as #10773 and the
SQLite PRD diagnose. It makes the 300 ms transcript rewrite, the per-node
checkpoint rewrite, the six-file sidecar chain, the mtime summary heuristic,
the staged-deletion coordinator, and the O(history) boot passes all necessary.
Each of those is a semantics layer paying rent for a missing primitive; none
can be deleted while the primitive stays.

The two PRDs were never alternatives. The journal PRD is right about
semantics: an append-only, ordered, replayable record of what happened is the
correct source of truth, and everything the UI or the launcher reads should
be a fold of it. The SQLite PRD is right about the engine: one database per
workspace, indexed access, one transaction, cascade on delete. A JSONL file
cannot give the second; a database with mutable rows and no log cannot give
the first. OpenCode V2 shows the two together: the event table is the journal.

The first revision of this document then kept OpenCode's projection tables.
The owner asked why. The honest answer is that TeXRA does not need them:

- Hydrating a stream for display is one indexed read of its events plus the
  fold the transcript recorder already runs live. Same cost order as parsing
  today's JSON array, only for the stream being opened.
- Stream state (usage, work plan, outputs, compile failures) is already a fold
  over the same events in `StreamSnapshotStore.attachSessionEvents`.
- Listing facts (identity, description, outcome, parent edge, resumable) are
  each "the latest event of type T for this stream", an indexed lookup, not a
  scan.
- Resume is a fold too, once the model-visible message is itself a durable
  event (§6.1 D4). That is what Codex persists; it is the one choice that also
  ends TeXRA storing run content twice.

A persisted projection is a second copy with a lifecycle, a rebuild rule, and
a way to drift. A column holding `outcome` or `resumable` is remembered status,
which the owner's rule and the companion's D7 forbid. So:

**Recommendation.** Two tables per workspace database, `event` and
`event_sequence`, and nothing else persisted. Every surface, the launcher list
and the resume picker included, is an in-memory fold or an indexed query over
events. A derived row is added only after a measured query is too slow and an
index has been tried first. Record the journal PRD as absorbed, the SQLite PRD
as amended (§3.2 "entries as rows" becomes "events as rows, entries as a
fold"; §8 Effect non-goal reversed per §7), and ship it as one cutover (§8).

## 6. Target: two tables, folds everywhere

### 6.1 The contract (jointly owned with the view-state PRD)

This section is the only shared contract between the substrate program and
`docs/prds/2026-09-03-prd-one-fold-three-renderers.md`. The PRD references
it; it does not restate it. Changes land here first.

**C1. Persisted schema.** Two tables, nothing else app-owned on disk except the
two permanent settings files (`state.json`, `config.json`).

```
event
  commit        INTEGER PRIMARY KEY AUTOINCREMENT   -- database-wide total order, never reused
  aggregate_id  TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE
  seq           INTEGER NOT NULL                    -- per-aggregate, dense from 1
  type          TEXT NOT NULL                       -- versioned, e.g. "run.start.1"
  owner_id      TEXT NOT NULL                       -- hostname + pid + processStart (C5), derived at insert
  at            INTEGER NOT NULL                    -- wall clock ms, informational only
  data          TEXT NOT NULL                       -- Zod-validated JSON payload
  UNIQUE (aggregate_id, seq)
  INDEX (aggregate_id, type, seq)                   -- latest-of-type per stream
  INDEX (aggregate_id, commit)                      -- bounded cross-aggregate resume reads
  INDEX (type, commit)                              -- listing tier across streams

event_sequence
  aggregate_id  TEXT PRIMARY KEY                    -- kind-qualified AggregateId (C2)
  seq           INTEGER NOT NULL                    -- last assigned
  owner_id      TEXT                                -- current sequence writer, NULL when none
  parent_id     TEXT REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE
  closed        INTEGER NOT NULL DEFAULT 0          -- 1 after the aggregate's tombstone (C9)
  INDEX (parent_id)
```

Every connection enables and verifies `PRAGMA foreign_keys = ON` before any
transaction. Parents are inserted before dependents and an aggregate's
sequence row before its first event. The two foreign keys make deleting a
root sequence row delete its dependent sequence rows and all their events.
`parent_id` means owning aggregate (C9), and is NULL for independent roots.

The database and its WAL files reside on a local filesystem. The `Database`
layer rejects network or shared filesystem locations before opening SQLite:
WAL requires all database processes to share memory on the same machine
([SQLite WAL documentation](https://sqlite.org/wal.html)). Multiple local
host processes may open the bucket; consumers on another machine use the
existing runtime transport to the host that owns it. This proposal adds no
distributed database protocol.

`commit` is the session-wide ordinal the PRD needs for its cursor; SQLite's
`AUTOINCREMENT` gives it monotone and non-reusing for free. `seq` is the
per-stream ordinal the transcript fold and `settledSeq` use. Both exist on
every row; neither is derived from the other.

**C2. Aggregates.** An aggregate is a unit of independent lifecycle, and
**every fact lives on the aggregate of its logical target**, so a
latest-of-type lookup never has to disambiguate targets and no key column
exists. A database `AggregateId` is the canonical encoding
`aggregateId(kind, logicalId) = JSON.stringify([kind, logicalId])`, with kind
`stream`, `execution`, `workflow-checkpoint`, `inquiry`, `session`, or the
temporary `migration`.
This encoding is injective even when logical ids coincide or contain
punctuation. Raw logical ids never serve as database keys. The constructor
accepts a kind and an unencoded logical id; encoded keys are a distinct type
and are never encoded twice. External `streamId`, `executionId`, thread ids,
and their payload fields remain unchanged.

Every `aggregate_id`, `parent_id`, read or claim argument, per-aggregate fold
map, and transport subscription key uses this qualified `AggregateId`.
Logical parent or execution edges from an event payload are converted using
their declared kind before lookup. The importer performs the same conversion,
including for legacy ids; the roots are `aggregateId('session', 'singleton')`
and `aggregateId('migration', 'cutover')`,
so neither can collide with user-supplied stream ids.

Placement is by kind: a stream aggregate holds run-scoped trace `AgentEvent`s and
the stream's own lifecycle facts (`stream.removed`, `goal`, the queued-follow-ups
snapshot). Goals are keyed by stream, as in `GoalStore.getForStream` and
`GoalStore.list` (`src/tools/goal/goalStore.ts:176-215`); updating one stream's
goal cannot replace another's, and deleting the stream deletes its goal rows.
An execution aggregate holds what the model sees, the byte-exact flow rows
of `2026-09-04-agent-runtime-on-effect.md` §2.1 (`model.message`,
`model.compaction`, `tool.intent`, `tool.result`, `flow.snapshot`); which of
a run's two aggregates each flow row lives on is decided in that §2.1, which
places `flow.step` on the stream aggregate as a replay coordinate. These five
execution flow types are not the complete metadata schema: the named current
execution records and workflow/delegation facts in the §8 key mapping are
durable too, with their existing logical targets. The listing
tier reads the canonical `status` fact for outcome, including failures before
the runtime starts. An inquiry aggregate holds that thread's facts; one fixed session aggregate holds
**singleton** session facts only. A fact that can have more than
one live instance never goes on the session aggregate, because after two
deletions a latest-of-type read would see only the newer tombstone. The
execution-to-stream edge is on `run.start`. A stream is present to readers
iff its `event_sequence` row exists and `closed = 0`; a closed row may remain
physically until retention. `run.start` is `seq` 1 and creates the open row
in the same transaction. A child's declared parent edge pairs the logical
`parentStreamId` with `parentStartCommit`, the parent's `run.start` commit.
The commit distinguishes parent incarnations even if a logical id is reused
after physical retention. C9 defines the effective parent used for routing.

A workflow journal lives on
`aggregateId('workflow-checkpoint', checkpointId)`, independently of any
launch's stream or execution id. Every workflow `run.start` records that
same logical `checkpointId` as its resume anchor (view-state PRD decision 9).
Fresh launches and resumes of that checkpoint therefore share one journal
and one claim, even when both launch ids are fresh. Journal reads and writes
use this aggregate; individual launch trace and result rows retain their
stream and execution targets.

During the import window, one reserved migration aggregate holds the
workspace migration claim and its progress facts (§8). It is excluded from
session reads and retired with the importer; it is not a third table.

**C3. Durable event set.** Durable: every run-scoped `AgentEvent` except text,
thinking, and tool-input deltas; `approval.requested`,
`approval.resolved`, `approval.policy` (snapshot); `run.start` at the
reservation commit point carrying `identity` (nullish only for imported legacy
streams), `worktree` (nullish), and explicit `category` and `isRemote` fields,
because `RunIdentity` deliberately does not encode `AgentCategory`, a process
or workflow-script stream has no agent to derive from, and remoteness is a
registry lookup the fold must never perform; the flow rows in C2 (D4); the
current execution metadata records in §8; the session facts in C2. Live-only,
never persisted: deltas, focus and selection,
anything the PRD's `Surface` owns. `setActiveStream` no longer exists.

Redaction has three owners and they are not interchangeable.

- **Trace rows on the stream aggregate, error payloads, and approval payloads
  are secret-scrubbed at the publish boundary, before the row is written**,
  the way `TexraTranscriptRecorder` scrubs them today (`redactSecrets`,
  `src/logger/redaction.ts:5-14`). A secret in one of those rows would be on
  disk until deletion and in every export.
- **D4 rows on the execution aggregate are byte-exact and never scrubbed.**
  Anthropic thinking blocks must go back to the provider byte-identical or
  signature verification fails on replay (`src/agent/modelHandlers/anthropic/modelHandlerAnthropic.ts:1372`),
  and a tool input or result the model already reasoned over must not diverge
  on resume. Today's checkpoint is unredacted for the same reason (single-owner
  §6); exposure is unchanged. C9 preserves saved history until explicit
  deletion. These rows are not nulled on COMPLETED:
  D8 keeps completed runs resumable, and after the fold collapse they are the
  only copy of the conversation.
- **The shared display fold applies redaction before storing any view
  state**, including `SessionViewService.ref`, which the CLI reads directly
  in process. Raw execution rows are accessible only through `RunLedger`;
  its display projection scrubs them before either an in-process consumer
  or a transport receives them. Every export applies the same redaction.
  Configuration, reports, and other execution metadata can also contain
  user or provider content; their typed accessors preserve the stored value,
  but every display/export projection applies this same redaction boundary.
  Transport framers forward display values, never raw execution payloads.
  **Display truncation and bounding are also the fold's**.

One residue to name plainly. Until the view-state PRD collapses the fold
(events straight to `TranscriptRow`), message text is durable twice: in the
redacted trace `message` rows on the stream aggregate that the transcript fold
consumes, and in `model.message`. That is today's duplication moved into one
table with one lifecycle; the collapse deletes the trace copy and the display
fold then reads `model.message` with redaction applied at fold time. The
collapse is a named step, not an open end.

**C4. Text durability.** There are no partial-text checkpoints. The completed
message event is the only writer of message text; streaming text lives in
memory until then. Kill -9 loses the in-flight message, which is what all four
peers accept and what the SQLite PRD's acceptance already allowed. This
rejects the PRD's `stream.text` offset checkpoints: they are a second writer
for one datum with a render-time `max()` to reconcile.

**C5. Owner id.** `owner_id` preserves the full `LeaseOwnerSchema` identity:
hostname, pid, and the nullable process-start identity
(`src/agent/storage/leaseOwnerLiveness.ts:17-23`). Its canonical string is
`JSON.stringify([hostname.toLowerCase(), pid, processStart])`; hostname
comparison is case-insensitive, and a missing process-start identity stays
null. The `Database` layer derives it; callers cannot supply an arbitrary writer id.
It is stamped on `event_sequence` (who may append) and on every event row
(who did). Only the sequence row is current ownership: an immutable event's
writer is historical attribution and never establishes a present claim.
The liveness check first compares the recorded hostname with the local one.
A different host is **unprovable**, without probing or signalling its pid
locally: a missing local pid says nothing about a recorded owner from another
machine. Such identities can occur in copied or imported state; they do not
authorize opening a shared-filesystem database. On the same host, `kill(pid, 0)` returning ESRCH or a
readable, different process-start identity proves death. An existing pid with
an unreadable or null start identity, or any otherwise inconclusive probe,
is unprovable. These are the existing `proveOwnerLiveness` rules
(`leaseOwnerLiveness.ts:55-107`), applied per distinct owner, never per run.
Foreign-host and unprovable claims block automatic takeover, import, and
cleanup; neither age nor a local signal is a substitute for that proof.

Opening existing aggregates for write acquires them together under
`BEGIN IMMEDIATE`: compare each stored owner with the owner whose liveness
was probed, reject any changed, live, or unprovable foreign owner, and set
the caller's owner only if all targets are unowned or their owners are proved
dead. This is one atomic claim or takeover, not an unconditional upsert.
New aggregates are claimed in their first-event transaction (C2).
The process also admits only one local run holding a claim for an aggregate.
An execution acquires and releases its stream and execution claims together;
the current stream claim therefore supplies its displayed ownership, while
an action rechecks both targets before writing.
For a workflow, admission acquires its checkpoint claim in the same atomic
transaction as its stream and execution claims, before reading the journal
for execution or performing any mutation. This applies to fresh launch,
retry, and resume alike. A competing launch for the same `checkpointId`
cannot proceed merely because its run ids differ; the local admission guard
also covers this checkpoint key. Every journal append checks that claim.
Completion or suspension releases all three runtime claims together without
deleting the checkpoint. This replaces the checkpoint launch file lease.
Release clears only the caller's own claim. Every append verifies both the
claim and `closed = 0` inside its transaction; a serialized non-owner write
still fails. The legacy import additionally preserves the old claims until
their owners are proved inactive or explicitly cleared under §8.

The existing explicit single-run deletion policy remains: a user-authorized
delete may replace an unprovable claim, but never a known-live claim
(`executionListing.ts`, `deleteExecution`). It still compares the observed
claim inside the transaction before taking ownership and closing the run.
This exception does not authorize resume, bulk deletion, or automatic
cleanup, and never signals a remote pid. Interrupted migration has the
separate, explicitly authorized recovery condition in §8.

Claim, takeover, and release all wake local readers after commit, even when
they append no event and the commit ordinal is unchanged; foreign readers
observe the sequence-row change through `data_version`. C7 reads current
claims per aggregate and carries explicit nulls for released claims to every
fold. A still-live process can therefore release a waiting execution without
leaving that execution classified as owned merely because it wrote the last
event. Liveness answers whether the current claimant is alive, not whether
any historical writer is alive.

**C6. Write path.** `SessionEvents.publishBatch(events)` appends an ordered
batch of durable events, possibly on several aggregates. Under the local
database semaphore and one `BEGIN IMMEDIATE`, it validates and redacts the
whole batch, verifies the C5 claim and open state of every target, assigns
each target's `seq` and the database-wide `commit` values in batch order,
inserts every row, updates the sequence rows, and commits. Failure of any
member rolls back all members and sequence changes. `RunLedger` folds the
complete returned batch before exposing its resulting state. `publish(event)` delegates its durable
case to this operation with one element. Model configuration plus its
snapshot and follow-up messages plus the remaining queue use this same
transaction. Each call's `tool.result`, including its causal state delta,
commits with the matching display `tool.end`; one settlement owner builds
this batch, and the tool executor never publishes that terminal display row
independently. Once every call from a provider response has settled, its
provider-native `model.message` follow-ups and `flow.step results.ready`
also commit together (§2 of the runtime proposal).

After commit the publisher advances a process-local wake level. It never
delivers durable payloads directly: every subscriber reads them from the
ordered table tail in C7. Live-only deltas use the existing ephemeral
channel and never advance a durable cursor; they are not batch members.
The write remains in the publish path, never in a subscriber, and no
publisher waits for a remote renderer.

**C7. Read path.** Five read queries, bounded reads, and one wake level:

- `all(fromCommit, throughCommit?)`: events with `commit > fromCommit` in
  commit order. The optional inclusive upper bound makes one finite read;
  without it, this supplies the table tail and the frozen NDJSON projection,
  which needs every row including transcript rows of unsubscribed streams.
- `listing()`: the cold listing hydrate of C8, one indexed query: the
  latest-of-type row per aggregate over `(aggregate_id, type, seq)` for the
  listing fact types, plus the outstanding-approval set, **returned in
  `commit` order**. SQL row order is otherwise undefined, and a deleted
  stream's listing rows are its `run.start` and its `stream.removed`; folded
  in the wrong order the tombstone would land first and the later
  `run.start` would recreate the stream. It never returns transcript rows.
  Explicit rather than an overload of `all(0)`.
- `aggregate(aggregateId, fromSeq)`: one aggregate's events from `seq`. The
  transcript tier and cold hydration. A transcript subscriber names
  aggregates, not streams: the stream aggregate plus its execution aggregate
  (via the `run.start` edge), each with its own `fromSeq`.
- `aggregatesAfterCommit(aggregateIds, afterCommit)`: rows of only the named
  aggregates with `commit > afterCommit`, returned in commit order through
  `(aggregate_id, commit)`. Resume supplies the stream and execution ids and
  the latest snapshot's commit. Execution `seq` is never reused as a stream
  cursor, and a dormant run never scans unrelated session history. The
  message-base read in runtime §2.3 uses the same execution index with an
  inclusive base and an upper bound at the snapshot commit.
- `aggregateState(aggregateIds)`: the sequence rows for the named qualified
  keys, using the primary key, returned as `{ aggregateId, ownerId, closed,
parentId, startCommit }`. For streams, `startCommit` is obtained from the
  indexed `seq = 1` row; it is null for other kinds. Missing keys have no row;
  a present row with `ownerId: null`
  is explicitly unclaimed. The finite input read below reads this state and
  the bounded event prefix in one transaction. Only the listed or opened
  aggregates are checked; no transcript bodies are read.
- `PRAGMA data_version`: changes when another connection commits. It is
  connection-local and does not move for the connection's own commits, so it
  is a wake trigger only, never a level in the `commit` number space.
  One poll per database advances the same replaying process-local wake level
  that local commits advance. Each subscriber drains its table queries, then
  waits for a wake level above the one observed before that drain. Wakes
  carry no rows and are never interpreted as commit values.

The existing `SessionInputs.read(aggregates, cursor)` reader composes these
queries into ordered finite input batches, as in the view-state PRD §7.2.
It adds no persisted event or second tail interface. Each live read captures
its text/local levels and per-subscription resident scope first, then opens
one read transaction. Within that transaction it captures the log's committed
`AUTOINCREMENT` high-water mark and reads `all(cursor, bound)`. It extends the
checked scope with every identity and typed edge introduced by that read's
listing/lifecycle/inquiry rows, then reads `aggregateState(expandedScope)`
before closing the transaction. The typed edges include a workflow's
`checkpointId` under its `workflow-checkpoint` kind. Newly delivered streams
and their execution, checkpoint, or inquiry aggregates receive current claims in the same batch,
without waiting for another event. The bound is the SQLite-maintained committed ordinal,
not `MAX(event.commit)`, which can fall when retention removes rows.

The batch keeps events before text/local inputs and ends with the existing
transient `Drained` marker, extended by one field:

```ts
type ExistenceReconciliation = {
  checkedAggregateIds: readonly AggregateId[];
  removedAggregateIds: readonly AggregateId[];
  claims: readonly { aggregateId: AggregateId; ownerId: OwnerId | null }[];
};
type Drained = {
  _tag: 'drained';
  cursor: SessionCursor;
  existence: ExistenceReconciliation;
};
```

`removedAggregateIds` is exactly the expanded checked set minus the keys
returned by `aggregateState` in that transaction. `claims` has one entry for
every surviving checked key, including null for every released claim. The
fold receives the complete ordered batch, then replaces those keys' current
claims and applies the marker's removals and captured bound before
publishing its view. Removal uses the same rule as a tombstone, including
re-rooting surviving child streams, and is authoritative only for the
checked ids. Removing a resident invents no ordinal. `Drained.cursor` is
always the captured bound: it may equal the prior cursor or exceed it even
when retention has removed every event in that interval.

Current claims and owner-process liveness are separate transient inputs.
The captured local liveness snapshot cannot overwrite the later sequence-row
claim snapshot. A current owner absent from that liveness snapshot is
unprovable and blocks automatic takeover until a probe supplies an explicit
verdict. Distinct returned owner ids are probed; verdict changes wake another
finite read. A null current claim needs no process probe. Cold replay also
reads and supplies this reconciliation through the existing `ReplayComplete`
marker before publishing its completed view. That marker applies current
claims and removals while retaining the pre-replay tail anchor; it never
adopts a later replay-read ordinal or falls back to the latest event writer.

The same batch reaches every renderer. The view-state PRD §8.1 adds
`existence: ExistenceReconciliation | null` to `EventsFrame`. When a finite
live read spans frames, only its final frame carries the reconciliation; the
decoder buffers the read, builds `Drained` from that frame's existing
`cursor` and `existence`, and releases the ordered `SessionInputs` batch.
The final `replayComplete` frame also carries `existence`; its decoder uses
`ReplayComplete` to apply that reconciliation without moving the saved tail
anchor.
Earlier split frames cannot advance the retained view cursor, so reconnecting
cannot skip their still-unapplied rows. A read with no new materialized
events still sends the marker, including for claim-only changes when its
cursor is unchanged. The
receiver accepts it by frame order and the current `Subscribe` generation,
not by requiring a larger cursor; obsolete generations are discarded before
any inputs fold.

Each subscription retains its own checked scope: ids introduced by its
listing or delivered tail lifecycle/inquiry rows, including their stream,
execution, workflow-checkpoint, and inquiry edges, plus its named transcript aggregates, until
their removal is delivered or a new generation replaces the scope. It must
not borrow the database-owning fold's resident set, which may have already
forgotten a run the renderer still displays. Thus retention remains visible
even when its tombstone is inserted and collected between polls.

Cold hydration captures a commit anchor before its listing and aggregate
reads, completes replay, then uses the finite input reader from that anchor.
The fold handles overlap by latest-of-type listing facts and by each
aggregate's settled `seq`, as in the view-state PRD §7.2. Local and foreign
wakes both trigger the bounded event/aggregate-state read, including when there
are no new materialized events. A surface's cursor advances only to the
completed read's captured commit bound; an aggregate's settled boundary is
a `seq` value. The reserved migration aggregate is excluded from these
session queries.

**C8. Two-tier residency.** Listing facts are latest-of-type lookups over the
`(aggregate_id, type, seq)` index, or a `GROUP BY` over `(type, commit)` for
the whole session; they never fold transcripts. One listing fact is a set,
not a latest: outstanding approvals are every `approval.requested` on the
aggregate without a matching `approval.resolved`, keyed by request id, over
the same index, because a stream with two outstanding requests would lose the
older one the moment the newer resolves. Transcript rows fold only for
aggregates a surface has subscribed to via `aggregate(id, fromSeq)`, and the
fold drops that tier when the last subscriber leaves. This is the rule that
keeps #9952 from returning.

**C9. Existence, deletion, retention.** `run.start` creates a run. Every aggregate
records its current **owning lifecycle**, and only that, as a qualified key
in `event_sequence.parent_id`: an execution's parent is its stream (from
the `run.start` edge); an inquiry's parent is its most recent asker. An
inquiry reopened after an answer changes parents, as
`recordOpenQuestion` does today (`src/tools/inquiry/externalInquiryStorage.ts:250-323`).
Its reopen transaction acquires the inquiry claim under C5 and uses the
caller's current new-parent claim. It verifies both rows are open and
caller-owned, verifies the latest inquiry state is answered,
then appends the reopened inquiry fact with the new logical parent fields
and updates `parent_id` to the new stream key. Both changes commit or neither
does. A concurrent old-parent deletion either closes the inquiry first,
causing reopen to fail, or follows the reparent and no longer reaches it.
Inquiry writes release their inquiry claim once complete; reopening does
not require the last answering process to exit. An already-open or dropped
inquiry cannot be reopened.

A child stream's `parent_id` is NULL: its independent lifecycle survives
parent deletion. Its immutable `run.start` records only the declared
`parentStreamId`/`parentStartCommit` pair. Before admission, resume, each new
turn after WAITING, and parent-directed approval or follow-up routing, the
runtime resolves `aggregateId('stream', parentStreamId)` through
`aggregateState`. The parent is effective only if the row is present, open,
and has the matching `startCommit`; otherwise the child is detached. Stale
snapshots cannot override that check, and display residency is not evidence
of parent existence. Local deletion and remote reconciliation also apply the
existing detach operation to active handles and approval ancestry. A still
present, open parent remains the parent even if its owner has released it
or died. The runtime proposal §2.4 owns this reconstruction rule; no new
detach event is needed.

A workflow-checkpoint aggregate is also an independent root with
`parent_id = NULL`, created with its first journal fact. Deleting one launch
does not close or cascade its checkpoint: another saved history or a later
launch may still need that journal. Releasing runtime claims leaves the
checkpoint open and available for resume, without an age limit. Explicit
deletion of the last referring run may also collect the checkpoint: acquire
its unowned or reclaimable claim under C5 and, in the final deletion
transaction, verify that no retained run's `run.start.checkpointId` still
references it before closing and removing its journal. Otherwise retain the
checkpoint. A concurrent launch must acquire that same claim before
recording its reference, so it cannot race the reference check and deletion.
This uses the existing run-deletion operation, with no new deletion surface.

`stream.removed` is the last row on the stream's own
aggregate and, in the same transaction, sets `event_sequence.closed = 1` on
that aggregate **and on every dependent reachable through `parent_id`**, one
recursive `UPDATE`, so nothing the removed run owns stays writable and
retention can never orphan a dependent.
The publisher checks its ownership and the target aggregate's own `closed`
flag in the write transaction it already holds, so an append for a removed
aggregate is refused in O(1).

Saved histories have no age limit. Stamped, supported, or resumable runs,
including completed, cancelled, failed, crashed, and independently imported
histories, remain until explicit user deletion. A terminal status alone never
makes a run disposable. This preserves S6 of
`2026-09-03-startup-repair-is-the-wrong-shape.md`. Automatic expiry is limited
to an explicitly declared ephemeral, nonresumable orphan cohort or an
already-deleted tombstone; an unknown classification is not eligible. Any
cleanup grace applies only to those cohorts (owner decision 6).

Deletion first acquires the root and dependent claims under C5 and commits
the tombstone and recursive closure in one transaction. Known-live active run owners
always block admission to deletion; unprovable owners additionally block bulk and
automatic cleanup, with only the explicit single-run exception in C5.
The tombstone records the owned execution directories to remove. A small
worker retries those deletion records, not a scan for directories absent
from the database. It removes the entire generated-artifact directory for
each deleted execution, matching today's `deleteExecution`/`clear` contract;
copied or accepted workspace outputs outside that directory are untouched.
Deletion paths are confined to the recorded execution directories and never
follow links outside them.

Closed sequence rows, dependent events, and the tombstone remain until that
filesystem cleanup succeeds. The worker holds the existing C5 claim on the
closed root while cleaning and verifies the same tombstone before finalizing;
ordinary appends remain forbidden. A successor may take over a dead worker's
claim and retry: an already-absent directory counts as success, while a file
error leaves the deletion record for another attempt. Only then does one
transaction delete the root sequence row and cascade through its closed
dependents and events by C1. No additional table or completion event is
needed. This also handles a crash after file deletion but before the cascade.
Publication of the wake follows closure and final collection. C7's indexed
aggregate-state read removes collected streams from resident views even when
their tombstones were never observed.

**C10. Nothing derived is persisted, with one named exception.** No summary
table, no projection table, no status column, no `run_state` summary on an
executions row. The exception is the fold snapshot stored as an event:
`flow.snapshot` on the execution aggregate, initially written before any
external activity, then at turn or round end, before WAITING, and whenever
bytes appended since the last snapshot exceed its size (the runtime proposal's
byte-amortized rule). It contains the non-message family state, durable phase,
pending intents, references to any pending tool response and its settled
calls, and a `messageBaseCommit` reference to the canonical conversation.
The pending references remain available even when their rows precede the
snapshot; restoring them supplies delivery inputs without applying their
state mutations a second time. The snapshot never copies the message array.
It is a base point for the resume fold in the same table and lifecycle, and is never queried for listing
status. Some non-message state is recorded at these boundaries rather than
reconstructed from earlier messages. If any other query
is measured too slow, add an index; if an index does not fix it, and only
then, a derived row with a rebuild rule, recorded here as a contract change.

**D4 (owner-ratification marker; the names are owned by the runtime doc).**
The model-visible conversation and the resume state are durable rows using
the vocabulary of `2026-09-04-agent-runtime-on-effect.md` §2.1, which owns
those names and decides each row's aggregate:
`model.message` has two payloads: `pending-tools` records a completed
tool-bearing response and its exact normalized builder inputs, including
reasoning signatures, without adding it to provider history; `append`
installs provider-native messages, with `sourceResponseCommit` identifying
the single completed follow-up batch for a pending response. `tool.result`
records per-call settlement and state changes, not a provider message.
`model.compaction` carries the full replacement array when a handler
rewrites history; `tool.intent` records barrier dispatch; `flow.step` the round and turn
boundaries; `flow.snapshot` the family's non-message Zod state under C10.
Resume reconstructs the active conversation from append payloads and
compactions between its message base and the snapshot, restores any pending
response/settlement references, then folds the stream and execution rows after the snapshot's
commit using `aggregatesAfterCommit`. The state tail is bounded by a turn or
round and the byte-amortized snapshot rule; reading the active conversation
still costs its own size. This replaces the separately rewritten checkpoint
conversation. It is the one item in this contract
the owner has not yet ratified.

### 6.2 Stages

Stages are lanes on one branch and ship in one release (§8).

| Stage | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Deletes in the same release                                                                                                                                                              | Companion step |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 0     | Spike: `node:sqlite` on the CLI floor (raise `engines.node` to `>=22.13.0`, `packages/cli/package.json:37`), Electron 44 (`packages/desktop/package.json:33`), VS Code 1.125 extension host; WAL with two local host processes on one local bucket; reject network/shared storage before open; kill -9 mid-transaction; `PRAGMA data_version` across processes. OpenCode's `packages/effect-sqlite-node` (MIT, ~200 LoC) is the starting client                                                    | nothing                                                                                                                                                                                  |                |
| 1     | C1 schema and indexes; Effect `Database` layer parameterized by `WorkspaceRoots`; the C6 publisher behind `SessionEventHub`; the architecture test that fails any persistence write outside the database or the documents/export allowlist, and its sibling that fails a raw read of the execution row types outside `RunLedger` (or, better, a `Database` layer that only exposes those rows through `RunLedger`, so the query is unconstructible elsewhere and the test is unnecessary)          | nothing                                                                                                                                                                                  |                |
| 2     | Listing tier: launcher history, resume picker, sessions rail, and the executions tool answered by C7/C8 indexed queries                                                                                                                                                                                                                                                                                                                                                                            | `streamLogSummaries/`, the mtime heuristic, `executionListing.ts` directory walks, `readExecutionStreamIndex`, `listExecutions` scans, the PR2 background hydration pass                 | S4, S5         |
| 3     | C3 durable event set; transcript fold on hydrate reusing the recorder's live fold; `StreamLog` in-memory contract and `store-public-surface-baseline.json` unchanged                                                                                                                                                                                                                                                                                                                               | the 300 ms whole-array rewrite, `writeStream`/`hydrateStream`/`parsePersistedEntries`, `preservedRawEntries`, `seqNo` renumbering, the 50 KiB truncation and `toolOutput/` spill         |                |
| 4     | Stream-state fold on hydrate (usage per round, work plan, outputs, missing outputs, compile failures) from the same events `attachSessionEvents` folds live today                                                                                                                                                                                                                                                                                                                                  | six sidecar files, `SidecarWriteCoordinator`, `StagedDeletionCoordinator`, `streamData.deleting`, `streamSnapshotRead.ts`, `streamDataPaths.ts`, `DiskState`, `probeRunPhase`/`runFacts` |                |
| 5     | D4, delivered by `2026-09-04-agent-runtime-on-effect.md` as lane D: the flow rows of C2, `RunLedger`, `foldRunState`; resume as a fold; `deriveResumability` becomes "a `flow.snapshot` exists and no live owner holds the lease, outcome-independent per single-owner D8"; the importer converts each supported checkpoint's messages, non-message state, and cursor into canonical rows (§8); both flow families and the workflow-script journal convert in one PR, no interim checkpoint column | per-node whole-record rewrite in `persistedFlow.ts:505-509`, `resumability.ts` full parse, `flow_<id>.json`, `src/agent/node/`, `completedRunArchive`'s conversation reconstruction      | S7             |
| 6     | C5 and C9: atomic claim/takeover and per-append ownership checks, `stream.removed` tombstones, preservation-aware deletion, retryable generated-file cleanup, and final cascade                                                                                                                                                                                                                                                                                                                    | normal file-lease writes and scans, directory-wide app-state orphan sweeps, `executionLocks` remnants, `child-*.json` edge files; import-only lease validation remains until Stage 7     | S3, S6         |
| 7     | Retire the importer, its schemas and lease reader, migration facts, backup handling, and fixture tests in the first release at least three calendar months after the cutover ships (§8)                                                                                                                                                                                                                                                                                                            | the importer                                                                                                                                                                             |                |

Rules restated because they are the parts migrations get wrong:

- **Never persist a delta** (C4).
- **Nothing derived is persisted** (C10). Folds are rebuilt from events on
  every hydrate; there is no rebuild step because there is nothing to rebuild.
- **Boot does no history work.** After Stage 2 every list is a query; the
  companion's S1 removes repair and sweeps from `waitUntilReady` and Stage 2
  removes their reason to exist.
- **The frozen surfaces stay frozen** for the cutover. `StreamLogStore` and
  `StreamSnapshotStore` keep their public Promise-based surfaces and the
  `StreamLog` delta contract; the engine changes behind them. Collapsing the
  two-step fold (events to entries to rows) into one is the view-state PRD's
  step after the merge.

### 6.3 Elimination ledger

The owner's standing rule is cut before add. Sizes are `wc -l` at
`1fbcaa0108`; post-cutover sizes are estimates, deletions are not.

**Gone (concept and code both disappear):**

| Element                                                                                                           | Today        | Why it no longer needs to exist                                                                                |
| ----------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------- |
| `StreamSummaryCacheStore` + `streamLogSummaries/` + mtime staleness                                               | 363          | listing is an indexed query (C7, C8)                                                                           |
| `StagedDeletionCoordinator` + `streamData.deleting/`                                                              | 665          | app-state closure is one transaction; C9 retains a small tombstone-driven artifact cleanup worker              |
| `SidecarWriteCoordinator`                                                                                         | 191          | the per-file mutex is what a transaction is                                                                    |
| `streamSnapshotRead.ts`, `streamDataPaths.ts`, the six sidecar files, `DiskState`                                 | 353+         | stream state is a fold on hydrate (Stage 4)                                                                    |
| `executionListing.ts` directory walks, `readExecutionStreamIndex`, PR2's background hydration                     | 442+         | one query                                                                                                      |
| `restartRepair.ts`, `runClassification.ts` (companion S1 to S3)                                                   | 451          | boot does no history work; phase is a fold                                                                     |
| `resumability.ts` full-checkpoint parse                                                                           | 120          | a `flow.snapshot` exists and no live owner holds the lease, outcome-independent per single-owner D8 (D4)       |
| `SessionStores.ts` directory-wide app-state orphan sweeps                                                         | ~500 of 1019 | database dependents cascade; generated-file cleanup follows retained deletion records (C9)                     |
| File leases: `executionLeases/`, v3 claims, v2 shadow, `readClaims`                                               | ~600 of 848  | C5 claims replace normal file leases; import-only validation of retained legacy claims retires in Stage 7      |
| `child-<id>.json` edge files (6,664 in TNLean) + `childRunPersistence.ts`                                         | 19 + 48      | the parent edge is on `run.start`                                                                              |
| 50 KiB entry truncation + `toolOutput/<entryId>.txt` spill (`runTrace.ts:68-98`, `spillArtifacts.ts`)             | ~110         | a row holds the payload                                                                                        |
| Whole-record checkpoint rewrite, `flow_<id>.json`                                                                 | ~300 of 531  | `model.message` rows + byte-amortized `flow.snapshot` (D4)                                                     |
| `completedRunArchive.streamLogEntriesToConversation`                                                              | ~100 of 343  | the conversation is `model.message`; read it                                                                   |
| `ExecutionMeta` `schemaVersion` prefault arms, `meta.json` read-modify-write, `executionLifecycle` outcome writes | ~400         | outcome is the canonical `status` event                                                                        |
| The 0.40.x continuation UUID compatibility writer (#11731)                                                        | small        | same-version hosts                                                                                             |
| Five parent-edge copies per stream (stream-lifetime survey §2.D)                                                  | scattered    | one field on `run.start`                                                                                       |
| Run content stored twice; seven transcript-like representations                                                   | n/a          | one durable set; folds: entries, `TranscriptRow`, stream state, resume conversation; `TraceDocument` as export |

**Folded (the concept survives in a smaller form):**

| Element                                            | Today | After (estimate) | Becomes                                                                                       |
| -------------------------------------------------- | ----- | ---------------- | --------------------------------------------------------------------------------------------- |
| `StreamSnapshotStore`                              | 2,119 | ~300             | the stream-state fold plus its in-memory `StreamRecord`; all file I/O, seeding, provenance go |
| `StreamLogStore`                                   | 1,491 | ~500             | residency leases and delta emission (frozen UI contract); every persistence path goes         |
| `TexraTranscriptRecorder`                          | 905   | ~450             | the one entries fold, run live and on hydrate                                                 |
| `ExecutionKVStore` + `executionLifecycle`          | 761   | ~100             | typed accessors over C7 queries                                                               |
| `executionLease.ts` + `leaseOwnerLiveness`         | 946   | ~120             | owner-id derivation and one liveness probe                                                    |
| `SessionResumeRetrieval` + CLI `toolUseResumeData` | 293   | ~80              | indexed message-base and cross-aggregate tail reads, then the resume fold                     |
| `KVStore` + `StorageFS`                            | 113   | 113              | kept for `state.json` and `config.json` only                                                  |

**Kept, deliberately:** `StreamLog` and `StreamLogDelta` (594, the UI contract
during the cutover), `TranscriptRow` and the host folds (UI), `TraceDocument`
and the trace-viewer schema (export format), `conversationFormat.ts` (display
formatting), the Zod schemas for every payload stored as `data`.

Net: roughly 12.5k lines in scope; roughly 1.7k survive folded, plus about
1.5k new (schema, `Database` layer, publisher, importer). The reduction is
near 9k lines and, more to the point, seven mechanisms (summary cache, staged
deletion, sidecar mutex, directory scans, repair, spill, projection rebuild)
that existed only to compensate for the missing primitive.

## 7. Effect at the substrate and the fold

The owner wants Effect. The repo already has it: `effect@4.0.0-rc.112` in the
root and `packages/agent`, the `@effect/language-service` plugin, and an
AGENTS.md section, with one production module (`src/auth/oauth`). OpenCode is
on the same major (`4.0.0-beta.83`) and shows a shape worth copying exactly:

- **Effect owns services, storage, and the event core; renderers never see
  it.** OpenCode's core is 233 of 316 files in Effect; its TUI is 6 of 152,
  desktop 2 of 110, web app 5 of 364. One `ManagedRuntime` over the layer
  graph is the boundary (`packages/opencode/src/effect/app-runtime.ts:57-134`).
- **The storage layer is where it pays.** `db.transaction(fn, { behavior:
"immediate" })` with savepoints for nesting and the connection carried in
  fiber context (`effect-drizzle-sqlite/src/effect-sqlite/session.ts:118-200`);
  services as `Context.Service` classes with `Layer.effect`; errors as
  `Schema.TaggedErrorClass`; named spans via `Effect.fn`. This is exactly the
  code that the cutover would otherwise hand-roll as promise plumbing and
  `p-queue` mutexes.
- **Directly reusable:** `packages/effect-sqlite-node` (MIT) is an Effect
  `SqlClient` over `node:sqlite` selected by a `#sqlite` import condition; the
  vendored Drizzle adapter is about 3.4k lines. Copy, do not depend: OpenCode
  publishes neither.

Scope in this program:

- Stages 1 to 6 are written in Effect: `Database` layer, `SqlClient`, Drizzle
  schema, the C6 publisher, the C7 read path, and the hydrate folds.
- One `ManagedRuntime` per process; the storage layer lives in it behind the
  frozen store surfaces, so callers in `SessionHandle`, the hosts, and the
  tools keep calling Promise methods. **Renderer components stay Effect-free**:
  Ink and Lit components never import `effect` and read view state through
  one signal bridge. The processes themselves are not the boundary; the
  companion view-state proposal
  (`2026-09-03-one-view-state-three-renderers.md` §12) runs the same session
  fold Layer in every process that shows a session, webview and Electron
  renderer included, because an Effect fold in Node beside a hand-rolled one
  in the browser would be the dual system this program removes.
- Two touch points with that proposal: `SessionEventHub` uses the ordered
  table tail and wake level in C6/C7, and the `Database` layer is parameterized by
  its `WorkspaceRoots` layer (one database per session root, never the
  process singleton).
- **Publisher invariants are C5 to C7.** The local semaphore serializes
  transactions within a process; conditional claims fence other processes.
  `publishBatch` commits every member before advancing the wake level. The
  durable payload source is always the table, in `commit` order. Each
  transport owns its backpressure; overflow resubscribes from the retained
  commit cursor and settled aggregate sequences. Cold hydration captures
  its anchor before reading and then tails from that anchor. Physical
  retention is observed through the same drain's existence reconciliation.
- **Zod stays the only data schema; Effect Schema is not used at all.** Event
  payloads are Zod-validated at the boundary and stored as JSON `data`. Errors
  are `Data.TaggedError` (verified present in `effect@4.0.0-rc.112`): it gives
  `_tag`, yieldability, and `catchTag` without Schema; `Schema.TaggedError` is
  already renamed on Effect main so the pinned name breaks on the next bump;
  and Schema alone measures about 188 KB minified (56 KB gzipped) in every
  webview bundle. Error payloads cross host bridges as plain tagged objects
  under the Zod union. The zod-native campaign, structured output, and the
  `shared/schemas` ratchets depend on Zod; moving them is a separate campaign
  with its own accounting, not a rider on this one.
- **Two v4 vocabulary traps** (verified against the pinned package):
  `Layer.scoped` does not exist, `Layer.effect` strips `Scope`; and Effect
  code must never call the ALS-backed `currentSession()`, because the
  scheduler interleaves fibers; `WorkspaceRoots` is read from `Context`.
- The companion runtime proposal owns lane D, including the two flow
  families and their ledger in Stage 5. Model-handler bodies remain behind
  that proposal's invocation service; this does not prescribe a separate
  rewrite of those handlers.

The SQLite PRD §8 non-goal is reversed to this scoped form; the reversal is
recorded there and in §10.

## 8. Process: one cutover, no dual system

The owner's constraint is that the migration be efficient and never run two
systems. The SQLite PRD as written violates the second: eight stages, each its
own PR family, its own importer, its own `*.pre-sqlite-backup` directory, its
own verification pass, and its own 90-day retirement clock. That is seven
cutovers and up to seven simultaneous legacy readers. OpenCode V1 did one
cutover and deleted the importer; Codex did none and carries read-repair
forever. This proposal does one.

**Invariant.** On `main`, at every commit, each datum has exactly one writer
and one reader. Before the cutover merge that is the file store; after it,
the database. There is no commit on `main` where both exist for the same
datum.

**How the branch avoids a dual state while being built in parallel.** The
store public surfaces are frozen and ratcheted, so each lane replaces the
engine behind one surface and is verified by the existing callers and
architecture tests. Lanes never touch each other's files; one integration
worktree runs typecheck, lint, the ratchets, and the importer fixture.
Concurrency cap is three worktrees; lane agents commit and report SHAs
(house rules in `AGENTS.md` and the recorded workflow lessons).

| Lane | Owns                                                                                                       | Depends on |
| ---- | ---------------------------------------------------------------------------------------------------------- | ---------- |
| A    | Stage 0 spike, then Stage 1: schema, Effect storage layer, runtime boundary, architecture test             | nothing    |
| B    | Stage 3 behind `StreamLogStore` + `TexraTranscriptRecorder`                                                | A          |
| C    | Stage 2 + Stage 4 behind `StreamSnapshotStore` and the summary tier                                        | A          |
| D    | Stage 5 + Stage 6 behind `ExecutionKVStore`, `persistedFlow`, `executionLease`, `resumability`             | A          |
| E    | The importer (one, covering every store), the deletion sweep of file machinery, `WORKSPACE_STORAGE_LAYOUT` | B, C, D    |

**The importer.** One function converts supported legacy files to events.
Before inspecting those files, a current host atomically claims the reserved
migration aggregate using C5. Every current host passes this gate before
opening the bucket for normal reads, writes, or resume. The claim covers
detection, import, moves, and verification. A live claimant makes another
host wait; automatic takeover requires proof that the recorded process is dead.
Progress facts on that aggregate record the immutable input manifest, planned
event ranges, completed batches, and moves. Each batch commits its rows and
progress together. A successor uses those facts and checks source and backup
hashes to resume after a crash, rather than starting a second import.

All legacy hosts must be closed for the entire migration. The importer
retains legacy lease files in place and probes each distinct recorded owner
using the supported lease reader. A live or unprovable owner blocks automatic import
and resume; age alone never proves death. Absence of a live execution lease
does not establish that an idle legacy host has stopped writing sidecars,
so closing all legacy hosts is an explicit cutover precondition. Claims are
moved only after their owners are proved dead or explicitly cleared, and
verification completes. For an interrupted migration on a verified local
database, the user may explicitly assert that all old hosts are closed and
authorize recovery of an unprovable migration or retained legacy claim.
Recovery records that authorization and compares the exact observed claim
before replacing it; a changed or known-live claim still blocks recovery.
This is a scoped recovery action, never an automatic timeout or a remote
process signal.

With inputs quiescent, independently inventory stream records in
`streamLogs/`, `streamData/`, and `streamLogSummaries/`, and every supported
execution directory under `executions/`. `listExecutions` scans execution
metadata independently today (`src/agent/storage/executionListing.ts:215-263`);
the measured 4,148 executions versus 3,789 stream logs (§2) already rules out
using either listing as a filter for the other. Record every discovered
source file and its disposition in the immutable manifest, including
artifact-only directories that stay in place.

Reconcile execution-to-stream edges from authored metadata. Unambiguous
means consistent with the stream's recorded execution edge and all other
execution claims in the inventory: at most one execution maps to each
stream. Conflicting claims receive distinct import streams rather than
sharing or overwriting a stream aggregate. An execution
with an unambiguous recorded stream id keeps it even if all stream files are
missing; synthesize that stream's `run.start` from the execution metadata.
Do not require a transcript or sidecar to import its execution state. With
no unambiguous edge, give the execution a distinct import stream instead of
merging unrelated histories: use `imported:<executionId>`, adding the smallest
numeric suffix needed to avoid every real or already assigned stream id.
Assign these ids in execution-id order and record the mapping before writes,
so crash recovery makes the same choice. Existing execution ids and generated
artifact paths never change.

Missing record or identity fields remain visibly incomplete, as in today's
`listExecutions`; import their readable history and metadata without
inventing identity, outcome, or resumability. A supported checkpoint is
normalized under the rule below even without a transcript. Missing optional
stream files alone never reject an otherwise supported execution. An
artifact-only directory remains user files and is not promoted to a run or
moved as app state.

Sort the resulting union of original and synthesized streams by persisted
creation timestamp, ascending, with stream id as the deterministic tie-breaker;
use the execution timestamp for a synthesized stream. If a timestamp is
absent, use the earliest persisted entry timestamp; streams with neither sort
first by stream id. Record this order in the manifest before assigning commits,
so a restart preserves history order. Import each stream and each independently
inventoried execution exactly once:

- Synthesize `run.start` from `meta.json` and the sidecar descriptor, with
  nullish identity where none exists, followed by its normalized history.
  Convert all database keys and owning-parent keys through C2. Preserve a
  child's declared parent only when the manifest establishes the exact
  parent run and its imported `run.start` commit; otherwise import it
  detached. No legacy parent id alone authorizes future routing.
- Convert persisted `StreamLogEntry` values into recognized current
  `AgentEvent` arms in file order, as specified by view-state PRD §6. There
  is no `legacy.entry` arm. Read any `spillPath` and inline the full payload
  before normalization, validation, and C3 redaction; a missing or unreadable
  spill blocks that import instead of silently retaining a truncated copy.
  The imported row never depends on the old `toolOutput/` path.
- Map sidecar facts to current event arms with their persisted timestamps,
  and the execution outcome to the canonical `status` fact, not `run.end`.
- Map the supported checkpoint's provider messages to canonical conversation
  rows without changing their bytes, and its non-message `shared` state and
  `FlowRecord.cursor` to the initial snapshot and continuation rows defined
  by runtime §3. Translate both the next node and previous action, including
  any outcome-unknown tool intent. If continuation cannot be mapped safely,
  reject the import and retain its files; do not manufacture a resumable
  snapshot from `shared` alone.

Before either import or native cutover, each current `ExecutionKVStore` key
has a registered converter and a canonical reader/writer. The six reserved
keys (`ExecutionKVStore.ts:43-58`) are not the entire inventory: current
production callers also use the namespaces below. These are named domain
records in the event table, not a replacement generic key/value API.

| Current key or namespace                                                              | Canonical representation and preserved content                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta`                                                                                | `run.start` identity, timestamp, category, stream and parent edges; current workflow metadata and description facts; canonical `status` for outcome. Preserve readable incomplete records without inventing missing fields.                                                                                                       |
| `config`                                                                              | `execution.config`, preserving the current `RunRecord` used by history, export, and resume.                                                                                                                                                                                                                                       |
| `report`                                                                              | `execution.report`, preserving the report text consumed by history and child-result delivery.                                                                                                                                                                                                                                     |
| `result-meta`                                                                         | `execution.result`, preserving the current result envelope, application-level failure detail, and attribution; the canonical `status` remains the sole execution-outcome authority, as in the current result accessor.                                                                                                            |
| `workspace-files`                                                                     | `execution.workspaceFiles`, preserving the normalized path list used for launch context and export.                                                                                                                                                                                                                               |
| `turn-state`                                                                          | The current child-turn protocol's active and last-completed turn tokens (runtime proposal §3, step 4), preserving report/result attribution.                                                                                                                                                                                      |
| `child-<id>`                                                                          | Canonical child launch and parent facts, including the recorded child id, agent, and timestamp; the parent edge is the same `run.start` edge, not another stored parent map.                                                                                                                                                      |
| `codex_thread_id`, `claude_agent_session_id`                                          | Named `execution.codexThread` and `execution.claudeSession` records preserving the external continuation ids.                                                                                                                                                                                                                     |
| `workflow-script-*`                                                                   | The current workflow-script journal's checkpoint identity, script, arguments, files, and ordered activity results, moved to `aggregateId('workflow-checkpoint', checkpointId)` under runtime §3, step 4. Imports sharing a checkpoint use the same aggregate, independently of launch ids. No retired journal version is revived. |
| `stable-subagent-attempt`, `stable-subagent-sequence-*`                               | The current delegation attempt and sequence facts, preserving logical execution identity, parent identity, phase, and next-attempt counter per logical execution.                                                                                                                                                                 |
| Supported `flow_<id>` and stream sidecar keys, including any supported work-plan file | The explicit flow and sidecar normalization above; present values must agree with their canonical authority or stop import for resolution.                                                                                                                                                                                        |

The converter inventory is checked against every current production key
writer before cutover. The manifest records each discovered app-state key,
its converter, and the canonical rows that reproduce its typed read result.
An unmatched or unsupported app-state key blocks moving that file and
completing the cutover; it is never silently discarded by a filename
allowlist. This also prevents a new native writer from surviving without a
canonical reader. The metadata families above are additional to the five
execution **flow** row types in D4 and use C3's display/export redaction.

The manifest assigns deterministic per-aggregate event ranges. Replaying a
committed batch verifies the existing rows against those ranges and skips
only identical rows; a mismatch aborts rather than overwriting history.

**The cutover is file-level, not a directory rename** (SQLite PRD Stage 5
rules this). `executions/<id>/` holds user-facing generated artifacts beside
the app JSON (`output.xml`, workflow outputs that `listRunGeneratedFiles` and
`/executions/{id}/files` resolve at the execution path), and those stay
exactly where they are. The importer moves only app-state files whose
registered conversions and typed read results have been verified, including
the current generic namespaces in the table above and normalized spill
content from `toolOutput/`, into a mirror under `pre-sqlite-backup/`.
It then verifies the moved files against
the manifest and imported rows before releasing all imported aggregate
claims and the migration claim, then admitting
normal access. For a crash between a move and its progress commit, the next
claimant verifies the destination hash and records the completed move. A
source change, conflicting destination, or unaccounted missing file aborts
verification; rereading after a move is not a substitute for quiescent
writers. `streamLogs/`, `streamData/`, and `streamLogSummaries/` are app state
throughout and move as whole directories. Retained `executionLeases/` move
only after the final owner checks above. Progress is one line per thousand
rows; the measured 7 s parse cost for 3,125 checkpoints (companion §1) bounds the worst
bucket at low minutes, once.

Checkpoints are imported eagerly, not lazily. A lazy path would leave
`flow_<id>.json` as a live read arm for months, which is a dual system. The
cost is one pass over 3.0 GB in the largest bucket; the payoff is that after
the importer runs there is exactly one shape of resume data.

**Version skew and retirement.** Concurrent legacy writers are not supported
during cutover. A new CLI must defer opening an unmigrated bucket while an
older extension holds a live or unprovable claim; the user must close and
update all legacy hosts before migration. The explicit interrupted-migration
recovery above is the only exception for an unprovable retained claim.
After successful migration the
database is authoritative. If a stale host recreates app-state files, the
current host reports the unsupported older writer and blocks writes and
resume until that conflict is resolved. It refuses to merge potentially
divergent histories or repeatedly ingest those files over current rows.
The release notes state this upgrade requirement.

The importer protects released file-backed histories only during one
compatibility window. Its introduction date is the actual cutover release
date, recorded beside the importer and its schemas when that release ships;
the proposal date is not that date. Remove the importer, legacy schemas,
lease reader, progress facts, backup handling, and their fixture tests in
the first release shipped at least three calendar months later. Publish the
deadline with the cutover release. After retirement, older histories require
the last importing release for an explicit conversion; current releases have
no legacy read arm. Desktop state has no public-release compatibility claim
and adds no migration branch solely for its historical formats.

**Deletion is in the cutover, not after it.** The release that adds the
database removes the normal read and write paths in the §6.3 "Gone" table;
the named import-only readers retire at the date above. After import,
`WORKSPACE_STORAGE_LAYOUT` shrinks to `{ texra.db, texra.db-wal, texra.db-shm,
original, memories, state.json, config.json, _workspace.json, pasted,
recordings }` plus the per-execution artifacts area, which is user documents,
not app state. `pre-sqlite-backup/` is also a declared temporary layout entry
throughout the import window, excluded from ordinary cleanup and removed
with backup handling when the importer retires. If those deletions are not in the cutover PR the pain
was not short, it was deferred.

**Acceptance, before merge, on a copy of the TNLean bucket:**

- import completes once, in low minutes, and a second open imports nothing;
- every supported execution is accounted for, including executions with no
  stream log and visible incomplete metadata; generated artifacts retain their
  paths, and supported checkpoint availability is preserved;
- `texra chat` shows the prompt in under two seconds with 4,148 executions
  present;
- kill -9 during streaming loses at most the in-flight message (C4) and the
  next open needs no repair pass;
- saved histories survive age-based cleanup, including imported and terminal
  histories; every retained execution key preserves its typed read result;
- two launches with fresh stream/execution ids but the same `checkpointId`
  cannot mutate its journal concurrently; after claim release, resume reads
  the same journal, which survives deletion of one launch while another
  saved launch still refers to it;
- deleting a stream closes its state in one transaction; generated-file
  cleanup retries after a crash before final collection, and no state holder
  observes a half-deleted stream;
- all ratchets green; no store public-surface change.

**Ordering against `main`.** The companion's S1 to S3 land on `main` first, as
pure deletions of boot work; they shrink the cutover and give users the
48-second fix now. The cutover branch is cut after them. Nothing else touches
`src/transcript/`, `src/agent/storage/`, or `persistedFlow.ts` on `main`
while the branch is open, or the merge pays for it twice.

**Effort.** Stage 0 is half a day. Lanes A to E are one to two focused weeks
with the parallel-agent workflow, judged against OpenCode's +5.8k/-0.9k over
61 files for a simpler data model. The deletion list is about 11k lines.

## 9. Deliberately not proposed

- An append-only JSONL journal beside the files, or beside the database. The
  event table is the journal (§5).
- Persisted projection tables, a summary table, or a status column. They are a
  second copy with a lifecycle; C10 says when one may ever be added.
- Partial-text checkpoints (`stream.text`). One writer per datum (C4).
- A cache or index in front of the existing directories. It keeps the
  O(history) scan and adds invalidation.
- Lazy checkpoint import. It is a live legacy read arm, which is a dual system
  by another name (§8).
- Collapsing the two-step fold (events to entries to `TranscriptRow`) inside
  the cutover. It touches every renderer in three hosts; it is the view-state
  PRD's move after the merge, and by then it is a pure refactor of two
  functions with zero storage impact.
- A separate rewrite of model-handler bodies beyond the runtime proposal's
  invocation service, or moving schemas from Zod to Effect Schema (§7).
- Any new lint rule beyond the one architecture test. The rule is one
  sentence: all app-owned durable state lives in the database.
- Publishing this document. `proposals/**` is excluded by
  `docs/.vitepress/publicDocs.js:42`.

## 10. Decisions requested from the owner

1. Ratify the target in §5 and the contract in §6.1: two tables, folds
   everywhere, nothing derived persisted. Mark
   `2026-08-18-session-event-journal.md` absorbed and
   `2026-08-16-sqlite-workspace-state.md` amended (§3.2, §5 staging, §8 Effect)
   in their status lines, each with a pointer here.
2. Ratify D4: the runtime proposal's flow rows (`model.message`,
   `model.compaction`, `tool.intent`, `tool.result`, `flow.step`,
   `flow.snapshot`) are the resume representation, so resume is a fold and run
   content is stored once. Naming is owned there; the snapshot exception is
   owned here (C10).
3. Rule the sidecar-collapse contradiction (memory PRD :414-418 versus SQLite
   PRD §1): this proposal folds the six files on hydrate and carries the
   migration through the quiescent, time-limited importer in §8 instead.
4. Confirm the process in §8: one cutover release, one importer, eager
   checkpoint import, deletions in the same release, same-version hosts.
5. Confirm the Effect scope in §7: substrate, fold, and the runtime lane, renderer components
   Effect-free, Zod the only data schema.
6. Confirm C9's preservation rule: saved histories remain until explicit
   deletion. Set a cleanup grace only for declared disposable, nonresumable
   orphan/ephemeral cohorts and already-deleted tombstones; terminal status
   alone never permits expiry.
7. Answer the SQLite PRD's open question 2 (are `memories/` documents or
   rows). This proposal assumes documents, so they stay files.
8. File one tracking issue for the program; none exists today.

## 11. Verified

Read first-hand at `1fbcaa0108`: `src/common/storage/KVStore.ts`,
`src/common/storage/storageLayout.ts`, `src/transcript/StreamLogStore.ts`
(:43, :315-320, :474-485, :1229), `src/transcript/StreamSummaryCacheStore.ts`
(:280-303), `src/agent/storage/resumability.ts`, `src/agent/storage/executionListing.ts`,
`src/agent/runtime/SessionHandle.ts` (:271-335, :389), `src/agent/runtime/restartRepair.ts`,
`src/platform/interfaces.ts:123`, `packages/cli/package.json:37`,
`packages/desktop/package.json:33`, root `package.json:63,132`, `AGENTS.md:690-720`.
Docs read in full: `docs/prds/2026-08-11-transcript-memory-architecture.md`,
`docs/prds/2026-08-16-sqlite-workspace-state.md`,
`docs/prds/2026-08-18-session-event-journal.md`,
`docs/proposals/2026-08-23-single-owner-sessions.md`,
`docs/proposals/2026-09-02-simplification-survey-stream-memory-round2.md`,
`docs/proposals/2026-09-02-stream-lifetime-and-cancellation-simplification.md`,
`docs/proposals/2026-09-03-startup-repair-is-the-wrong-shape.md`. GitHub state
and closing comments checked on #9945, #9947, #10773, #10809, #10820, #10841,
#10878-#10885, #11014, #11731, #11771, #10753. On-disk counts from
`~/.texra/workspace-storage/` on 2026-09-03 with `ls`, `du`, `find`, and a
Python parse of one transcript and one checkpoint. Peer sources: Claude Code
readable snapshot (`src/utils/sessionStorage.ts`, `src/types/logs.ts`,
`src/services/compact/compact.ts`); Codex at `728cb12fe57` (2026-09-03;
`codex-rs/rollout/src/{recorder,policy,list,model_context,reverse_jsonl_scanner}.rs`,
`codex-rs/state/src/{lib,sqlite,extract}.rs`, `codex-rs/thread-store/`);
OpenCode at `f12e14cf` (2026-09-03; `specs/v2/session.md`,
`specs/v2/schema-changelog.md`, `packages/core/src/event.ts`,
`packages/core/src/event/sql.ts`, `packages/core/src/session/{sql,projector,message-updater,context-epoch,history,input}.ts`,
`packages/core/src/database/{database,migration,sqlite.bun,sqlite.node}.ts`,
`packages/effect-sqlite-node/src/index.ts`, `packages/effect-drizzle-sqlite/`,
`packages/opencode/src/effect/app-runtime.ts`; PRs #10597, #13874, #30461,
#14326, #16884), built with `bun install` and run from source; its
`opencode-local.db` schema dumped with `sqlite3 .schema` to confirm the
`event`, `event_sequence`, `session_message`, `session_input`, and
`session_context_epoch` tables. Delegated sweeps produced the inventories;
every line reference used in §1, §3, §4, and §6 was re-read here before
citation.
