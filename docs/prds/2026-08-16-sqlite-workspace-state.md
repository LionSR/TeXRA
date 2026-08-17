---
created: 2026-08-16
updated: 2026-08-17
---

# PRD: One SQLite database per workspace for app-owned durable state

**Status:** draft proposal. Companion to
`docs/prds/2026-08-11-transcript-memory-architecture.md` (the memory
evidence), `docs/proposals/2026-08-15-single-substrate-hosts-as-renderers.md`
(orthogonal campaign, no shared PRs), and issues #10702, #10773, #10774,
#10775. **Supersedes the JSONL prescription in #10773** (its diagnosis — the
whole-file rewrite primitive is the root defect — is exactly what this PRD
fixes; the prescription changes because the engine decision changes the
trade-off, §3.2).

**Decision in one sentence:** all app-owned durable workspace state moves into
one SQLite database per workspace (`node:sqlite`, WAL); files remain only for
user-owned documents and interchange/export formats.

## 1. Problem: the semantics layer keeps paying rent for missing primitives

Three times now, well-built coordination machinery has grown to compensate for
a storage primitive that provides no guarantee:

1. **No atomic write smaller than the whole stream.** `StreamLogStore`
   persists a transcript by re-serializing and atomically rewriting the entire
   entries array every 300 ms window (`writeStream` →
   `kv().write(streamId, logInstance.toPersistedEntries())`). Because any save
   can clobber history, the store carries dirty-tracking, write generations,
   tombstones, merge-disk-under-live-appends, a `loadFailed` quarantine, and
   an iterative flush loop — most of its 1,739 lines.
2. **No atomic multi-store operation.** "Delete a stream" spans four state
   holders (`SessionState`, `SessionStores`, `StreamLogStore`,
   `StreamSnapshotStore`), each with its own async queue. PR #10702
   (+1,076/−131, 12 commits, one follow-up revision per review round) had to
   hand-implement the textbook distributed-systems stack — incarnation
   numbers (SWIM), fencing tokens, a saga with compensation
   (`StagedDeletionCoordinator`, 612 lines), OCC re-validation after every
   await, and barrier-buffer-replay — because no transaction exists to buy
   those guarantees from.
3. **No read smaller than everything.** Opening a workspace scans and parses
   every summary file; hydrating a stream parses its whole JSON array;
   `StreamSnapshotStore` seeds six sidecar files per stream (measured
   workspace: 1,923 streams, 991 MB transcripts, 5,274 sidecar files holding
   22 MB) behind seed chains, `DiskState` provenance, and overlay-replay —
   most of its 2,164 lines.

Guard-based concurrency has a property the other debt classes lack: it does
not compose. Every future change touching stream state must be written by
someone who understands incarnations, barriers, and which awaits need
revalidation. That is the recurring maintenance cost this PRD removes.

### Survey evidence (2026-08 snapshots)

- **openai/codex** pairs append-only JSONL rollouts with a SQLite state
  database (`codex-rs/state`) for metadata, backfill, and search. Their cells
  are immutable at creation, which is what makes pure append-only viable for
  them (§3.2 on why it is not for us).
- **sst/opencode** made SQLite (Drizzle) the source of truth for
  sessions/messages/parts/events. Their storage engine choice is validated at
  production scale on Bun/Node; their _app-level transaction semantics_
  (ambient transaction context, post-commit effect queues) are the documented
  cautionary tale (`specs/storage/remove-opencode-db.md` in the opencode
  repo, not a local path) — §6 bans importing that shape here.
- **VS Code itself** stores extension state in SQLite (`state.vscdb`); the
  platform this project embeds in already made this call.

### What changed to make this viable

The Electron PRD (2026-05-02 §5.2) rejected `better-sqlite3` for a then-valid
reason: native dep + asar unpacking + migration tooling. `node:sqlite` ships
inside the Node runtime — zero dependencies, synchronous API. Version floors,
stated precisely: `engines.node >= 22.9.0` is declared in `packages/cli` and
`packages/agent` (the root manifest has no `engines` field); desktop is
Electron ^43; extension targets `vscode ^1.125.0`. `node:sqlite` landed in
Node 22.5.0 but stayed behind `--experimental-sqlite` until 22.13.0 (unflag:
nodejs/node#55890, also 23.4.0), so the 22.9–22.12 window carries it only
behind the flag. The Electron 43 and VS Code 1.125 runtimes are past the
unflag point; the CLI floor is the gap. Stage 0's concrete go/no-go: raise
the CLI/agent floor to `>= 22.13.0` (preferred) or verify flagged operation
in the 22.9–22.12 window.

## 2. The rule

> **All app-owned durable state lives in `texra.db`, one database per
> workspace storage bucket. Files exist only for (a) user-owned documents
> (LaTeX sources, `original/` snapshots, user-editable memories) and (b)
> interchange formats (archived `trace.json`, chat exports).**

Corollaries:

- Rows own **existence**: a stream, execution, or run exists iff its row
  exists. Deletion is one transaction with `ON DELETE CASCADE`, and the same
  transaction inserts the deleted id into the `stream_tombstones` fence
  table (§3.3) — existence and the late-fact fence are separate tables, so
  neither invariant compromises the other.
- No app-owned live state in files; no user documents in the database.
- **One named permanent exception — the settings files:** the workspace
  bucket's `state.json` (host UI/settings state — `PersistedState`, opened
  by the CLI in `cliStateStores.ts` and by desktop in its platform wiring)
  and the bucket `config.json` that `initializeElectronPlatform` falls back
  to when no workspace exists or `.texra/config.json` is not writable. §8
  keeps UI state out of SQL by design, so that file stays, on the
  architecture test's allowlist, in the target layout. The narrowing is
  load-bearing: `GoalStore` currently persists **durable goal lifecycle
  records** through the same `workspaceState` file, and those are app state,
  not UI — they move to `goals` rows (§3.3) so stream deletion's cascade
  covers them instead of today's separate best-effort `goalEntries.forget`.
