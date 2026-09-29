# The 1.0 storage design

Date: 2026-09-28

Status: proposed. It decides; the owner ruled on every open question on
2026-09-28 (§13), and the sections below carry those rulings.

Audit baseline: `origin/main` `f8bc3d8ec8`. The evidence comes from two audits
of 2026-09-28: history across upgrades, at `fddcc097a8`, and SQL layer
health, at `d5c919817b`. Each load-bearing claim below was re-read on the
baseline.

Owner ruling (2026-09-28): "we really should have the cleanest design before
v1.0 because I don't want to rewrite this again."

## Summary

This is the last format change the session store takes before 1.0. After it,
the store changes by adding row versions, not by moving whole stores aside.
The design does five things:

- **One row codec** is the only code that knows a stored shape.
- **Per-kind row versions**, with adjacent upcasters, replace the single
  store-wide `SESSION_EVENT_FORMAT` stamp.
- **Pure TypeScript projectors** maintain the display and listing tables
  inside the append transaction. They replace the SQL that reads payload JSON.
- **A store-wide content-addressed `blob` table** replaces the per-run blob
  copies.
- **The store shrinks.** It uses incremental vacuum, a WAL limit, and
  garbage collection of aside copies and orphaned stores.

One physical bump, to `SCHEMA_VERSION` 100, carries all of it.

### What gets deleted or collapsed

| Deleted or collapsed                                                                                                                                                  | Where today                                                           | Replaced by                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `SESSION_EVENT_FORMAT` (now 44), and moving the whole store aside on every vocabulary change                                                                          | `sessionEvent.ts:546`, `storeFormat.ts:42-104`                        | per-kind versions (§3); a physical `SCHEMA_VERSION` that changes only with DDL |
| 24 `json_extract` payload reads, plus the `event_snapshot_model` expression index                                                                                     | `displayProjection.ts`, `storeFormat.ts:240-242`                      | projection tables written by pure projectors (§5)                              |
| 3 `json_extract` reads of the aggregate key                                                                                                                           | `Database.ts:111,301,304`                                             | `kind` and `logical_id` columns (§2)                                           |
| 30 hard-coded `'<type>.1'` literals and `StoredTypeSchema`                                                                                                            | `Database.ts` (12), `displayProjection.ts` (17), `storeFormat.ts` (1) | a `version` column, read only by the codec                                     |
| SQL that restates fold logic: `LISTING_GROUP`, the two pending-set `NOT EXISTS` blocks, `USAGE_ROWS`, `MODEL_ROWS`, `LATEST_MODEL_ROWS`, `RUN_USAGE`, `totalRunUsage` | `displayProjection.ts` (235 lines, the whole file)                    | `listingKeyOf` / `pendingKeyOf`, run in TypeScript by the projector            |
| the hand-written `inputTypes` list                                                                                                                                    | `Database.ts:360-367`                                                 | derived from `listingTypeOf`                                                   |
| three copies of the display union and three copies of the tombstone predicate                                                                                         | `Database.ts:317,350,368`; `:505,508,514`                             | one union helper; one `closed_by` column                                       |
| the `event_agg_commit` index                                                                                                                                          | `storeFormat.ts:238`                                                  | nothing (no query needs it)                                                    |
| per-run `context.blob` copies: 50–65% of blob bytes are duplicates, and blobs are 73–79% of the data                                                                  | `requestContext.ts:93-110`                                            | the store-wide `blob` table, collected by reachability                         |
| throw-on-bad-row, where one row fails the whole listing                                                                                                               | `Database.ts:126-156`                                                 | a `Blocked` or `Corrupt` verdict per aggregate                                 |
| `packages/llm`'s authority over the stored `model.message` shape                                                                                                      | `runLedgerEvent.ts:20-26,168`                                         | a storage-owned `StoredTurn` (§4)                                              |
| the second copy of every tool output (`tool.end.result` beside `tool.result`)                                                                                         | `toolUseDispatch.ts:344-358`                                          | the card's output projected at read time (§10)                                 |
| `appStateChanges.ts` as a separate file                                                                                                                               | 61 lines                                                              | merged into its owner, `currentValues.ts`                                      |
| aside copies that are never deleted; 95% free pages; 4 MB WAL files that stay                                                                                         | the store directory                                                   | §7                                                                             |

The additions come last:

- two small bookkeeping tables, `stored_kind` and `projection_state`;
- four projection tables;
- the `blob` table;
- one codec module and one version registry.

## 1. Layers and owners

```
 readers          SessionView fold · RunState fold · plugin readers · history query store
                          ▲ decoded SessionEvent / verdicts only
 folds &          sessionFold · runStateFold · transcriptFold      (read payloads; never SQL)
 projections      projectors (listing, usage, model)               (pure TS over decoded events)
                          ▲
 ledger &         SessionEvents inbox (one publisher) → RunLedger → Database.appendAll
 publisher        (seq, commit, claims, lifecycle edges, executes projector ops)
                          ▲ typed drafts in, typed events out
 row codec        rowCodec.ts + rowVersions.ts                     (the only stored-shape knowledge)
                          ▲ column tuples
 physical store   storeSchema.ts: DDL, PRAGMAs, SCHEMA_VERSION runner, housekeeping
                  SQLite file (WAL)
```

| Layer              | Module (under `src/controllers/session/` unless noted)                                                | May know                                                                                                                             | Must not know                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Physical store     | `storeSchema.ts` (was `storeFormat.ts`)                                                               | tables, columns, indexes, PRAGMAs, `SCHEMA_VERSION`, file moves                                                                      | any payload field; any row kind                                  |
| Row codec          | `rowCodec.ts`; the registry and upcasters in `src/shared/schemas/rowVersions.ts`                      | `type` and `version` columns, the `data` JSON layout, blob externalization, the (kind, logical id) ↔ `AggregateId` mapping, verdicts | SQL; fold semantics                                              |
| Ledger / publisher | `Database.ts` (the one writer), `src/agent/runtime/SessionEvents.ts` (the one publisher), `RunLedger` | envelopes (seq, commit, origin, at), claims, aggregate lifecycle edges, transactions                                                 | stored shapes: it hands drafts to the codec and gets events back |
| Projections        | `projections.ts` (replaces `displayProjection.ts`)                                                    | its own tables and version; `listingKeyOf`, `pendingKeyOf`, `sumUsageStats`                                                          | `event.data`: it reads decoded events only                       |
| Folds              | `src/shared/session/{sessionFold,runStateFold,transcriptFold}.ts`                                     | payload fields                                                                                                                       | columns, versions, SQL                                           |
| Current values     | `currentValues.ts` (new; absorbs `appStateChanges.ts` and the `values` half of `Database.ts`)         | `current_value`, `input_history`, family schemas and their versions                                                                  | events                                                           |

**Two invariants.** Nothing above the codec sees a stored shape: no
`'<type>.<N>'` string, no integer aggregate id, no `data` text, no `blob`
column. Nothing below the codec reads a payload field: no SQL JSON function
touches `event.data`, `blob.value`, `current_value.value`, or a projection's
data.

Two ratchets enforce them:

- **`src/test-kernel/architecture/storedShapeBoundary.vitest.ts` (new).**
  - In production files, the only SQLite JSON function allowed is
    `json_each(?)` over a bound parameter. `json_extract`, `json_type`,
    `json_patch`, `json_object`, `json_group_array`, `->` and `->>` are
    refused.
  - No string literal of the form `'<kind>.<digit>'` appears anywhere.
  - Only `rowCodec.ts` selects the `version` column or imports the upcasters.
  - Exempt by name, with its reason: the history query store
    (`src/agent/runtime/historyQuery/`). It is a separate `:memory:`
    database built from decoded display rows. Its `json_extract` views are
    a query contract offered to the model, not reads of the session store.
    The write ratchet already exempts it the same way.
- **`persistenceWriteBoundary.vitest.ts` (extended).**
  - Its write regex extends from `event|event_sequence` to every ledger
    table: `blob`, `stored_kind`, `projection_state`, and the four
    projection tables. `Database.ts` stays the single writer.
  - `current_value` and `input_history` get their own single writer,
    `currentValues.ts`. Today no ratchet covers them.

Both changes narrow the ratchets; neither widens one.

## 2. Physical schema, final for 1.0

### Decisions

- **Aggregate identity.** `event_sequence` gets a local integer surrogate,
  `id`, plus two real columns, `kind` and `logical_id`, with
  `UNIQUE (kind, logical_id)`. `event` and the projections reference `id`.
  The codec composes the canonical `AggregateId` string from the two
  columns, so above the codec nothing changes.
  - This removes the three `json_extract` calls on the key.
  - It removes a ~50-byte JSON key repeated in every event row and three
    indexes.
  - Deletion's `kind = 'run'` filter becomes a plain comparison.
  - Aggregate lists bind as two parallel `json_each(?)` arrays (kinds,
    logical ids), joined on the array index.
  - `kind` gets no `CHECK` enumeration: SQLite can change a `CHECK` only by
    rebuilding the table, and a new aggregate kind should cost a codec
    entry, not a physical bump.
  - Alternative: keep the JSON text key with a `CHECK (json_valid(...))`.
    Rejected, because SQL would still parse it and it would still be
    canonical only by Zod.
- **No promoted `key` column on `event`.** The listing is the only reader
  that needs a per-row key. It gets a projection table, `listing_entry`,
  keyed by `listingKeyOf`, the fold's own function. A `key` column would put
  the listing-key rule into SQL a second time.
- **`type` and `version` are separate columns.** Type filters then never
  enumerate versions.
  - Alternative: opencode's single `type.vN` text. Rejected, because every
    `IN (...)` would have to list every version.
- **`uid` is not stamped into the first row.** It stays a column of
  `event_sequence`, which cascades with the events in the same file.
  Copying it into `run.start` would give it two sources of truth. A child's
  `run.start.parent.uid` is already the one cross-aggregate reference.
  - Alternative: stamp it for a future export or sync. Rejected until an
    export exists; the aggregate row would travel with its events.
- **Lifecycle facts become columns.** `closed_by` (the tombstone's commit,
  `NULL` while open) replaces the `closed` flag and the three tombstone
  subqueries. `start_commit` (the commit of seq 1) replaces the correlated
  subquery in `READ_STATE`. The transaction that writes those rows sets
  both.

### DDL

```sql
-- New files only: auto_vacuum must be set before the first table exists.
PRAGMA auto_vacuum = INCREMENTAL;
PRAGMA application_id = 1415927890;   -- 0x54655852 'TeXR': identifies a TeXRA store
PRAGMA user_version = 100;            -- SCHEMA_VERSION

CREATE TABLE event_sequence (
  id           INTEGER PRIMARY KEY,           -- local surrogate; never leaves the file
  kind         TEXT NOT NULL CHECK (kind <> ''),
  logical_id   TEXT NOT NULL CHECK (logical_id <> ''),
  uid          TEXT NOT NULL UNIQUE,          -- durable identity across machines and incarnations
  seq          INTEGER NOT NULL CHECK (seq >= 1),
  start_commit INTEGER,                       -- commit of seq 1, set in the creating transaction
  owner_id     TEXT,                          -- the claim (C5)
  parent_id    INTEGER REFERENCES event_sequence(id) ON DELETE CASCADE,
  closed_by    INTEGER,                       -- the tombstone's commit; NULL while open
  UNIQUE (kind, logical_id)
) STRICT;

CREATE TABLE blob (
  digest TEXT PRIMARY KEY CHECK (length(digest) = 64),  -- sha256 of the canonical JSON
  value  TEXT NOT NULL
) STRICT;

CREATE TABLE event (
  "commit"  INTEGER PRIMARY KEY AUTOINCREMENT,          -- local cursor
  aggregate INTEGER NOT NULL REFERENCES event_sequence(id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  type      TEXT NOT NULL,
  version   INTEGER NOT NULL CHECK (version >= 1),
  origin    TEXT NOT NULL,
  at        INTEGER NOT NULL,
  data      TEXT NOT NULL,
  blob      TEXT REFERENCES blob(digest),               -- set only on context.blob rows
  UNIQUE (aggregate, seq)
) STRICT;

-- The highest version of each row kind ever written here (§3, blocking).
CREATE TABLE stored_kind (
  type    TEXT PRIMARY KEY,
  version INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE projection_state (
  name           TEXT PRIMARY KEY,
  version        INTEGER NOT NULL,
  through_commit INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- Display rows no run stores (`usage` per priced turn, `run.model` per switch),
-- each on its source row's envelope.
CREATE TABLE projected_row (
  "commit" INTEGER NOT NULL REFERENCES event("commit") ON DELETE CASCADE,
  type     TEXT NOT NULL,
  data     TEXT NOT NULL,
  PRIMARY KEY ("commit", type)
) STRICT, WITHOUT ROWID;

-- Per aggregate and listing key, the row a cold listing delivers. Open
-- requests and queued follow-ups are keys of their own, deleted when closed.
CREATE TABLE listing_entry (
  aggregate INTEGER NOT NULL REFERENCES event_sequence(id) ON DELETE CASCADE,
  key       TEXT NOT NULL,
  "commit"  INTEGER NOT NULL,
  PRIMARY KEY (aggregate, key)
) STRICT, WITHOUT ROWID;

CREATE TABLE run_usage (
  aggregate INTEGER PRIMARY KEY REFERENCES event_sequence(id) ON DELETE CASCADE,
  "commit"  INTEGER NOT NULL,                 -- newest priced row: the listing row's envelope
  usage     TEXT NOT NULL                     -- the run's spend, summed by sumUsageStats
) STRICT;

CREATE TABLE run_model (
  aggregate INTEGER PRIMARY KEY REFERENCES event_sequence(id) ON DELETE CASCADE,
  model     TEXT NOT NULL,                    -- latest snapshot's model: the next switch's baseline
  "commit"  INTEGER                           -- latest switch; NULL if the run never switched
) STRICT;

CREATE TABLE current_value (
  family  TEXT NOT NULL,
  key     TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  value   TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (family, key)
) STRICT, WITHOUT ROWID;

CREATE TABLE input_history (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  at    INTEGER NOT NULL,
  value TEXT NOT NULL
) STRICT;

CREATE INDEX event_sequence_parent ON event_sequence(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX event_aggregate_type  ON event(aggregate, type, seq);
CREATE INDEX event_type_commit     ON event(type, "commit");
CREATE INDEX event_blob            ON event(blob) WHERE blob IS NOT NULL;
CREATE INDEX current_value_at      ON current_value(family, at);
```