- Derived tables (FTS index, stats caches) keep the #9434 derived-tier
  contract: discard-and-rebuild from authoritative rows, never migrate.
- The rule is enforced by an architecture test (§7): persistence writes
  outside the database that are not on the documents/export allowlist fail CI.

## 3. Target architecture

### 3.1 Storage layout

```
workspace storage today                     workspace storage after
├── streamLogs/           991 MB            ├── texra.db (+-wal/-shm — engine family)
├── streamLogSummaries/   7.5 MB            ├── original/     (user document snapshots)
├── streamData/           5,274 files       ├── memories/     (user-editable documents)
├── executions/ executionLeases/            ├── executions/{id}/files
├── executionLocks/ memories/ original/     │                 (run artifacts: outputs +
├── taskRuns/  state.json  _workspace.json  │                  snapshots — documents)
                                            ├── state.json  config.json
                                            │                 (host settings, §2 exception)
                                            ├── _workspace.json (bucket identity, §7)
                                            ├── pasted/  recordings/
                                            │                 (user-media caches: pasted
                                            │                  images, audio — documents)
                                            └── taskRuns/     (legacy, until #6981
                                                               retention drains it)
```

Legacy `taskRuns/` (`WORKSPACE_STORAGE_LAYOUT.legacyRuns`) is grandfathered:
it stays read-only on its existing #6981 retention path, is never migrated
into rows, and its layout key retires when that policy drains it. It is the
one deliberate exception to the §2 rule, time-bounded by retention.

Engine: `node:sqlite` (fallback: `better-sqlite3`, accepting the packaging
cost, if Stage 0 finds the built-in flagged or unfit on any host). Schema and
migrations: `drizzle-orm` + `drizzle-kit` (pure TS, no runtime codegen;
`kysely` is the named alternative). **SSOT direction is fixed:** the domain
Zod schemas in `src/shared/schemas/` remain the single source of truth —
Drizzle table definitions are relational _projections_ of them, pinned by
compile-time assertions (column payload types `satisfies` the corresponding
`z.infer` types). Domain schemas are never generated from tables;
`drizzle-zod` output, if used at all, validates rows at the storage
boundary only and never replaces a domain schema. Pragmas at open:
`journal_mode=WAL`, `busy_timeout`, `foreign_keys=ON` — cheap, O(1) settings
only. Integrity checking is **not** a per-open step (even `quick_check`
scans the database, which would reintroduce O(history) startup against §9):
it runs on recovery paths (a failed open, a suspected-corruption error) and
as periodic maintenance. Backup: `VACUUM INTO`.

Degradation generalizes with the consolidation: today's
`StreamLogStore.openOrEphemeral()` covers only the transcript directory,
which is wrong the moment every store shares one database — a failed
`texra.db` open would leave transcript reads degraded while execution,
snapshot, goal, and lease operations kept failing independently. The
replacement is a **database-wide degraded mode** with the same contract the
transcript store's ephemeral mode has today: one loud warning, an in-memory
adapter serving every store, resume disabled for the session. One database,
one degradation decision — never a per-store patchwork.

### 3.2 Transcript entries are rows (supersedes #10773's JSONL prescription)

JSONL was the right call in a no-database architecture. Once the database
exists, a second bespoke file format _is_ a mixed architecture — and the
inferior fit: TeXRA entries mutate until settled (`update`/`settle`/
`appendText`), so JSONL needs patch-lines, fold-on-read, and close-time
compaction — a hand-rolled LSM tree. Rows fit the mutation model natively:

- append = `INSERT`; mutation = `UPDATE` of one row; settled (#10774) = row
  never written again. The existing 300 ms save throttle batches dirty rows
  in one transaction — same cadence, O(changed rows) instead of O(stream).
- **Partial hydration**, which files structurally cannot give: opening a
  historical stream can read `SELECT … ORDER BY seq DESC LIMIT n`, paging
  older on demand. Third independent attack on the memory PRD's problem.
  **Not free at the in-memory layer:** today's `StreamLog` constructor
  renumbers entries from 1, `head` equals the resident count, and consumers
  treat `getRange(0)` as the complete log — a naive suffix load would
  renumber, collide the next append with `UNIQUE(stream_id, seq)`, and
  silently truncate resyncs. Consuming partial hydration therefore requires
  a base-seq-aware `StreamLog` (absolute sequence base; `head = base +
resident count`) or restricting suffix loads to read-only display paths.
  This is scheduled as explicit Stage 4 design work; until it lands, live
  and writable streams hydrate fully, exactly as today.
- Transcripts join the same deletion cascade as everything else, so the
  #10702 problem class ends uniformly.

The in-memory `StreamLog` object and the delta/emission protocol are
**unchanged** — they are the UI contract. Only the persistence layer beneath
`StreamLogStore` swaps; the store's public surface stays frozen (the
store-public-surface ratchet is what makes this a swap, not a rewrite) —
**with one scheduled, additive exception**: the synchronous `keys()`
contract returns every stream id from the always-resident summaries map,
and startup paths iterate it (`SessionState.load`, desktop wiring), so
freezing it verbatim would force loading all ids before startup and defeat
the O(visible page) criterion no index can rescue. Stage 2 adds a
paginated listing surface and migrates **every startup-wide scan** to it
or to indexed queries in the same PR family — not only `SessionState.load`
and the desktop wiring, but the scans they invoke:
`SessionStores.sweepLeftoverStreams()` (builds complete sets from
`streamLogs.keys()`) and `SessionHandle.runRestartRepair()` (iterates the
full registry; becomes the §3.3 partial-index recovery query). `keys()`
remains for non-startup callers during the transition and retires with a
ratchet-baseline shrink, not a widen.

Entry payloads remain opaque JSON in a single column (Tier 3 stays Tier 3);
this PRD does not normalize entry internals. A separate `text` column feeds
FTS (§3.4).

### 3.3 Schema sketch (finalized in Stage 1, not incrementally)

```
-- authoritative: a row's existence IS the fact
streams           (id PK, incarnation, created_ts,
                   parent_stream_id FK → streams(id) ON DELETE SET NULL,
                   current_execution_id NULL FK → executions(id)
                     ON DELETE SET NULL)
                   -- parent edge: SET NULL, not CASCADE — deleting a parent
                   -- DETACHES its children (today's
                   -- deleteAdjacentStreamState semantics); cascading the
                   -- self-edge would recursively delete every descendant.
                   -- current_execution_id: the ONE execution whose config/
                   -- description/resume state the stream currently shows —
                   -- replaced on run.start (StreamSnapshotStore's existing
                   -- pointer semantics); nullable breaks the FK cycle
                   -- (insert stream → insert execution → set pointer).
entries           (stream_id FK CASCADE, seq, entry_id,
                   settlement_seq NULL, timestamp, entry JSON, text NULL)
                   UNIQUE(stream_id, seq)  UNIQUE(stream_id, entry_id)
                   -- the second unique index serves the actual mutation
                   -- path: update/settle/appendText address entries by id,
                   -- and the mixed-version importer tests id-presence per
                   -- entry — without it both scan the stream's rows,
                   -- making the O(changed rows) hot-path claim false on
                   -- long transcripts. Also the dedup constraint if
                   -- admission retries.
executions        (id PK, stream_id NULL FK CASCADE, meta JSON, config JSON)
                   -- stream_id is NULLABLE by domain fact, not convenience:
                   -- ExecutionMetaCoreSchema.streamId is optional, and
                   -- executionListing deliberately retains execution
                   -- directories with no stream mapping. Those import with
                   -- a NULL edge so their records and artifacts keep a
                   -- destination at Stage 5; they are listed as today and
                   -- leave via retention or explicit delete.
execution_records (execution_id FK CASCADE, key, payload JSON,
                   PRIMARY KEY (execution_id, key))
                   -- keyed home for EVERYTHING ExecutionKVStore owns today:
                   -- report, workspace-files, result-meta, turn state,
                   -- per-child records, generic keys, flow/workflow
                   -- checkpoints. A catch-all record table so Stage 5 has a
                   -- destination for every record without later schema
                   -- drift; individual keys may be promoted to typed
                   -- columns via ordinary migrations when queries need them.
run_usage         (stream_id FK CASCADE, storage_key, usage JSON,
                   PRIMARY KEY (stream_id, storage_key))  -- upsert target
round_facts       (stream_id FK CASCADE, kind {output|missing|compile},
                   round, payload JSON,
                   PRIMARY KEY (stream_id, kind, round))
                   -- one payload per (stream, kind, round) slot — the
                   -- sidecars' map semantics; deterministic upsert target.
work_plans        (stream_id PK FK CASCADE, plan JSON, plan_summary NULL,
                   todos JSON)
                   -- plan_summary is a distinct durable field in
                   -- StreamSnapshotSchema (compaction falls back to it when
                   -- the full plan is absent) — losing it in projection
                   -- would be a lossy migration.
goals             (stream_id PK FK CASCADE, goal JSON)
                   -- moved OUT of state.json (§2): durable goal lifecycle
                   -- records join the cascade; today's separate best-effort
                   -- goalEntries.forget after deletion disappears.
migration_records (source, key, payload JSON, absorbed_at,
                   PRIMARY KEY (source, key))
                   -- importer-owned bookkeeping with a schema home so Stage
                   -- 3 needs no drift: the per-source absorbed-goal ledgers
                   -- (source = 'goal-ledger:cli' / 'goal-ledger:extension')
                   -- and the orphan-goal quarantine
                   -- (source = 'goal-quarantine'). Deliberately NOT
                   -- execution_records: that table's key requires an
                   -- execution_id, and these records exist precisely when a
                   -- valid parent is missing. Deleted whole with the
                   -- importer at the §5 retirement.
stream_tombstones (id PK, incarnation, deleted_at)
                   -- the late-fact fence, deliberately NOT an FK child of
                   -- streams: it is written in the SAME transaction that
                   -- hard-deletes the streams row and must outlive it.
                   -- Resolves the exists-iff-row / fence contradiction:
                   -- existence lives in streams, the deleted-id fence lives
                   -- here. Small, append-only, and retained INDEFINITELY
                   -- by default: age-based pruning would reopen the race it
                   -- exists to close (a sufficiently delayed fact arriving
                   -- after the prune sees neither a live row nor a fence
                   -- and could re-mint a "never reused" id). Pruning is
                   -- permitted only under a proof condition tied to
                   -- producer lifetime (no lease, event-plane buffer, or
                   -- resumable execution can still reference the id) —
                   -- specified at Stage 7, not assumed.
execution_leases  (execution_id PK FK CASCADE, owner_token, acquired_at,
                   heartbeat_at, generation)
                   -- WAL serializes writes; it does NOT provide ownership.
                   -- These fields carry what the lease files carry today:
                   -- acquire = transactional compare-and-set (INSERT, or
                   -- UPDATE … WHERE owner_token = ? / heartbeat stale),
                   -- heartbeat = UPDATE … WHERE owner_token = ?,
                   -- release = DELETE … WHERE owner_token = ?, and
                   -- `generation` fences a displaced continuation from
                   -- writing under a later owner. Full protocol spec is
                   -- part of Stage 1's schema design; cutover is Stage 6.

-- derived: rebuildable from authoritative rows, never row-authoritative
stream_summaries  (stream_id PK FK CASCADE, last_ts NOT NULL,
                   has_running_group,
                   has_running_streaming_text,
                   has_nonterminal_workflow_call, summary_meta JSON)
                   INDEX (last_ts DESC, stream_id)
                   -- the cursor-pagination index IS the O(visible page)
                   -- startup claim; without it, ORDER BY last_ts scans and
                   -- sorts every summary row. Part of Stage 1, not later.
                   -- last_ts is NOT NULL by definition: a registered-empty
                   -- stream (no entries yet) carries its created_ts — a
                   -- NULL cursor would break keyset pagination (SQL tuple
                   -- comparisons with NULL never advance) and drop empty
                   -- streams from later pages.
                   PARTIAL INDEX ON (stream_id) WHERE has_running_group
                     OR has_running_streaming_text
                     OR has_nonterminal_workflow_call
                   -- the orphan-recovery predicate: after kill/reload the
                   -- sweep asks "which streams have unfinished work" — an
                   -- unindexed scan of every summary would contradict the
                   -- §9 indexed-recovery criterion. Almost always tiny
                   -- (only unfinished streams have rows in it).
entries_fts       (FTS5, contentless)
```