### Indexes, each justified by a named query

| Index                                                                      | Query it serves                                                                                                                                       |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event` PK (`commit`)                                                      | `readAll` and every tail read by commit range; joins from `listing_entry`, `projected_row` and `run_usage`                                            |
| `UNIQUE (aggregate, seq)`                                                  | `readAggregate(id, fromSeq)`, `readDisplayAggregate`, `readInputBatch`'s per-id arm; seq density; the FK child index for `event.aggregate`            |
| `event_aggregate_type`                                                     | `readAggregate` with types (`typedRows`), `readRunSnapshot` (latest snapshot), the latest inquiry row inside the inquiry transition                   |
| `event_type_commit`                                                        | `readDisplay` and `readInputBatch` tails (`type IN … AND commit range`), `readPendingDeletions` (`type = 'run.removed'`), projection catch-up by kind |
| `event_blob` (partial)                                                     | blob reachability after a collection; the FK check when a blob is deleted                                                                             |
| `event_sequence_parent` (partial)                                          | the recursive `dependents` CTE (deletion, closure); the FK child index for `parent_id`                                                                |
| `UNIQUE (kind, logical_id)`                                                | every lookup of an `AggregateId`                                                                                                                      |
| `current_value_at`                                                         | `values.list(family)`, ordered by `at DESC`                                                                                                           |
| primary keys of `listing_entry`, `projected_row`, `run_usage`, `run_model` | the listing read, display reads, and the projector's read-modify-write; each is also the table's FK child index                                       |

Dropped: `event_agg_commit`, which no query in this design needs, and
`event_snapshot_model`, whose job `run_model` now does.

### PRAGMAs

| PRAGMA               | Value                                    | Why                                                                                                                                                                                                                              |
| -------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `busy_timeout`       | 5000 at open, then 25                    | The 5 s value must be set before WAL is enabled: at zero the spike lost 26–55% of appends (`Database.ts:1240-1245`). After configure, a 25 ms slice plus the Effect retry in §8 replaces the patience without freezing the host. |
| `journal_mode`       | `WAL` (persistent), `MEMORY` (ephemeral) | unchanged                                                                                                                                                                                                                        |
| `synchronous`        | `NORMAL`                                 | WAL-safe. The spike measured `FULL` at 1.4–1.8× the cost, and `kill -9` lost nothing.                                                                                                                                            |
| `foreign_keys`       | `ON`                                     | the cascades are the collection mechanism                                                                                                                                                                                        |
| `auto_vacuum`        | `INCREMENTAL`                            | set at creation; a retired pre-1.0 file gets one `VACUUM` when empty (§3)                                                                                                                                                        |
| `journal_size_limit` | 1048576                                  | truncates the WAL to 1 MiB after a checkpoint reset (today it stays at about 4 MB)                                                                                                                                               |
| `application_id`     | `0x54655852` (`TeXR`)                    | distinguishes a TeXRA store from a foreign SQLite file before anything is touched                                                                                                                                                |
| `user_version`       | `SCHEMA_VERSION`                         | §3                                                                                                                                                                                                                               |

## 3. Versioning

### Physical: `SCHEMA_VERSION` in `user_version`

`SCHEMA_VERSION` names the DDL, not the vocabulary.

- **Numbering.** It starts at **100**. Any stamp from 1 to 99 is a pre-1.0
  `SESSION_EVENT_FORMAT`, so the two numbering schemes cannot collide.
- **When it bumps.** Only for a change an older build cannot write around: a
  column change or a table rebuild. An additive index or projection table is
  `CREATE … IF NOT EXISTS` and bumps nothing, because projections carry
  their own versions.
- **The runner.** It is forward-only, about 40 lines in `storeSchema.ts`:
  an array of steps, `{from, foreignKeysOff, statements}`.
  - A store newer than the build is refused untouched.
  - The runner never goes down.

**Open sequence** (`storeSchema.open`, called once by `databaseLayer`):

1. Resolve the local path with `localDatabasePath` and create the directory.
2. `SqliteClient.make({ busyTimeout: '5 seconds' })`. Set `foreign_keys=ON`
   and `synchronous=NORMAL`, and verify `journal_mode=wal`.
   - If SQLite reports `SQLITE_NOTADB` or `SQLITE_CORRUPT` here, close the
     connection and move `texra.db`, `-wal` and `-shm` aside to
     `texra.db.corrupt-<stamp>`.
   - Open fresh and report `movedAside { reason: 'corrupt' }` (§7).
3. Read `application_id`.
   - If it is neither 0 nor TeXRA's, refuse: the file is foreign.
4. Read `user_version` (`v`).
   - `v > SCHEMA_VERSION`: refuse, with nothing touched (`DatabaseOpenFailed`,
     reason `newer`).
   - `v` from 1 to 99 (pre-1.0): start fully clean (owner ruling Q3). Nothing
     in the store is kept, `current_value` and `input_history` included.
     Retire it with `retireStore`'s existing pattern:
     - `VACUUM INTO` a staged copy.
     - `BEGIN IMMEDIATE`, then re-read `user_version` and `data_version`
       under the lock. If either moved, discard the copy and start over.
     - Rename the copy to `texra.db.pre1`.
     - Drop every table, set `user_version = 0`, `COMMIT`.
     - Run `PRAGMA auto_vacuum = INCREMENTAL; VACUUM` once, outside the
       transaction. The file is empty now, so this is cheap, and it gives
       the file the 1.0 header.
     - Continue as a new store (the next case).

     No pre-1.0 table is altered or read, so this path needs no knowledge of
     any earlier format.

   - `v = 0` with no tables: create the store.
     - `auto_vacuum` first.
     - Then `BEGIN IMMEDIATE`, re-read `user_version`, and, if it is still
       0, apply the DDL and stamp `application_id` and `SCHEMA_VERSION`.
     - Of two processes creating at once, the second sees 100 and does
       nothing.
   - `100 ≤ v < SCHEMA_VERSION`: back up with `VACUUM INTO texra.db.schema<v>`
     under the same re-read pattern.
     - Set `PRAGMA foreign_keys = OFF` if any step needs it. The PRAGMA is
       a no-op inside a transaction, so it is set before `BEGIN`.
     - `BEGIN IMMEDIATE`, re-read `v`, and run the steps from `v`.
     - Run `PRAGMA foreign_key_check`: any row fails the step.
     - Stamp, `COMMIT`, then set `foreign_keys = ON`.
5. `CREATE … IF NOT EXISTS` every additive index and projection table.
6. Set `busy_timeout` to 25 ms (§8).
7. Read `stored_kind` into the blocked-kind set (below). Projections are
   checked lazily, at their first read (§5).
8. Start the `data_version` poll. Fork housekeeping (§7) on the scope. It is
   non-blocking.

`assertStoreFormat` stays in every write transaction and now compares
against `SCHEMA_VERSION`. It costs one PRAGMA.

**Why not Effect's `Migrator`** (`effect/unstable/sql/Migrator`)? It fails
four ways here:

- it accepts a database newer than its migrations;
- it downgrades a `Locked` race to a debug log;
- it turns a failed migration into a defect;
- it cannot set `PRAGMA foreign_keys = OFF` outside its transaction.

It also keeps its own migrations table, which would be a second record of
the version next to `user_version`.

### Per-kind row versions

`src/shared/schemas/rowVersions.ts` is the registry:

```ts
export const ROW_KINDS = {
  'run.start': { version: 1, upcast: [] },
  'model.message': { version: 1, upcast: [] },
  'context.blob': { version: 1, upcast: [], blob: 'payload' },
  // … one entry per arm
} as const satisfies Record<SessionEventDraft['type'], RowKind>;
```

- **Exhaustive by type.** A new arm without an entry does not compile.
- **Upcasters.** `upcast[i]` maps version `i + 1` to `i + 2` over plain
  JSON. Adjacent steps only; there is never a jump.
- **Decode.** The codec reads `(type, version, data)`.
  - A lower version is upcast step by step, then parsed with the current
    arm.
  - The current version is parsed directly.
  - A higher version, or a type the registry lacks, yields a `Blocked`
    verdict.
  - A known version that fails its schema yields `Corrupt`.
- **Write.** Rows are always written at the current version. The codec
  upserts `stored_kind` with `max(version)` in the same transaction, once
  per distinct type in the batch.

`RELEASED_ROW_VERSIONS`, in the same file, is the **release watermark**: the
version of each kind in the last released build.

- A kind whose current version is above the watermark is unreleased. Its
  schema may change freely, with no upcaster and no bump, until the next
  release freezes it.
- Before 1.0 ships, every kind is unreleased. So Lanes 2–4 (§12) change row
  shapes without a physical bump.
- A dev store holding a churned unreleased row shows that run as `Corrupt`.
  That is the accepted cost; `texra doctor --prune-storage` or deleting the
  file resets it.

**Per-kind fingerprints and frozen schemas** replace the single
`sessionEventFormat.vitest.ts` snapshot.

- At release, `npm run storage:freeze` (a step in the `releasing` skill)
  does three things:
  - writes `z.toJSONSchema` of each kind's current arm to
    `config/storage/frozen/<type>.v<N>.json`;
  - writes `config/storage/frozen/current-value.<family>.v<N>.json` for each
    current-value family;
  - moves the watermark.
- `src/test-kernel/schemas/rowVersions.vitest.ts` fails when:
  - a released version's schema differs from its frozen file;
  - a kind's current version is below its released one;
  - a released version has no upcaster chain to the current one.
- Neither of these files is a new data format: they are test fixtures in
  JSON Schema.

**Blocking.** A newer or unknown core row blocks its aggregate; it is never
rewritten. There are two mechanisms, and they agree:

- **Per row.** The codec returns `Blocked` for the row, and the read groups
  verdicts by aggregate.
- **Per aggregate.** At open and on each `data_version` change, `Database`
  compares `stored_kind` with the registry.
  - When every stored type is known and none is newer (the normal case),
    nothing can be blocked. No row is checked.
  - Otherwise one `SELECT DISTINCT aggregate FROM event WHERE type = ? AND version > ?`
    per offending type, off `event_type_commit`, names the blocked
    aggregates.
  - This matters because a run can have a newer ledger row while every
    listing row it delivers still decodes.

What each reader sees:

- **The listing.** Display reads deliver what decodes, plus one fold input,
  `{ _tag: 'blocked', aggregateId, reason: 'newer' | 'unknown' | 'corrupt', type, version }`.
  - The fold marks that run's `RunView` blocked.
  - Renderers show "written by a newer TeXRA; update to open it" or "row N
    is corrupt".
- **Acquire and ledger reads.** `acquireClaims`, `readAggregate` of a
  ledger, and resume refuse with a typed `DatabaseAggregateBlocked`. A
  `RunState` is never folded from part of a run's rows.

**Plugin arms** gain `{ version, upcasters }` (§6).

- Unknown plugin kinds stay byte for byte and are left out of reads, as
  today.
- A plugin value newer than its arm blocks that plugin's kind for that run.
  The plugin reader gets the verdict. Core does not block the run.

**Physical rewrite happens only at a major-version compaction.** A major
release may ship a compaction step: it reads every row through the
upcasters, writes it back at the current version, and then drops upcasters
older than the new floor. Minor releases never rewrite rows.

**Current values** get the same treatment. Each family in
`CURRENT_VALUE_SCHEMAS` gains `{ version, upcast }`, and `decodeValue` runs
the chain. A newer value fails that one read with a typed error; it is not
defaulted.

**Policy change (owner ruling Q2).** From the 1.0 release on, released row
versions are read forever through their upcasters, up to the next major
compaction. The upcasters run in the codec and nowhere else; that is the
one sanctioned compatibility reader. Before the release, AGENTS.md's "no
compatibility readers" rule stands unchanged: every kind is unreleased, no
upcaster exists, and a pre-1.0 store is moved aside whole.

Lane 4, which ships with the freeze, changes the session-database sentences
of AGENTS.md "Compatibility and format retirement" to this wording:

> The session database is the one store read across releases. Each row
> kind carries a version (`src/shared/schemas/rowVersions.ts`). A released
> version is read forever through adjacent upcasters that run in the row
> codec (`rowCodec.ts`) and nowhere else, until a major-version compaction
> rewrites the rows and retires the old upcasters. An unreleased version
> has no upcaster and may change freely until the next release freezes it
> (`config/storage/frozen/`). A row newer than the build blocks its run and
> is never rewritten. A store from before 1.0 is moved aside whole
> (`texra.db.pre1`) and never read. No other persisted format gets a
> compatibility reader.

## 4. Decoupling `model.message` from `packages/llm`

Today `ModelMessagePayloadSchema` embeds `TurnResultSchema` and `MessageSchema`
verbatim (`runLedgerEvent.ts:20-26,168,194`). As a result:

- a provider SDK or enum change in `packages/llm/src/turn.ts` is a stored
  format change;
- `finishEvidence`, `refusalEvidence` and part `evidence` are strict
  per-provider unions;
- an OpenRouter SDK change already forced a format bump.

**Decision: a persisted subset schema owned by storage.** It is
`src/shared/schemas/storedTurn.ts`, which defines `StoredTurnSchema` and
`StoredMessageSchema`.

- **What the runtime branches on is strict and storage-owned:**
  - content part kinds, and their text or arguments;
  - call identities;
  - finish reason;
  - token counts;
  - origin (protocol, provider, model);
  - `providerResponseId`.
- **What only a provider adapter reads back is opaque evidence:**
  `{ kind: string, data: JsonObject }`.
  - This covers finish, refusal and usage evidence, part signatures,
    encrypted reasoning and continuation.
  - Storage stores these bytes and never interprets them.
  - `packages/llm` parses them when it replays to its own protocol, and it
    already refuses foreign evidence at that point (`anthropicMessages.ts:379`).
- **Where conversion happens.** `toStoredTurn` and `fromStoredTurn` sit at
  the `RunLedger` boundary in `src/agent/runtime/`, where the llm types are
  already in scope. `src/shared/schemas` stops importing `@texra-ai/llm/turn`
  for any stored arm.
- **What the ratchet checks.** `storedShapeBoundary.vitest.ts` refuses a
  `@texra-ai/llm` import from any schema reachable from `SessionEventSchema`.

Alternative: store the whole turn as open `{kind, data}`. Rejected, because
the folds (usage, calls, finish, pairing responses with settlements) would
need llm's decoder, which reintroduces the coupling.

The same lane gives every persisted `z.unknown()` field a `JsonValueSchema`:
`tool.start.input`, `tool.end.result`, `log.data`, and `domain.data`
(`traceEvent.ts:29,45,50,93`). A field of unknown shape still must be JSON.

## 5. Projections

There are three projections. Each is a pure TypeScript projector over the
decoded event, with its own version in `projection_state`.

| Projection | Tables                                     | Input kinds                                                                                              | Replaces                                                                        |
| ---------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `listing`  | `listing_entry`                            | every kind with a `listingKeyOf` or `pendingKeyOf`                                                       | `READ_LISTING`'s latest CTE, `LISTING_GROUP`, the pending-set SQL, `runRecords` |
| `usage`    | `projected_row` (`usage`), `run_usage`     | priced `model.message` responses, `model.compaction` summaries, stored `usage` rows (agent-CLI children) | `USAGE_ROWS`, `RUN_USAGE`, `totalRunUsage`                                      |
| `model`    | `projected_row` (`run.model`), `run_model` | `run.snapshot`                                                                                           | `MODEL_ROWS`, `LATEST_MODEL_ROWS`, `SNAPSHOT_MODEL`, `event_snapshot_model`     |

- **Who writes.** `Database.appendRows` runs the projectors inside the
  append transaction, over the committed events it already holds as typed
  values, so there is no decode.
  - A projector returns row operations. `Database` executes them.
  - The usage and model projectors read their one prior row (`run_usage`,
    `run_model`) by primary key, in the same transaction.
  - After the batch, each projection's `through_commit` advances.
- **One definition, two consumers.**
  - `listingKeyOf` stays where it is.
  - `pendingKeyOf(event)` is new, beside it in `sessionEvent.ts`. It returns
    `{ open: key }` for `request.opened` and `followup.queued`,
    `{ close: key }` for their pairs, and `null` otherwise.
  - The fold and the projector both call these functions, so the SQL that
    restated them is deleted.
- **Rebuild on version mismatch, catch up when behind.** Every read of a
  projection first checks `projection_state` (one tiny row).
  - If the version differs from this build's, rebuild: in one write
    transaction, empty the tables and set `(version, 0)`. Then catch up.
  - If `through_commit` is below the high-water commit, catch up: read
    `event` rows past `through_commit` of the projection's input kinds
    (`event_type_commit`), decode them through the codec, and apply the
    projector, in chunks of 1,000 rows per transaction.
  - A build that appends while the stored projection version is not its own
    leaves that projection alone, so the build owning that version catches
    up on its next read.
  - Projections are never migrated. That was opencode's lesson: a migrated
    projection had to be wiped anyway.
  - Two builds with different projection versions on one store rebuild once
    per alternation. That is accepted and logged at info.
  - Alternative: version-suffixed tables per build. Rejected; they leave
    orphan tables that no build can safely drop.
- **Reads after the cut:**
  - `readListing`: `listing_entry` joined to `event` by commit, plus
    `run_usage` and each run's latest switch (`run_model.commit` →
    `projected_row`). No JSON functions; primary-key joins only.
  - `readDisplay`, `readDisplayAggregate` and `readInputBatch` use **one
    display-union helper**. It unions the selected `event` rows with
    `projected_row` rows in the same commit or aggregate range, joined to
    `event` for the envelope. This replaces the three hand-written copies.
  - `inputTypes` becomes
    `SessionEventDraftSchema.options.map(type).filter(t => listingTypeOf({type}) !== null)`,
    plus the projected `usage`.
  - **One tombstone predicate**: `closed_by = ?`. It replaces the join and
    the two `EXISTS` blocks.

## 6. Plugin storage API

A built-in plugin declares row kinds in `src/shared/plugins/<plugin>`, which
`src/tools/pluginArms.ts` collects as today:

```ts
interface PluginArm {
  readonly plugin: string;
  readonly kind: string;
  readonly version: number; // current write version
  readonly schema: z.ZodType; // the current version's value
  readonly upcasters: readonly ((value: JsonValue) => JsonValue)[]; // v1→v2, …
}
```

- **Storage.** `plugin.fact` is one core kind, `{ plugin, kind, version, value }`.
  The plugin's `version` lives in the payload, so a plugin can evolve without
  a core version.
- **Decoding.** The codec checks the value against its arm after upcasting,
  as `decodeEvent` does today (`Database.ts:141-146`).
- **Freezing.** Plugin arms join the frozen-schema fixtures at release.
- **Projection: none in 1.0.** The listing already keeps the latest row per
  (plugin, kind) through `listing_entry`, keyed
  `plugin.fact/<plugin>/<kind>`. That is the one projection every plugin
  gets. A plugin that needs more derives it in its reader, over folded
  values. Plugin SQL projections would make each plugin a second writer.
- **Rows of removed or absent plugins** are kept byte for byte and left out
  of every read, with one warning per kind per connection (today's
  behavior, `Database.ts:253-277`). They are collected with their run.
- **Third-party plugins get nothing durable in 1.0.**
  - This covers out-of-process code plugins and hooks
    (`2026-09-28-code-plugins-hooks-v1.md`).
  - Their effects are recorded as core `hook.outcome` rows by the run's one
    writer.
  - Their own state lives in `CLAUDE_PLUGIN_DATA`, outside the store.
  - They cannot declare row kinds. A durable third-party kind would need a
    trust and version story for code TeXRA did not ship. That story is out
    of scope for 1.0.

## 7. Hygiene

- **Vacuum.** `auto_vacuum = INCREMENTAL` is set at creation (§3).
  - After each `collectDeletion` commits, and after a retirement,
    housekeeping runs `PRAGMA incremental_vacuum` when `freelist_count`
    exceeds a quarter of `page_count`.
  - This takes the write lock briefly, under the §8 retry.
  - Today the coauthor store is 95% free pages.
- **Blob collection.** Collection is by reachability, not refcount; a
  counter would be a second truth that drifts on partial paths.
  - `collectDeletion`'s final transaction reads the digests referenced by
    the aggregates it collects (`event_blob`).
  - After the cascade, it deletes those digests that no remaining `event`
    row references.
  - The `event.blob` foreign key makes deleting a reachable blob impossible.
- **WAL.** `journal_size_limit` is 1 MiB. On scope close, the connection
  runs `PRAGMA wal_checkpoint(TRUNCATE)`. A failure there is logged at
  warn.
- **Aside copies.** They are named `texra.db.pre1`, `texra.db.schema<N>` and
  `texra.db.corrupt-<stamp>`.
  - Housekeeping keeps at most one per store, the newest, and deletes it
    after 30 days.
  - Each deletion is logged at info with its path and size.
  - This replaces `.format<N>` copies that are never collected.
- **Orphaned workspace stores.** There are 259 today; 52 have `mkdtemp`
  roots.
  - Each project open records `{ root }` in the global store's
    `current_value` (family `workspace-store`, key: the storage directory
    id). An unchanged record is not rewritten.
  - `texra doctor` reports store count, total size, aside copies, and
    stores whose root is missing.
  - `texra doctor --prune-storage` deletes those stores after listing them.
    A store with no record (pre-1.0) is pruned when its mtime is over 90
    days.
  - Decided (Q4): whole orphaned stores are removed only by this explicit
    command, never automatically. An unmounted drive looks exactly like a
    deleted root.
  - The `mkdtemp` stores are a test-harness leak, fixed at the source:
    every E2E and test harness passes a temporary TeXRA data root.
- **Corrupt or NOTADB.** At open, the file is moved aside (§3, step 2) and
  reported through `movedAside`, which gains `reason: 'pre-1.0' | 'corrupt'`.
  - Mid-session corruption fails the read with
    `DatabaseReadFailed { reason: 'corrupt' }`, and the host tells the user
    to restart. A file another connection may hold is never moved while
    it is open.
  - `texra doctor` runs `PRAGMA quick_check`.
- **Workspace key.** The storage directory id (`workspaceStorage.ts`) hashes
  an identity built for storage:
  - `realpathSync.native` on macOS and Linux. The JS `realpathSync` keeps
    the typed case, so on a case-insensitive volume one folder yields two
    stores.
  - On Windows, the JS realpath stays, for the reason
    `externalRoots.ts:103-106` gives (native rewrites a mapped drive to
    UNC), and the key is case-folded.
  - The host's displayed workspace path is unchanged; only the key changes.
    Old directories become orphans for `--prune-storage`.

## 8. Concurrency and host threading

- **Busy wait.** The open keeps `busyTimeout: '5 seconds'` (the WAL
  ordering needs it), then sets `busy_timeout = 25`.
  - `transactions(mode)` wraps each transaction in `Effect.retry`. The retry
    applies only to `SQLITE_BUSY` and `SQLITE_LOCKED`, read from the
    `SqlError` cause before mapping.
  - The schedule is exponential from 5 ms, jittered, each sleep capped at
    250 ms, with a total of 5 s. After that it fails as
    `DatabaseWriteFailed { reason: 'busy' }`.
  - Every transaction body is database-only, so re-running it is safe.
  - Other fibers run between attempts. Today a 5 s wait freezes the Electron
    main process or the extension host.
- **Monotonic `observedCommit`.** Both the poll (`Database.ts:395`) and the
  write finalizer (`:437`) call
  `SubscriptionRef.update(observedCommit, (c) => Math.max(c, commit))`.
  Today a poll that read the high-water mark before a local commit can set
  it backwards.
- **Keep `data_version` polling** at 250 ms, one PRAGMA per tick per
  connection. The alternatives were rejected:
  - `sqlite3_update_hook` and commit hooks see only their own connection,
    and `node:sqlite` does not expose them.
  - `fs.watch` on `-wal` has no ordering, fires on checkpoints, and differs
    by OS (FSEvents coalescing, Windows locking). It would still need a read
    to learn what changed.
  - A socket broadcast between processes is a second channel that can
    drift from the store.
  - The background server is deferred
    (`2026-09-26-session-database-off-host-thread.md` §6).
- **Typed failures.** `DatabaseOpenFailed`, `DatabaseReadFailed` and
  `DatabaseWriteFailed` carry
  `reason: 'busy' | 'corrupt' | 'full' | 'readonly' | 'constraint' | 'newer' | 'other'`
  and `cause: SqlError | Error`, not `unknown`.
  - `mapDatabaseFailure` stops turning defects into failures. With the
    codec returning verdicts instead of throwing, a remaining defect is a
    protocol violation (`invariant`) and should die loudly.
- **Worker thread: not yet.**
  - What is measured:
    - listing takes 26 ms warm, on today's SQL;
    - every hot query uses an index (checked with EXPLAIN);
    - the largest store is 11 MB;
    - transactions are short and do no I/O.
  - What is not measured: no event-loop stall reading exists (off-host note
    §2).
  - The freeze we know about is the busy wait, which the retry above
    removes.
  - The projections turn the heaviest statement (the listing's grouped JSON
    aggregation) into primary-key joins.
  - The worker is **format-neutral**: the `Database` service interface is
    already the RPC seam, so taking it later rewrites no storage.
  - **Decided (Q5): the worker is deferred past 1.0.** Lane 1 takes the
    off-host note's Stage 0 event-loop reading once, on the 1.0 store, with
    the busy retry in place. The worker (Stage 2) is taken after 1.0 only if
    that reading shows a stall over the 100 ms budget.

## 9. Module split for `Database.ts`

`Database.ts` is 1,328 lines against a 1,363 budget. It splits by real
owners only. Each resulting module owns tables or a stored contract and has
more than one consumer.

| Module             | Owns                                                                                                       | Consumers                                                                              | From                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `Database.ts`      | the connection, transactions and retry, seq/commit/claims, lifecycle edges, deletion and collection, reads | every `Database` caller                                                                | stays; about 850 lines after the cut                                    |
| `storeSchema.ts`   | DDL, PRAGMAs, the open sequence, the `SCHEMA_VERSION` runner, retirement, housekeeping                     | `Database` open, `texra doctor`, prune                                                 | `storeFormat.ts` plus `configure` and `verifyPragma` from `Database.ts` |
| `rowCodec.ts`      | encode, decode, upcast, verdicts, blob externalization, aggregate id mapping                               | `Database` reads and writes, projection catch-up, compaction, the conformance suite    | `decodeEvent`, `payloadOf`, `prepareEventDraft`                         |
| `projections.ts`   | the three projectors, their tables' SQL, their versions and catch-up                                       | `Database` append and display/listing reads                                            | replaces `displayProjection.ts`                                         |
| `currentValues.ts` | `current_value`, `input_history`, the change feed                                                          | `appStateStore`, `inquiryRecords`, `updateCheckRecords`, desktop projects, CLI history | `Database.ts:754-832,875-893` plus `appStateChanges.ts`                 |

The following stay where they are or move to an existing owner:

- **The deletion lifecycle stays in `Database.ts`.** It writes
  `event_sequence`, and the write ratchet admits one writer. Moving it
  beside `deletionCleanup.ts` would make a second one. This departs from
  the audit's item 18, which proposed moving it.
- **`validateInquiryTransition` moves** to `src/shared/schemas/inquiry.ts`,
  beside the schema whose transitions it rules. It is a pure function of
  two rows.
- **The ten `draft.type` branches in `appendRows` collapse** into one
  `edgesOf(draft)`, beside `referencedAggregates` in `sessionEvent.ts`.
  `edgesOf` returns:
  - the parent to stamp;
  - reparenting (`workflow.script`, inquiries);
  - the borrowed claim (inquiries);
  - closure (`run.removed`).

  Reads and writes then share one statement of the aggregate graph.

No module exists only to be called once. The file-size baseline shrinks for
`Database.ts` and gains no new entry.

## 10. Tool output stored once

Decided (owner ruling Q1): tool output is stored once. The `tool.end` card
is filled from its `tool.result` at read time.

A settled tool call writes two rows today:

- the display card, `tool.end.result`, holding `{toolName, input, output, files}`;
- the ledger row, `tool.result.result`, holding the same sanitized result
  (`toolUseDispatch.ts:535-553`).

The input is a third copy; it is also on `tool.start`.

**The design: the card's output is projected from its settlement at read
time.**

- On a run with a ledger, `tool.end` keeps `{logId, status, files}` and
  drops `result`.
- The display read already selects the batch. It also selects the
  `tool.result` rows with commits in that batch; they commit in the same
  transaction, and a commit range never splits a transaction.
- The codec's display path assembles `tool.end.result` from the
  `tool.result` and its `tool.start` input. It then drops the ledger row
  before anything leaves the codec.
- Renderers, the transcript fold and the history query store see today's
  shape unchanged. `tool.result` never reaches a transport.
- Runs without a ledger (agent-CLI children, `toolUseHelpers.ts:53`) keep
  writing `result` on the card.

The card is still loop-owned:

- the run loop writes it, and it commits in the settlement batch;
- there is still no tool-side card and no second append path;
- the only change is that its output is projected from the `tool.result`
  it settles with, not stored a second time.

Lane 2 changes the tool-call sentence of CLAUDE.md "One publisher,
loop-owned cards" to:

> A tool call's card belongs to the run loop. A slow tool's `tool.start`
> commits with the row that admits the attempt; a fast tool's card opens
> and closes in its settlement batch. On a run with a ledger, the card
> stores no output: its output is projected at read time from the
> `tool.result` it commits with. What a tool prints while it runs is
> transient text on the card id (`hooks.onToolOutput` → `stream.chunk`),
> never a row.

Rejected: keeping both copies and capping `tool.end` at a display preview.
Full output would then live only in a row renderers may not read.

## 11. Testing

The suites below are the 1.0 feature's end-to-end and conformance coverage.
They follow the testing discipline's bar: no unit tests over churning
internals.

- **Golden 1.0 store.** A real CLI E2E with a cheap model (`glm53flash`,
  falling back to `gemini38f`) writes it against a temporary data root. It
  holds:
  - a tool-use run with tool calls, a mid-run model switch, a subagent
    child, and a decided approval request;
  - a queued follow-up and a workflow script with journal and attempt rows;
  - a `goal` plugin fact;
  - context blobs shared by two runs;
  - a tombstoned run.

  It is committed as a text dump
  (`src/test-kernel/fixtures/storage/golden-1.0.sql`, SQLite's own `.dump`
  format), regenerated by one script.

- **Conformance suite** (one file, over the golden store):
  - every row decodes to `Event`, with no verdicts;
  - the `SessionView` and `RunState` folds equal their pinned values;
  - `resumeRun` on the parked run, with a scripted model, rebuilds the
    recorded request byte for byte (the `requestContext` check);
  - each projection, rebuilt from zero, equals its incremental tables row
    for row;
  - the listing equals the fold over full history.
- **Blocking test.** Inject a `model.message` row at current + 1 and an
  unknown core type into a copy.
  - The listing shows those aggregates blocked and every other run
    normally.
  - `acquireClaims` refuses with `DatabaseAggregateBlocked`.
  - A byte comparison shows no row rewritten.
- **Refusal corpus.** Each store is generated in the test from DDL, with no
  binary fixtures:
  - a newer `SCHEMA_VERSION` is refused untouched;
  - a foreign `application_id` is refused;
  - a truncated file (NOTADB) is moved aside and a fresh store opened;
  - a format-44 store is retired whole to `.pre1`, and the store that opens
    is empty, with no `current_value` or `input_history` row carried over.
- **Two-OS-process test.** A child Node process appends to the same file
  while the parent appends and reads. It asserts:
  - dense seqs and no lost appends;
  - monotonic `observedCommit`;
  - a parent event-loop delay under budget with the 25 ms slice.
- **Deleted:** `sessionEventFormat.vitest.ts` and its snapshot. The per-kind
  fingerprints in `rowVersions.vitest.ts` replace them.

## 12. Plan

There are four lanes, and exactly one physical bump: Lane 1, to
`SCHEMA_VERSION` 100. Everything after Lane 1 changes only unreleased row
versions (§3, the release watermark).

| Lane                | Order                    | Depends on | Effort    | In the 1.0 reader?                                                  |
| ------------------- | ------------------------ | ---------- | --------- | ------------------------------------------------------------------- |
| 1. The 1.0 store    | first                    | none       | 9–11 days | **yes, all of it**                                                  |
| 2. Stored contracts | second (parallel with 3) | 1          | 4–5 days  | **yes**: `StoredTurn`, and the output-free tool card                |
| 3. Hygiene          | second (parallel with 2) | 1          | 3–4 days  | no stored-format content; may slip past 1.0 except corrupt recovery |
| 4. Freeze and prove | last, the release gate   | 1, 2, 3    | 3–4 days  | **yes**: the frozen schemas and watermark                           |

**Lane 1: The 1.0 store.** One PR, and the only format bump.

- `storeSchema.ts`: the full §2 DDL (including the projection, blob and
  bookkeeping tables), the PRAGMAs, the §3 open sequence and runner,
  fully clean pre-1.0 retirement, and corrupt move-aside.
- `rowCodec.ts` and `rowVersions.ts`, with every kind at version 1;
  `Blocked`/`Corrupt` verdicts through reads, the fold input, the listing,
  and acquire refusal; plugin arm versions.
- `projections.ts`, and the deletion of `displayProjection.ts`.
- The aggregate surrogate, `closed_by` and `start_commit`, and `edgesOf`.
- Blob externalization and reachability collection.
- Deletion of `SESSION_EVENT_FORMAT`, the 30 literals, and the 24 + 3 JSON
  reads.
- The `storedShapeBoundary` ratchet, and the write-ratchet extension.
- The 25 ms busy slice plus Effect retry, and a monotonic `observedCommit`,
  so the reading below measures the store 1.0 ships.
- The off-host note's Stage 0 event-loop reading, taken once on the 1.0
  store. It decides whether the post-1.0 worker is taken (§8, Q5).

E2E evidence:

- a CLI run (`glm53flash`) on a copy of a real format-44 store, showing
  the `.pre1` copy, an empty fresh store, and `.schema` output in the PR;
- two `texra` processes on one project with a held write lock, and the
  event-loop delay reading;
- a run killed with `kill -9` and resumed;
- `texra history --json` listing identical before and after a forced
  projection rebuild (drop `projection_state`, reopen);
- an injected newer row visible as blocked in `texra history`, and
  `texra resume` refused;
- a `SELECT count(*) FROM blob` showing two runs sharing blobs;
- `EXPLAIN QUERY PLAN` of the listing.

**Lane 2: Stored contracts.**

- `StoredTurn` and `StoredMessage`, with `toStoredTurn`/`fromStoredTurn`
  at `RunLedger`.
- `JsonValueSchema` for the four `z.unknown()` fields.
- Tool output stored once (§10): the output-free `tool.end` on ledger runs,
  and the read-time projection of its output from `tool.result`.
- The CLAUDE.md "One publisher, loop-owned cards" wording change (§10).
- The per-kind fingerprint test, `npm run storage:freeze`, and the
  `releasing` skill step.

E2E evidence:

- a CLI tool-use run on two protocols (`glm53flash` over
  OpenAI-compatible, `gemini38f` over Google Interactions), resumed
  mid-run;
- a scratch change to an llm finish-evidence enum that leaves every
  storage fingerprint unchanged (shown in the PR);
- the transcript of a tool call identical to the pre-lane transcript
  (`texra history <id> --format md` diff);
- store size per run before and after.

**Lane 3: Hygiene.**

- Typed failure reasons; defects kept as defects.
- `incremental_vacuum` after collection; WAL truncation at close; aside
  collection.
- `workspace-store` records, the `texra doctor` report and
  `--prune-storage`.
- The storage-key realpath rule; temporary data roots in every harness.
- `currentValues.ts`, and the inquiry-transition move.

E2E evidence:

- `page_count` and `freelist_count` before and after deleting runs,
  showing the file shrink;
- `texra doctor --prune-storage` dry-run output on a developer data root.

**Lane 4: Freeze and prove.**

- The golden store from the CLI E2E; the conformance suite, blocking test,
  refusal corpus and two-process test.
- Run `storage:freeze` at the 1.0 tag, so the frozen schemas and
  `RELEASED_ROW_VERSIONS` become the floor every later build reads.
- The AGENTS.md "Compatibility and format retirement" wording change (§3,
  Q2). It lands with the freeze, because only then do released rows exist.

E2E evidence: the golden store itself, and the suite green on all three
CI OSes.

## 13. Decisions (2026-09-28)

Every question this note raised is decided. None remain open.

| #   | Question                               | Decision                                                                                                                                             | Where                    |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Q1  | Tool output stored twice               | Store it once. The `tool.end` card is filled from its `tool.result` at read time. The card stays loop-owned; only its output is projected.           | §10; Lane 2              |
| Q2  | Compatibility after 1.0                | From the 1.0 release on, released rows are read forever through upcasters, in the codec only. Before 1.0 the "no compatibility readers" rule stands. | §3; AGENTS.md in Lane 4  |
| Q3  | What a pre-1.0 store keeps at the bump | Nothing. The whole store, `current_value` included, moves aside to `.pre1`, and the store starts fully clean.                                        | §3 open sequence; Lane 1 |
| Q4  | Removing orphaned stores               | Only by an explicit `texra doctor --prune-storage`, never automatically.                                                                             | §7; Lane 3               |
| Q5  | Moving SQLite to a worker thread       | Deferred past 1.0 (the coordinator's call). It is taken only if Lane 1's event-loop reading shows a stall over the 100 ms budget.                    | §8; Lane 1               |