Access-path indexes ride the authoritative side — SQLite does not
auto-index child FK columns, and each of these is probed by a delete or an
advertised query: `INDEX executions(stream_id)` (stream deletion's cascade
probe; stream→execution history), `INDEX streams(parent_stream_id)` (the
`SET NULL` probe on parent deletion; the §3.4 recursive topology queries),
and `INDEX streams(current_execution_id)` (the `SET NULL` probe on
execution deletion). Ownership integrity: the pointer FK alone proves the
target execution _exists_, not that it _belongs to this stream_ — a
misapplied row could point stream A at stream B's execution. Enforce the
pair with a **trigger** validating `executions.stream_id = streams.id`
whenever the pointer is set. A composite FK
(`FOREIGN KEY (current_execution_id, id) REFERENCES
executions(id, stream_id)`) is **invalid** here: SQLite applies the
`ON DELETE` action to every child column, so `SET NULL` on execution
deletion would try to null `streams.id` itself — violating the primary key
or destroying the stream's identity. Trigger, not composite FK.

Derived-flag atomicity: the `stream_summaries` recovery flags are the
recovery sweep's _only_ predicate, so they commit **in the same transaction
as the entry batch that changes them** (the store already computes them
incrementally; the write batch carries both). A kill between an entry
commit and a separate flag commit would otherwise hide an unfinished
stream from the partial index permanently.

Every child-**table** FK (`entries`, `executions`, `execution_records`,
`run_usage`, `round_facts`, `work_plans`, `goals`, `stream_summaries`)
carries `ON DELETE CASCADE` explicitly — SQLite's default is `NO ACTION`,
which would _reject_ the parent delete instead of cascading it. Two edges
are deliberately different: `streams.parent_stream_id` is
`ON DELETE SET NULL` (detach-children semantics), and `stream_tombstones`
has no FK at all (it must survive its stream's deletion).

The authoritative/derived split is a table boundary, deliberately: the #9434
discard-and-rebuild contract applies to `stream_summaries` and `entries_fts`
as whole tables (recompute from `streams`/`entries`), never to `streams`
rows — a malformed summary must not be able to take the authoritative row,
and its cascade, down with it.

Deletion semantics, stated implementably for Stage 7: **hard-delete the
`streams` row (cascades every child table) and insert `(id, incarnation,
deleted_at)` into `stream_tombstones` in the same transaction.** The fence
check (`SessionFactApplier` admission) consults `stream_tombstones`;
compare-and-set on `streams.incarnation`
(`… WHERE id = ? AND incarnation = ?`) is the entire fencing mechanism for
mutations. The fence table and the single fact-admission gate in
`SessionFactApplier` (the reducer — `SessionEventHub` is fan-out only, not
admission) are the essential residue while facts are async.

### 3.4 Capabilities unlocked (not counted in the ledger)

Startup cost proportional to the visible page instead of workspace history;
FTS5 search across all transcripts ("which session proved that lemma?");
usage/cost analytics via `SUM`/`GROUP BY`; a real resume/history picker with
paging and filters; topology queries (recursive CTE over parent edges);
retention as policy (`DELETE` + cascade + file sweeper for exports);
recovery sweep as an indexed `WHERE`; safe concurrent hosts via WAL; later
and flagged: `sqlite-vec` embedding search over `memories/`.

## 4. Net-element accounting (R6)

Measured 2026-08-16 at `origin/main` 6fd0317 (+ #10702 draft). Storage layer
in scope ≈ 8,400 LoC.

| File                                                                                     | Today  | After | Net                                                  |
| ---------------------------------------------------------------------------------------- | ------ | ----- | ---------------------------------------------------- |
| `StagedDeletionCoordinator.ts`                                                           | 612    | 0     | −612                                                 |
| `StreamLogStore.ts`                                                                      | 1,739  | ~650  | −1,050                                               |
| `StreamSnapshotStore.ts`                                                                 | 2,164  | ~850  | −1,300                                               |
| `streamSnapshotRead.ts`                                                                  | 307    | ~50   | −250                                                 |
| `SessionStores.ts` (deletion orchestration)                                              | 777    | ~430  | −350                                                 |
| `executionRegistry.ts` (lease/lock portion)                                              | 1,007  | —     | −200 (softest; per-item study owed)                  |
| `streamDataPaths` + `ResidentStreamRegistry` + `KVStore(+Cache)`                         | 373    | ~50   | −320 (KV retires at Stage 5 with `ExecutionKVStore`) |
| #10702 machinery (draft)                                                                 | +1,076 | ~150  | −900                                                 |
| `completedRunArchive.ts`                                                                 | 370    | ~320  | −50                                                  |
| **Gross deletion**                                                                       |        |       | **≈ −5,000**                                         |
| Adds: schema (~200) + engine adapter (~200) + migrate-on-open importer (~300, temporary) |        |       | **+700**                                             |
| **Net production**                                                                       |        |       | **≈ −4,300** (range −3,800..−4,800)                  |

Test footprint pinned to deleted machinery: `StreamLogStoreLoad` 2,083,
`StreamSnapshotStore.vitest` 2,961, `SessionStores.vitest` 748,
`StagedDeletionCoordinator.vitest` 260, `CliPersistenceFlush` 103 — expect
−3,500..−4,500 retired or replaced smaller (tests are budget, per AGENTS.md).

Estimates are read-the-code, same epistemic class as the single-substrate
census; the `childExecutions` lesson (585 → 696 between census and
execution) applies — **re-verify each file's numbers in its own PR.**

## 5. Migration plan — one owner per datum at every moment

Phased adoption is fine; **dual ownership is banned**. Each stage is one PR
family: swap the engine behind the frozen store surface, migrate that store's
data on first open (read files → insert rows → rename old dir to
`*.pre-sqlite-backup` → **verification pass: re-run the import over the
renamed snapshot**), and delete that store's coordination machinery in the
same PR (build-implies-delete). The verification pass closes the
read-and-rename race: a legacy write landing after the importer's read but
before the rename would otherwise be carried into the backup without ever
reaching rows — and, with no live legacy dir left, never trigger a
re-import. Because inserts are keyed and idempotent, re-importing the
renamed snapshot folds exactly the interval's writes and nothing else. No
long-term mirroring or dual-write.
The importer, the `*.pre-sqlite-backup` dirs, and their compatibility tests
have a retirement condition fixed at birth: Stage 1 files the removal issue,
and the removal PR lands **no earlier than 90 days AND two shipped releases
after Stage 6 (the final migration stage) — whichever comes later** — so a
frequent release cadence can never shorten the three-month import window the
AGENTS.md compatibility-machinery rule guarantees upgrading users.
Archived `trace.json` readers (B3) are untouched — exports are produced from
rows; export compat is not storage compat.

- **Stage 0 — spike (half day).** `node:sqlite` flag status on all three
  hosts; WAL behavior with CLI + extension concurrently open on one
  workspace; Electron 43 bundled Node minor. Go/no-go on the built-in vs
  `better-sqlite3`.
- **Stage 1 — schema + adapter.** The full §3.3 schema lands as one design
  (no incremental schema drift), plus open/migrate/recovery/backup adapter
  and the architecture test (§7). On acceptance of this PRD, close #10773
  with a pointer here (diagnosis absorbed, prescription superseded) and file
  the importer-removal issue (§5 retirement condition).
- **Stage 2 — registry rows + execution identity rows + summaries table.**
  The `streams` registry migrates FIRST: every later stage inserts child
  rows with enforced FKs to `streams`, so the parent rows must exist before
  any child table has data. The Stage-2 importer derives them from the
  authoritative transcript registry (the `streamLogs/` directory listing —
  today's registration authority), giving the registry exactly one migration
  owner; deriving parents from the discardable summary cache could omit
  streams. **Execution identity rows** (`executions`: id + stream edge
  where one exists — `streamId` is optional in `ExecutionMetaCoreSchema`,
  and unmapped execution directories import with a NULL edge per §3.3)
  import here too — Stage 3 sets `streams.current_execution_id` from
  `streamData/meta.json`, and with `foreign_keys=ON` that pointer needs its
  target row to exist first. **A present edge is verified, not trusted:**
  the execution-listing contract retains executions whose named stream was
  deleted or never persisted (`ExecutionListing.vitest.ts` pins this), so
  an edge naming a stream absent from the migrated registry imports as
  NULL with a `warn` — importing it verbatim would fail the FK and abort
  the migration. The Stage-3 pointer assignment closes the reverse case:
  when `streamData/meta.json` names an execution whose row imported with a
  NULL edge, the sidecar itself is the ownership evidence — the importer
  **attaches** the execution (`stream_id := streams.id`) before setting the
  pointer, satisfying the ownership trigger; a sidecar naming a missing
  execution row imports the pointer as NULL with a `warn`.
  `stream_summaries` (derived, #9434-discardable — worst case is a rebuild)
  rides along as the pilot payload, deleting the mtime-staleness heuristic
  and scan-on-open. **Authority bridge, stated explicitly:** until Stage 4
  retires the transcript files, `streamLogs/{id}` existence remains the
  registration authority and the `streams` rows are a **maintained
  mirror** — every migrated open reconciles rows against the file listing
  (new file → insert row; file gone → delete row + tombstone, in one
  transaction), because during the gap a legacy host can create or delete
  a file-backed stream the row registry would otherwise miss, and the
  directory cannot be renamed while migrated hosts still read entry
  payloads from it. Authority flips to rows in the Stage-4 PR that
  retires the files; FK children imported at Stage 3 hang off the mirror
  and follow its reconciliation.
- **Stage 3 — `streamData/` sidecars + goal entries → rows.** The big
  machinery win in `StreamSnapshotStore` (seed chains, provenance, overlays,
  write mutexes). **Dangling `parentStreamId` edges get the same treatment
  as dangling execution edges:** today's best-effort child detachment can
  fail while the parent deletion still commits (`stageDeleteStream` logs
  and proceeds), so a supported legacy sidecar can name a parent absent
  from the registry — the import verifies the edge and writes NULL with a
  `warn` instead of aborting on the FK. Plus, `GoalStore`'s durable goal
  records move into `goals` rows
  (§2 narrowing). **Goal sources are per-host and one of them is not a
  file this importer can see:** the CLI persists goals in the bucket
  `state.json`, and the extension persists them in VS Code's
  `context.workspaceState` Memento (`workspaceSM` via `stateManager.ts` —
  the `state.vscdb` VS Code owns). Goal import therefore runs **per
  released host with legacy state** — CLI and extension each extract from
  their own legacy source at first migrated open, upserting by stream with
  one deterministic merge rule: newest `updatedAt` wins; equal timestamps
  resolve by fixed source priority (extension over CLI — arbitrary but
  stable), then by value-hash order as the final tie-breaker. "Ties keep
  the existing row" would be order-dependent across hosts: whichever host
  opened first would win, making otherwise identical upgrades diverge. **Desktop gets no legacy extraction path** — it has no
  released state to preserve, and repository policy is that unreleased
  hosts adopt the current format directly (AGENTS.md compatibility rule).
  **Orphan goals are quarantined, not imported:** a legacy goal naming a
  stream absent from the Stage-2 registry (a failed best-effort cleanup, or
  the unregistered-goal path) has no FK parent — the importer logs it at
  `warn` and records it in `migration_records`
  (`source = 'goal-quarantine'`, §3.3) rather than failing the migration on
  an FK violation. The
  importer **never mutates the legacy source during the compat window**
  (see §6's ledger scheme); one final absorb clears it when the window
  closes. Legacy goal reads retire then, not at Stage 3.
- **Stage 4 — transcript entries → rows.** `StreamLogStore` engine swap;
  clobber machinery deletes; partial hydration lands. Gate: a benchmark PR
  proving the 300 ms batched-transaction path sustains streaming append load
  (~200 mutations/s) with headroom.
- **Stage 5 — execution records → rows.** `ExecutionKVStore` and
  flow-checkpoint persistence (`executions/{id}/*.json`: reports, results,
  workspace-file lists, turn state, child records, generic keys,
  checkpoints) move into `execution_records`; the KV layer retires here.
  **This deliberately precedes the deletion-protocol cutover**: while these
  records live in files, "delete a stream" cannot be one transaction — it
  would still need fallible filesystem cleanup, i.e. exactly the
  half-deletion/compensation problem the next stage claims to remove.
  **The cutover is file-level, not a directory rename:** KV JSON and
  user-facing artifacts coexist under `executions/{id}/` today — renaming
  the tree would hide live documents at a backup path, while leaving it
  unrenamed would break the rename-based backstop. Stage 5 therefore
  imports and deletes the KV `*.json` files individually (copies to the
  versioned backup tree), leaves the artifacts in place, and detects
  legacy recreations **per file**. The KV filename set is **not** assumable
  as fixed: `ExecutionKVStore.write()` takes arbitrary keys, and production
  registries persist keys (`codex_thread_id.json`,
  `claude_agent_session_id.json`) that today's `isKVFile` does not even
  recognize — a filename-list classifier would either lose resumable
  session state or delete user JSON. Stage 5 therefore opens with a
  boundary PR: artifacts move under the stable `files/` subtree, and KV
  writes are constrained to a manifest (known keys + one namespaced prefix
  for generic keys). After that, **root-level `*.json` is app state by
  construction**; anything at the root the manifest cannot classify is
  quarantined in `migration_records` with a `warn`, never deleted.
  **Non-KV artifacts under `executions/{id}/` stay as files**: workflow
  output files and original snapshots are run _documents_ — read by
  `AcceptRunFilesTool` and `ExecutionsTool.listFiles`, reviewed and accepted
  by the user — so they fall under the §2 documents clause, live in a
  per-execution artifacts area on the permanent allowlist, and are removed
  by the same file sweeper that handles exports when their execution row
  is deleted.
- **Stage 6 — leases/locks → rows (final migration stage).** Cutover to the
  `execution_leases` table and its CAS protocol (§3.3). Positioned after
  every **data** migration (Stages 2–5) so the legacy lease files remain
  the liveness signal the importer's quiesce check reads (§6 mixed-version
  fencing) — and positioned **before** the deletion-protocol cutover,
  deliberately: today's deletion runs under
  `runWithInactiveExecutionLease`'s filesystem lock, and a bare row
  transaction cannot replace that guard while leases are still files. Once
  leases are rows, the delete transaction itself checks the lease row —
  the guard and the delete become one atomic unit.
- **Stage 7 — deletion protocol: incarnation + tombstone fence.** With
  every app-state datum **including leases** in rows, this stage lands the
  one-transaction deletion for real: hard-delete + same-transaction
  `stream_tombstones` insert (§3.3), the incarnation compare-and-set
  (lease row checked in the same transaction, replacing
  `runWithInactiveExecutionLease`), and the fact-admission gate in
  `SessionFactApplier` (the reducer owns admission; `SessionEventHub`
  stays fan-out only) — collapsing #10702's machinery. Record the identity
  ruling: **stream ids are never reused** — a workflow relaunch mints a
  fresh id; the deterministic slot maps to the current id.
- **Stage 8 — feature payoffs.** FTS5, retention policy, usage analytics.

Ordering with other programs: independent of Waves A–C (different band, no
shared PRs); #10774 (settled ⇒ immutable) should land before Stage 4 so the
bounded-write-set property holds from the first row written; #10775's spill
files become unnecessary once entries are bounded rows (amend that issue at
Stage 4).

## 6. Risks and mitigations

- **Corruption blast radius** (one DB vs per-stream files): bounded per
  workspace; integrity checks on recovery paths and periodic maintenance
  only (per §3.1 — never per-open); degradation via the database-wide
  degraded mode (§3.1 — the transcript-only `openOrEphemeral` generalizes;
  one open failure, one loud decision covering every store, resume
  disabled); `VACUUM INTO` backups; the migration's renamed
  `*.pre-sqlite-backup` dirs are retained per the §5 retirement condition.
- **`node:sqlite` maturity/flags**: Stage 0 gate; `better-sqlite3` fallback
  accepted with its packaging cost named.
- **Hot-path throughput**: Stage 4 benchmark gate before the swap ships.
- **The opencode trap** (the failure mode this PRD's survey documents):
  transactions are confined **inside store methods**. No ambient transaction
  context, no post-commit effect queues, no transaction types in app-level
  signatures, and the session event plane is untouched. A PR introducing a
  transaction parameter outside `src/transcript/` + `src/agent/storage/` is
  a review reject.
- **Migration failure and rollback policy**: migrate-on-open is idempotent
  per store; a migration that fails **at open, before any new write**, rolls
  back by reverting the release and restoring the renamed dir. But once a
  migrated release has been _used_ — appends, deletions, goal changes
  committed to rows only — restoring the backup would silently discard that
  work, so **rollback is forward-only after first post-migration use**: fix
  in place on the migrated release; the backups exist for failed-migration
  recovery and the guaranteed import window, not as a downgrade path. (A
  reverse row→file exporter is deliberately not built — it would be dual
  ownership with a delay, the exact §5 ban.) Rows-or-files, never both.
- **Mixed-version hosts during migration** (an old file-backed CLI and a
  migrated extension sharing one workspace): WAL fences database
  connections, not legacy filesystem writers — and no _new_ lock can be
  honored by _old_ code. The per-execution locks are also too narrow: they
  fence only `ExecutionKVStore` mutations, not transcript or `streamData`
  writers. Honest mitigation, three parts:
  (1) **Quiesce check, not lock:** before migrating, the importer reads the
  legacy lease files (`executionLeases/`) — artifacts old hosts already
  maintain and new code can inspect — and **defers migration while any live
  legacy execution is present**; leases staying file-based until Stage 6 is
  what keeps this signal readable (why leases/locks migrate after every
  data migration).
  (2) **A workspace-scoped migration fence between new hosts** (one
  marker/lock the importer holds), so two migrated hosts cannot
  double-import concurrently.
  (3) **Re-entrant idempotent import as the backstop** for the case no fence
  can cover (a legacy host that starts writing mid-import): every open that
  finds recreated legacy dirs re-imports and re-renames them — **to
  versioned destinations** (`*.pre-sqlite-backup-N`, monotonic suffix): the
  first backup occupies the unversioned name, so an unversioned re-rename
  would collide with a nonempty directory and strand the backstop; the
  retirement PR deletes every versioned backup together — and the §5
  post-rename verification pass folds writes that landed inside the
  read-and-rename interval itself, so late legacy writes are absorbed
  rather than lost. **Reconciliation is by entry id, never by seq:** a
  legacy host rewrites whole arrays and allocates seqNos from its own
  resident copy, so a blind seq-keyed upsert against `UNIQUE(stream_id,
seq)` would drop or overwrite one side when both hosts wrote the same
  stream. The importer instead inserts entries whose `entry_id` is not yet
  present, assigning fresh seqs after the row-side head — the same union
  semantics as today's merge-disk-under-live-appends — and emits the
  existing `reset: true` delta so fold consumers resync. **Every re-import
  checks `stream_tombstones` first:** after Stage 7, a legacy host can
  recreate files for a stream already deleted in SQL, and admitting them
  would either fail the entry FK or resurrect a fenced id against the
  never-reuse ruling — data for tombstoned ids is quarantined in
  `migration_records` (`source = 'tombstoned-reimport'`) with a `warn`,
  never imported. **A matching
  `entry_id` is reconciled, not assumed unchanged:** a legacy host may have
  appended text to or settled an entry after the importer copied it, so
  per-id the rule is settlement-monotonic — a settled copy supersedes an
  unsettled row, and between two unsettled copies the one with more
  accumulated text wins; only when the row side has a live writer for that
  stream does the writer's version win outright (single-writer authority is
  the existing invariant). Concurrent mixed-version access during the
  window remains documented as unsupported — this reconciliation makes late
  writes best-effort-absorbed rather than silently dropped; old-host reads
  may be stale until it upgrades.
  **Goals need their own reconciliation lane, and it must see deletions:**
  the dir-based backstop cannot cover goals, because goal keys live inside
  the permanent `state.json` (and the extension's Memento), which is never
  renamed — a legacy host mutating **or forgetting** a goal after Stage 3
  recreates no detectable legacy directory, and an absent key carries no
  timestamp to compare. The scheme is therefore a **read-only ledger diff**:
  the importer never mutates the legacy source during the window; instead
  it keeps an absorbed-keys ledger in rows (`migration_records`, **keyed by
  `(legacy source, key)`** — the CLI's `state.json` and the extension's
  Memento are separate sources with separate ledgers) and, on every
  migrated open, diffs that host's legacy source against **that source's
  ledger only** — key present with a value hash different from that source's
  last-absorbed ledger hash → update the row and ledger; key present with the
  same hash → skip, even if another source has since deleted the canonical row,
  so an unchanged stale copy cannot resurrect it; key present in
  the same source's ledger but **absent from that source → that host
  deleted it → delete the row, but only if the canonical row still matches
  that source's last absorbed value hash** (the ledger stores it) — if a
  migrated host or another source has since written a newer goal, a stale
  copy's absence must not erase it, so the deletion is skipped and the
  ledger entry retired; key absent from both → nothing. Scoping
  absence per source is load-bearing: the extension absorbing a goal must
  not let a later CLI open — whose `state.json` never carried the key —
  read "ledger present, source absent" and delete a goal the CLI never
  owned. Leaving the legacy sources untouched is what makes absence
  unambiguous. One final absorb clears each source and its ledger together
  when the compat window closes.
- **Scope creep toward SQL-as-UI-state**: §8 non-goals; the architecture
  test only allowlists the two stores' modules for DB access.

## 7. Invariants preserved (and one added)

Single-writer transcript authority (`TranscriptWriter`); the
delta/emission contract and `StreamLog` in-memory model; #9434 derived-tier
discard-and-rebuild; the loud-degradation rule (strengthened: `NOT NULL` /
`CHECK` / FK constraints reject corrupt writes at the source); frozen store
public surfaces (`store-public-surface-baseline`); hosts-as-renderers plane
rules untouched. **Added:** the §2 rule, pinned by a new architecture test.
The test lands at Stage 1 as a **shrinking ratchet, not a strict gate**: it
starts with an explicit allowlist of the not-yet-migrated directories
(`streamLogSummaries/`, `streamData/`, `streamData.deleting/`, `taskRuns/` — the staged-
deletion namespace `StagedDeletionCoordinator` renames into, retained in
the baseline through the **Stage-7** deletion-protocol cutover that retires
the coordinator — `streamLogs/`, `executions/` KV records, lease/lock
files) plus the **permanent entries**: documents,
exports, the SQLite engine file family (`texra.db`, `texra.db-wal`,
`texra.db-shm` — WAL mode creates the companions beside the database
whenever it is open; a layout test rejecting them would reject every
active workspace), the settings files (`state.json`, `config.json`), the
per-execution artifacts area (§5 Stage 5), the user-media caches
(`pasted/` from `savePastedImageBuffer`, `recordings/` from the audio
tool — live writers today that the ratchet must not reject), and
`_workspace.json` — the bucket→workspace identity sidecar
`WorkspaceStorageProvider.getStoragePath()` writes before any store (and
therefore the database) can open; it cannot live in the DB it locates, so
it must be in the initial baseline (a ratchet can only shrink — omitting it
at Stage 1 could not be repaired later without widening). Here
"documents" and "exports" are architecture-test categories rather than
additional top-level layout names: documents materialize as `original/` and
`memories/`, while archived traces and chat exports live in the per-execution
artifacts area named below. Each migration stage removes its directory from
the baseline in the same PR — the same
only-shrinks discipline as `host-agent-import-baseline`. A Stage-1-strict
test would fail CI by construction while Stages 2–6 still write files.
After Stage 6 one **temporary** entry remains alongside the permanent set:
`*.pre-sqlite-backup`, which the §5 retirement window requires for 90 days
and two releases — the importer-removal PR deletes the backups and this
ratchet entry together. Strict (permanent entries only) is that removal
PR's exit criterion, not Stage 6's — and strictness is additionally
conditional on legacy `taskRuns/` having drained under #6981's own
retirement condition, which is independent of the importer window: if the
importer retires first, `taskRuns/` remains a shrinking temporary entry
until #6981 removes it, never a re-widen.

## 8. Non-goals

No SQL as source of truth for UI state; no Effect or any framework buy-in;
no wire/protocol change (storage layer only); no cross-workspace global
database; no CRDT/sync layer (the schema does not preclude one later); no
normalization of entry payload internals; no publication of this doc
(internal `docs/prds/`, excluded by `publicDocs.js`).

## 9. Acceptance

- Opening the measured 1,923-stream workspace performs O(visible page) reads.
- Deleting a stream is one transaction; no state holder can observe a
  half-deleted stream; #10702's regression suite passes against the column
  mechanism.
- Kill -9 during streaming loses at most the current throttle window; the
  recovery sweep finalizes orphans from an indexed query.
- All ratchets green; no store public-surface change; Waves A–C unaffected.
- `WORKSPACE_STORAGE_LAYOUT` shrinks to the §7 permanent set —
  `{ texra.db, texra.db-wal, texra.db-shm, original, memories, state.json,
config.json, _workspace.json, pasted, recordings }` plus the per-execution
  artifacts
  area (§5 Stage 5) — and legacy `taskRuns/` until #6981 retention drains
  it (§3.1 exception). The §7 `exports` allowlist entry is a category for
  caller-chosen destinations outside the workspace-storage bucket, not a
  `WORKSPACE_STORAGE_LAYOUT` key. §7 and this criterion therefore enumerate
  the same bucket set by construction; a divergence between the two lists is
  itself a defect.

## 10. Open questions

1. Drizzle vs Kysely — decide in Stage 1 with a one-page comparison on the
   actual schema, not in the abstract.
2. Are `memories/` user-editable documents (stay files) or app state (rows)?
   Owner call.
3. Within Stage 5, the ordering of execution-record sub-migrations (reports
   vs turn state vs flow checkpoints) — an in-stage sequencing detail; the
   stage assignment itself is settled (§5).
4. Retention defaults (age? size cap per workspace?) once Stage 8 makes
   policy one statement.
