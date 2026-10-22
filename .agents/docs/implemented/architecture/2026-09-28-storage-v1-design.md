# The 1.0 storage design

Date: 2026-09-28

Status: implemented. The owner ruled on every question on 2026-09-28 (§13). One
release step remains: the first release that promises its rows runs
`npm run storage:freeze` (§3, §12).

Owner ruling (2026-09-28): "we really should have the cleanest design before
v1.0 because I don't want to rewrite this again."

## Summary

This is the session store's 1.0 format. From the first release on, the store
changes by adding row versions, not by moving whole stores aside.

- **One row codec** (`rowCodec.ts`) is the only code that knows a stored shape.
- **Per-kind row versions** (`rowVersions.ts`), with adjacent upcasters, replace
  a store-wide format stamp. A physical `SCHEMA_VERSION` changes only with the
  DDL.
- **One store gate.** A store holding a kind or version this build does not read
  is refused whole, never read in part.
- **Pure TypeScript projectors** maintain the display and listing tables inside
  the append transaction. No SQL reads payload JSON.
- **A store-wide content-addressed `blob` table** holds every large string once.
- **The store shrinks**: incremental vacuum after collection, a WAL size limit,
  and an explicit prune of orphaned stores and aside copies.

The 1.0 baseline is `SCHEMA_VERSION` 101. 100 was a pre-release layout that no
release shipped.

## 1. Layers and owners

```
 readers          SessionView fold · RunState fold · plugin readers · history query store
                          ▲ decoded SessionEvent, or a typed refusal
 folds &          sessionFold · runState · transcriptFold      (read payloads; never SQL)
 projections      projectors (listing, usage, model)               (pure TS over decoded events)
                          ▲
 history &        SessionEvents inbox (one publisher) → Database.appendAll
 publisher        (seq, commit, claims, lifecycle edges, executes projector ops)
                          ▲ typed drafts in, typed events out
 row codec        rowCodec.ts + rowVersions.ts                     (the only stored-shape knowledge)
                          ▲ column tuples
 physical store   storeSchema.ts: DDL, PRAGMAs, SCHEMA_VERSION, the open sequence
                  SQLite file (WAL)
```

| Layer                   | Module (under `packages/harness/src/controllers/session/` unless noted)                                   | May know                                                                                                                             | Must not know                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Physical store          | `storeSchema.ts`, `storeAside.ts`                                                                         | tables, columns, indexes, PRAGMAs, `SCHEMA_VERSION`, file moves                                                                      | any payload field; any row kind                                  |
| Row codec               | `rowCodec.ts`, `rowReader.ts`; the registry in `packages/harness/src/shared/schemas/rowVersions.ts`       | `type` and `version` columns, the `data` JSON layout, blob externalization, the (kind, logical id) ↔ `AggregateId` mapping, the gate | SQL statements beyond its column lists; fold semantics           |
| Run history / publisher | `Database.ts` (the one writer), `packages/harness/src/agent/runtime/SessionEvents.ts` (the one publisher) | envelopes (seq, commit, origin, at), claims, aggregate lifecycle edges, transactions                                                 | stored shapes: it hands drafts to the codec and gets events back |
| Projections             | `projections.ts`                                                                                          | its own tables and versions; `listingKeyOf`, `pendingKeyOf`, `sumUsageStats`                                                         | `event.data`: it reads decoded events only                       |
| Folds                   | `packages/harness/src/shared/session/{sessionFold,runState,transcriptFold}.ts`                        | payload fields                                                                                                                       | columns, versions, SQL                                           |
| Current values          | `currentValues.ts`                                                                                        | `current_value`, `input_history`, family schemas                                                                                     | events                                                           |

**Two invariants.** Nothing above the codec sees a stored shape: no
`'<type>.<N>'` string, no integer aggregate id, no `data` text, no `blob`
column. Nothing below the codec reads a payload field: no SQL JSON function
touches `event.data`, `blob.value`, `current_value.value`, or a projection's
data.

Two ratchets enforce them:

- **`src/test-kernel/architecture/storedShapeBoundary.vitest.ts`.**
  - In production files, the only SQLite JSON function allowed is `json_each(?)`
    over a bound parameter. `json_extract`, `json_type`, `json_patch`,
    `json_object`, `json_group_array`, `->` and `->>` are refused.
  - No string literal of the form `'<kind>.<digit>'` appears anywhere.
  - Only the codec selects the `version` column or reads the upcasters.
  - No schema reachable from `SessionEventSchema` imports `@texra-ai/llm` (§4).
  - Exempt by name, with its reason: the history query store
    (`packages/harness/src/agent/runtime/historyQuery/`). It is a separate
    `:memory:` database built from decoded display rows. Its `json_extract`
    views are a query contract offered to the model, not reads of the session
    store.
- **`src/test-kernel/architecture/persistenceWriteBoundary.vitest.ts`.**
  - Every run history table (`event`, `event_sequence`, `event_blob`, `blob`,
    `stored_kind`) and every projection table has one writer, `Database.ts`.
  - `current_value` and `input_history` have their own single writer,
    `currentValues.ts`.

## 2. Physical schema, final for 1.0

### Decisions

- **Aggregate identity.** `event_sequence` has a local integer surrogate, `id`,
  plus two real columns, `kind` and `logical_id`, with
  `UNIQUE (kind, logical_id)`. `event` and the projections reference `id`. The
  codec composes the canonical `AggregateId` string from the two columns, so
  nothing above it sees the surrogate.
  - Aggregate lists bind as two parallel `json_each(?)` arrays (kinds, logical
    ids), joined on the array index.
  - `kind` gets no `CHECK` enumeration: SQLite can change a `CHECK` only by
    rebuilding the table, and a new aggregate kind should cost a codec entry,
    not a physical bump.
  - Rejected: a JSON text key with `CHECK (json_valid(...))`. SQL would still
    parse it, and it would be canonical only by Zod.
- **No promoted `key` column on `event`.** The listing is the only reader that
  needs a per-row key. It has a projection table, `listing_entry`, keyed by
  `listingKeyOf`, the fold's own function. A `key` column would put the
  listing-key rule into SQL a second time.
- **`type` and `version` are separate columns.** Type filters then never
  enumerate versions. (Rejected: opencode's single `type.vN` text, which makes
  every `IN (...)` list every version.)
- **`uid` is not stamped into the first row.** It stays a column of
  `event_sequence`, which cascades with the events in the same file. Copying it
  into `run.start` would give it two sources of truth. A child's
  `run.start.parent.uid` is the one cross-aggregate reference.
- **Lifecycle facts are columns.** `closed_by` (the tombstone's commit, `NULL`
  while open) and `start_commit` (the commit of seq 1) are set by the
  transaction that writes those rows.
- **Large strings live outside the row, compressed, once per store.** The codec
  replaces every payload string of 4096 characters or more, at any depth, with
  `{"$b": "<digest>"}` and stores the string once in `blob`: its JSON encoding
  (`JSON.stringify`, which escapes a lone surrogate that UTF-8 would turn into
  U+FFFD), zstd level 3 (Node's built-in `zlib.zstdCompressSync`), keyed by the
  sha256 of that encoding. A payload's own key of the form `$b`, `$$b`, … gains
  one `$` when stored and loses it when read, so a stored `$b` is always a
  reference and round-trips are exact.
  - Every event read selects a row's blobs with it, a correlated `group_concat`
    over `event_blob` (digest and `hex(value)`), so decoding stays one
    synchronous call per row. The codec decompresses each reference and checks
    it hashes to its digest; a missing or failing one makes the row corrupt.
  - A `context.blob` row's value is stored as its canonical JSON text, so that
    text hashes to its address.
  - This covers what makes a store large without code for any kind: tool output,
    media (attachments are inline base64 in `model.message` and `tool.result`),
    long prompts, and context blobs. Duplicates cost one blob.
  - `event_blob (commit, digest)` records each row's references; it is what
    collection reads (§7), and it cascades from `event`.
  - Measured when the design was written, on a generated 1,000-run store (175k
    rows): 1,038 MB before, 324 MB after.
  - zstd is in Node from 22.15; the codec throws at load on a runtime without
    it.
  - Rejected: compressing the whole `data` column (no dedup, and every small row
    pays a frame); a media-specific attachment table (a second mechanism for
    what the string rule already covers).

### DDL

```sql
-- New files only: auto_vacuum must be set before the first table exists.
PRAGMA auto_vacuum = INCREMENTAL;
PRAGMA application_id = 1415927890;   -- 0x54655852 'TeXR': identifies a TeXRA store
PRAGMA user_version = 101;            -- SCHEMA_VERSION, the 1.0 baseline

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
  digest TEXT PRIMARY KEY CHECK (length(digest) = 64),  -- sha256 of the string's JSON encoding
  value  BLOB NOT NULL                                  -- zstd level 3 of that encoding
) STRICT;

CREATE TABLE event (
  "commit"  INTEGER PRIMARY KEY AUTOINCREMENT,          -- local cursor
  aggregate INTEGER NOT NULL REFERENCES event_sequence(id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  type      TEXT NOT NULL,
  version   INTEGER NOT NULL CHECK (version >= 1),
  origin    TEXT NOT NULL,
  at        INTEGER NOT NULL,
  data      TEXT NOT NULL,                              -- large strings as {"$b": digest}
  UNIQUE (aggregate, seq)
) STRICT;

-- Each row's blob references: what keeps a blob reachable.
CREATE TABLE event_blob (
  "commit" INTEGER NOT NULL REFERENCES event("commit") ON DELETE CASCADE,
  digest   TEXT NOT NULL REFERENCES blob(digest),
  PRIMARY KEY ("commit", digest)
) STRICT, WITHOUT ROWID;

-- The highest version of each kind ever written here: the store gate (§3).
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
  model     TEXT NOT NULL,                    -- the latest configured model: the next switch's baseline
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
CREATE INDEX event_blob_digest     ON event_blob(digest);
CREATE INDEX current_value_at      ON current_value(family, at);
```

The projection tables and the indexes are `CREATE … IF NOT EXISTS` at every open
(`ADDITIVE` in `storeSchema.ts`), so adding one bumps nothing.

### Indexes, each justified by a named query

| Index                                                                                    | Query it serves                                                                                                                                       |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event` PK (`commit`)                                                                    | every tail read by commit range; joins from `listing_entry`, `projected_row` and `run_usage`                                                          |
| `UNIQUE (aggregate, seq)`                                                                | `readAggregate(id, fromSeq)`, `readDisplayAggregate`, `readInputBatch`'s per-id arm; seq density; the FK child index for `event.aggregate`            |
| `event_aggregate_type`                                                                   | `readAggregate` with types                                                                                                                            |
| `event_type_commit`                                                                      | `readDisplay` and `readInputBatch` tails (`type IN … AND commit range`), `readPendingDeletions` (`type = 'run.removed'`), projection catch-up by kind |
| `event_blob_digest`                                                                      | blob reachability after a collection; the FK check when a blob is deleted                                                                             |
| `event_sequence_parent` (partial)                                                        | the recursive `dependents` CTE (deletion, closure); the FK child index for `parent_id`                                                                |
| `UNIQUE (kind, logical_id)`                                                              | every lookup of an `AggregateId`                                                                                                                      |
| `current_value_at`                                                                       | `values.list(family)`, ordered by `at DESC`                                                                                                           |
| primary keys of `listing_entry`, `projected_row`, `run_usage`, `run_model`, `event_blob` | the listing read, display reads, the projector's read-modify-write, and a collection's references; each is also the table's FK child index            |

### PRAGMAs

| PRAGMA               | Value                                    | Why                                                                                                                                                                                                     |
| -------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `busy_timeout`       | 5000 at open, then 25                    | The 5 s value must be set before WAL is enabled: at zero, a second process opening the file lost appends to `SQLITE_BUSY`. After the open, a 25 ms slice plus the Effect retry in §8 replaces the wait. |
| `journal_mode`       | `WAL` (persistent), `MEMORY` (ephemeral) | verified at open                                                                                                                                                                                        |
| `synchronous`        | `NORMAL`                                 | WAL-safe. `FULL` measured 1.4–1.8× the cost, and `kill -9` lost nothing at `NORMAL`.                                                                                                                    |
| `foreign_keys`       | `ON`                                     | the cascades are the collection mechanism                                                                                                                                                               |
| `auto_vacuum`        | `INCREMENTAL`                            | applied to a new file, and to a file emptied by retiring a pre-1.0 store, with one `VACUUM` of the empty file                                                                                           |
| `journal_size_limit` | 1048576                                  | truncates the WAL to 1 MiB after a checkpoint reset                                                                                                                                                     |
| `application_id`     | `0x54655852` (`TeXR`)                    | distinguishes a TeXRA store from a foreign SQLite file before anything is touched                                                                                                                       |
| `user_version`       | `SCHEMA_VERSION`                         | §3                                                                                                                                                                                                      |

## 3. Versioning

### Physical: `SCHEMA_VERSION` in `user_version`

`SCHEMA_VERSION` names the DDL, not the vocabulary.

- **Numbering.** The 1.0 baseline, `BASELINE_1_0`, is **101** and fixed for
  good; a later `SCHEMA_VERSION` never moves it. A stamp from 1 to 99 is a
  pre-1.0 format stamp; 100 is the pre-release layout no release shipped.
- **When it bumps.** Only for a change an older build cannot write around: a
  column change or a table rebuild. An additive index or projection table bumps
  nothing, because projections carry their own versions.
- **No upgrade steps exist yet.** A store stamped at or above the baseline and
  below `SCHEMA_VERSION` is refused untouched ("no step from it exists"). The
  first real `SCHEMA_VERSION` bump after 1.0 ships its upgrade step together
  with a test that a 1.0 store is kept and upgraded, not moved aside.

**Open sequence** (`openStore` in `storeSchema.ts`, called by `databaseLayer`):

1. For a persistent store, a read-only probe checks the stamps before the
   store's own connection enables WAL (`checkStamps`). It refuses, with nothing
   touched:
   - a foreign file: an `application_id` that is neither 0 nor TeXRA's, a 1.0
     stamp without TeXRA's id, or tables below the baseline without the pre-1.0
     signature (`event` and `event_sequence` keyed by `aggregate_id`);
   - a schema at or above the baseline other than `SCHEMA_VERSION`: newer, or
     one with no step.
2. Open with `busyTimeout: '5 seconds'`. If SQLite reports `SQLITE_CORRUPT` or
   `SQLITE_NOTADB`, close the connection and, only while the file is the same
   one that failed (inode, size, mtime) and still fails a read, move `texra.db`,
   `-wal` and `-shm` aside to `texra.db.corrupt-<stamp>`. Open fresh and report
   `movedAside { reason: 'corrupt' }`.
3. Set `foreign_keys=ON` and `synchronous=NORMAL`, and verify the journal mode.
4. Check the stamps again, under the connection, and loop until the file is at
   `SCHEMA_VERSION`:
   - **A pre-1.0 store** (owner ruling Q3): nothing in it is kept,
     `current_value` and `input_history` included. `underCopy` (`storeAside.ts`)
     runs `VACUUM INTO` a staged copy, then `BEGIN IMMEDIATE` and re-reads
     `user_version` and `data_version`; if either moved, it discards the copy
     and the loop starts over. Otherwise it renames the copy to the first free
     `texra.db.pre1` name, drops every table and sets `user_version = 0`. The
     emptied file gets the 1.0 header with one `VACUUM`, and the open is
     reported as `movedAside { reason: 'pre-1.0' }`. No pre-1.0 table is read,
     so this path needs no knowledge of any earlier format.
   - **An empty file**: set `auto_vacuum`, then `BEGIN IMMEDIATE`, re-read
     `user_version`, and, if it is unchanged, apply the DDL and stamp
     `application_id` and `SCHEMA_VERSION`. Of two processes creating at once,
     the second sees 101 and does nothing.
5. `CREATE … IF NOT EXISTS` every additive index and projection table, set
   `journal_size_limit`, and set `busy_timeout` to 25 ms (§8).

`Database` then runs the store gate (below) and starts the `data_version` poll.
The gate runs again inside every write transaction.

A store that was released is never moved aside: only a stamp below
`BASELINE_1_0` is, and any other mismatch is refused untouched.

**Why not Effect's `Migrator`** (`effect/unstable/sql/Migrator`)? It fails four
ways here:

- it accepts a database newer than its migrations;
- it downgrades a `Locked` race to a debug log;
- it turns a failed migration into a defect;
- it cannot set `PRAGMA foreign_keys = OFF` outside its transaction.

It also keeps its own migrations table, which would be a second record of the
version next to `user_version`.

### Per-kind row versions

`packages/harness/src/shared/schemas/rowVersions.ts` is the registry:

```ts
export const ROW_KINDS: Readonly<Record<SessionEventDraft['type'], RowKind>> = {
  'run.start': V1,
  'run.config': { version: 4, upcast: [] },
  // … one entry per arm
};
```

- **Exhaustive by type.** A new arm without an entry does not compile.
- **Upcasters.** `upcast[i]` maps version `i + 1` to `i + 2` over plain JSON.
  Adjacent steps only; there is never a jump.
- **Decode** (`decodeRow` in `rowCodec.ts`) reads `(type, version, data)`.
  - A lower version with an upcaster chain is upcast step by step, then parsed
    with the current arm. A lower version with no chain fails its run's reads
    with `DatabaseRowEarlier`: the run is listed as written by an earlier build,
    never as damaged or silently stripped.
  - The current version is parsed directly.
  - A higher version fails with `DatabaseStoreNewer`.
  - A row that fails its schema, or a kind this build does not read, fails its
    own run's reads with `DatabaseRowCorrupt`, naming the row. The rest of the
    store opens.
- **Write.** Rows are always written at the current version. The codec upserts
  `stored_kind` with `max(version)` in the same transaction, once per distinct
  type in the batch.
- **Retired kinds.** A kind deleted from `ROW_KINDS` moves to
  `RETIRED_ROW_KINDS` in the same change. Its rows fail only their own run.
  `config/storage/row-kinds-ever.json` lists every core kind ever stored and
  never shrinks; `rowVersions.vitest.ts` checks that each is read or retired, so
  deleting a kind without retiring it fails before a store holding it is refused
  whole.

**The store gate** (`storeGate`). At open and inside every write transaction,
`Database` compares `stored_kind` with what this build reads: core kinds against
`ROW_KINDS`, each plugin arm (`plugin.fact/<plugin>/<kind>`) against its arm's
version, and the current values (one `current_value` entry) against
`CURRENT_VALUE_VERSION`. A kind or version this build does not read refuses the
whole store with `DatabaseStoreNewer`; nothing is rewritten. A retired core
kind, and a plugin kind whose plugin this build lacks, pass the gate. So no
build reads part of a store, or writes beside rows it cannot read.

**The release watermark** is the set of schemas frozen at a release.

- `npm run storage:freeze` (vitest `--mode freeze` over
  `src/test-kernel/schemas/rowVersions.vitest.ts`, a step in the `releasing`
  skill) writes `config/storage/frozen/<name>.v<N>.json`: the JSON Schema of
  each core kind's current arm, each plugin arm (`plugin.fact.<plugin>.<kind>`),
  and each current-value family (`current-value.<family>`). The highest N frozen
  for a name is its released version.
- `rowVersions.vitest.ts` fails when a released version's schema differs from
  its frozen file, when a current version is below its released one, or when a
  released version has no upcaster chain to the current one. Until the first
  freeze, `config/storage/frozen/` does not exist and these checks have nothing
  to compare.
- Until then every kind is unreleased: it changes with no upcaster, and its
  version is bumped when an older build's row would read wrong (or fail), so
  that row reads as an earlier build's. A dev store holding such a row lists
  that run as written by an earlier build; `texra doctor --prune-storage` or
  deleting the file resets it.
- The frozen files are test fixtures in JSON Schema, not a data format.

**Plugin arms** carry `{ version, upcasters }` (§6). A plugin kind whose plugin
this build lacks is kept byte for byte and left out of reads.

**Physical rewrite happens only at a major-version compaction.** A major release
may ship a compaction step: it reads every row through the upcasters, writes it
back at the current version, and then drops upcasters older than the new floor.
Minor releases never rewrite rows.

**Current values** decode with their family's schema where they are read; a row
that no longer decodes fails that read. All families write and read
`CURRENT_VALUE_VERSION` until one gains an upcaster.

**Policy (owner ruling Q2).** From the 1.0 release on, released row versions are
read forever through their upcasters, up to the next major compaction. The
upcasters run in the codec and nowhere else; that is the one sanctioned
compatibility reader. Before the release, AGENTS.md's "no compatibility readers"
rule stands unchanged, as `packages/harness/AGENTS.md` "Storage format" states
it. With the first freeze, that section takes this wording:

> The session database is the one store read across releases. Each row kind
> carries a version (`packages/harness/src/shared/schemas/rowVersions.ts`). A
> released version is read forever through adjacent upcasters that run in the
> row codec (`rowCodec.ts`) and nowhere else, until a major-version compaction
> rewrites the rows and retires the old upcasters. An unreleased version has no
> upcaster and may change freely until the next release freezes it
> (`config/storage/frozen/`). A store holding a row newer than the build is
> refused whole and never rewritten. A store from before 1.0 is moved aside
> whole (`texra.db.pre1`) and never read. No other persisted format gets a
> compatibility reader.

## 4. Decoupling `model.message` from `packages/llm`

A provider SDK or enum change in `@texra-ai/llm` is not a stored format change,
because storage owns the stored turn.

**A persisted subset schema owned by storage:**
`packages/harness/src/shared/schemas/storedTurn.ts`.

- **What the runtime branches on is strict and storage-owned:** content part
  kinds and their text or arguments, call identities, the finish reason, token
  counts, the origin (protocol, deployment, model) and the provider's response
  id.
- **What only a provider adapter reads back is opaque evidence,**
  `{ kind: string, data: JsonObject }`: finish, refusal and usage evidence, part
  signatures, encrypted reasoning, continuations and a remote operation's
  cursor. Storage keeps these bytes and never interprets them. `@texra-ai/llm`
  parses them when it replays to its own protocol, and refuses another
  protocol's evidence there.
- **Where conversion happens.**
  `packages/harness/src/agent/runtime/storedTurn.ts`, at the run history's
  boundary: `RunHistory` stores what the loop authored and folds what it reads
  through it. A turn the package can no longer read is a refusal of that run,
  never a default.
- **What the ratchet checks.** `storedShapeBoundary.vitest.ts` refuses a
  `@texra-ai/llm` import from any schema reachable from `SessionEventSchema`.

Rejected: storing the whole turn as open `{kind, data}`. The folds (usage,
calls, finish, pairing responses with settlements) would need llm's decoder,
which reintroduces the coupling.

Every persisted field of unknown shape is `JsonValueSchema`, not `z.unknown()`
(for example the trace event's `input`, `result` and `data`).

## 5. Projections

There are three projections. Each is a pure TypeScript projector over the
decoded event, with its own version in `projection_state`.

| Projection | Tables                                     | Input kinds                                                                                          |
| ---------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `listing`  | `listing_entry`                            | every kind with a `listingKeyOf` or `pendingKeyOf`                                                   |
| `usage`    | `projected_row` (`usage`), `run_usage`     | priced `model.message` responses, `context.edit` summaries, stored `usage` rows (agent-CLI children) |
| `model`    | `projected_row` (`run.model`), `run_model` | `run.config` whose model differs from the one before it                                              |

- **Who writes.** `Database.appendAll` runs the projectors inside its
  transaction, over the committed events it already holds as typed values, so
  there is no decode.
  - A projector returns row operations. `Database` executes them.
  - The usage and model projectors read their one prior row (`run_usage`,
    `run_model`) by primary key, in the same transaction.
  - After the batch, each projection's `through_commit` advances.
- **One definition, two consumers.** `listingKeyOf` and `pendingKeyOf` live in
  `sessionEvent.ts`. `pendingKeyOf` returns `{ open: key }` for `request.opened`
  and `followup.queued`, `{ close: key }` for their pairs, and `null` otherwise.
  The fold and the projector both call them, so no SQL restates them.
- **Rebuild on version mismatch, catch up when behind.** Every read of a
  projection first checks `projection_state` (one tiny row).
  - If the version differs from this build's, rebuild: empty the tables, then
    catch up. The rebuild is logged at info.
  - If `through_commit` is below the high-water commit, catch up: read `event`
    rows past `through_commit` of the projection's input kinds
    (`event_type_commit`), decode them through the codec, and apply the
    projector, 1,000 rows per transaction.
  - A build that appends while the stored projection version is not its own
    leaves that projection alone, so the build owning that version catches up on
    its next read.
  - Projections are never migrated. That was opencode's lesson: a migrated
    projection had to be wiped anyway.
  - Two builds with different projection versions on one store rebuild once per
    alternation. That is accepted.
  - Rejected: version-suffixed tables per build. They leave orphan tables that
    no build can safely drop.
- **Reads:**
  - `readListing`: `listing_entry` joined to `event` by commit, plus `run_usage`
    and each run's latest switch (`run_model.commit` → `projected_row`). No JSON
    functions; primary-key joins only.
  - `readDisplay`, `readDisplayAggregate` and `readInputBatch` use one
    display-union helper. It unions the selected `event` rows with
    `projected_row` rows in the same commit or aggregate range, joined to
    `event` for the envelope.
  - One tombstone predicate: `closed_by`.

## 6. Plugin storage API

A plugin declares its row kinds as arms on its `Plugin` value (`arms`),
collected by `armsOf` (`packages/harness/src/tools/plugins.ts`):

```ts
interface PluginArm {
  readonly plugin: string;
  readonly kind: string;
  readonly version: number; // current write version
  readonly schema: z.ZodType; // the current version's value
  readonly upcasters: readonly ((value: JsonValue) => JsonValue)[]; // v1→v2, …
}
```

- **Storage.** `plugin.fact` is one core kind,
  `{ plugin, kind, version, value }`. The plugin's `version` lives in the
  payload, so a plugin evolves without a core version. `stored_kind` records
  each arm's highest version as `plugin.fact/<plugin>/<kind>`, which the store
  gate reads (§3).
- **Decoding.** The codec checks the value against its arm after upcasting. A
  value newer than its arm refuses the store; an older one with no upcaster
  fails its run's reads as an earlier build's (`pluginFactArm`,
  `pluginFactFloor`).
- **Freezing.** Plugin arms join the frozen-schema fixtures at release.
- **Projection: none.** The listing keeps the latest row per (plugin, kind)
  through `listing_entry`. That is the one projection every plugin gets. A
  plugin that needs more derives it in its reader, over folded values. Plugin
  SQL projections would make each plugin a second writer.
- **Rows of removed or absent plugins** are kept byte for byte and left out of
  every read. They are collected with their run.
- **Third-party plugins get nothing durable in 1.0.**
  - This covers out-of-process code plugins and hooks
    (`2026-09-28-code-plugins-hooks-v1.md`).
  - Their effects are recorded as core `hook.outcome` rows by the run's one
    writer.
  - Their own state lives in `CLAUDE_PLUGIN_DATA`, outside the store.
  - They cannot declare row kinds. A durable third-party kind would need a trust
    and version story for code TeXRA did not ship, which is out of scope for
    1.0.

## 7. Hygiene

- **Vacuum.** `auto_vacuum = INCREMENTAL` is set at creation (§3). After a
  collection commits, `reclaimFreePages` (`storeSchema.ts`) returns the freed
  pages in autocommit steps of `incremental_vacuum(256)`, under the §8 retry, so
  another writer waits on one step, never the whole reclaim. A failed step is
  logged at warn, and the next collection reclaims the rest.
- **Blob collection.** Collection is by reachability, not refcount; a counter
  would be a second truth that drifts on partial paths.
  - `collectDeletion`'s final transaction reads the digests the collected
    aggregates' rows reference (`event_blob`).
  - The cascade from `event` removes those references. It then deletes the
    digests no remaining `event_blob` row names: a blob another run shares
    survives.
  - The `event_blob.digest` foreign key makes deleting a reachable blob
    impossible.
- **WAL.** `journal_size_limit` is 1 MiB.
- **Aside copies.** They are named `texra.db.pre1` and
  `texra.db.corrupt-<stamp>`, each at the first free name (`.2`, `.3`, …), so an
  earlier copy is never replaced. They are kept until an explicit prune deletes
  them.
- **Orphaned workspace stores.** Each project open records `{ root }` in the
  global store's `current_value` (family `workspace-store`, key: the storage
  directory id). An unchanged record is not rewritten.
  - `texra doctor --prune-storage` (`packages/cli/src/runtime/pruneStorage.ts`,
    over `readStorageInventory` and `deleteStorageInventory` in
    `projectDatabase.ts`) lists the stores whose recorded root no longer exists
    and the aside copies beside the stores that remain, with sizes, and deletes
    them once the user confirms. A store with no record is never an orphan.
    Deletion re-reads the inventory first and leaves anything no longer listed,
    and keeps an orphan another process has open.
  - Decided (Q4): whole orphaned stores are removed only by this explicit
    command, never automatically. An unmounted drive looks exactly like a
    deleted root.
- **Corrupt or NOTADB.** At open, the file is moved aside (§3, step 2) and
  reported through `movedAside`, whose `reason` is `'pre-1.0' | 'corrupt'`.
  Mid-session corruption fails the read instead. A file another connection may
  hold is never moved while it is open.
- **Workspace key.** The storage directory id
  (`packages/harness/src/platform/defaults/workspaceStorage.ts`) hashes an
  identity built for storage:
  - `realpathSync.native` on macOS and Linux. The JS `realpathSync` keeps the
    typed case, so on a case-insensitive volume one folder would yield two
    stores.
  - On Windows, the JS realpath stays (native rewrites a mapped drive to UNC),
    and the key is case-folded.
  - The host's displayed workspace path is unchanged; only the key differs.

## 8. Concurrency and host threading

- **Busy wait.** The open keeps `busyTimeout: '5 seconds'` (the WAL ordering
  needs it), then sets `busy_timeout = 25`.
  - Each transaction and read retries (`retryBusy`, `storeAside.ts`) only on
    `SQLITE_BUSY` and `SQLITE_LOCKED`.
  - The schedule is exponential from 5 ms, jittered, each sleep capped at 250
    ms, with a total of 5 s.
  - Every transaction body is database-only, so re-running it is safe.
  - Other fibers run between attempts, so a lock another process holds never
    freezes the Electron main process or the extension host.
- **Monotonic `observedCommit`.** Both the poll and the write path call
  `SubscriptionRef.update(observedCommit, (c) => Math.max(c, commit))`, so a
  poll that read the high-water mark before a local commit cannot set it
  backwards.
- **`data_version` polling** at 250 ms, one PRAGMA per tick per connection. The
  alternatives were rejected:
  - `sqlite3_update_hook` and commit hooks see only their own connection, and
    `node:sqlite` does not expose them.
  - `fs.watch` on `-wal` has no ordering, fires on checkpoints, and differs by
    OS (FSEvents coalescing, Windows locking). It would still need a read to
    learn what changed.
  - A socket broadcast between processes is a second channel that can drift from
    the store.
  - A background service is not the store's only process: the desktop and VS
    Code windows run their tasks in `texra serve` when they reach it
    (`packages/cli/src/runtime/cliService.ts`), but a headless `texra run`, an
    SDK embedder and a window that cannot reach the service open the store
    themselves, so the poll stays.
- **Typed failures.** `DatabaseOpenFailed`, `DatabaseReadFailed` and
  `DatabaseWriteFailed` carry the store's path and the SQL cause; their message
  adds SQLite's own reason (`database is locked`). The gate and the codec raise
  `DatabaseStoreNewer`, `DatabaseRowCorrupt` and `DatabaseRowEarlier`. A row or
  draft that contradicts the store's own protocol is a defect (`invariant` in
  `Database.ts`).
- **Worker thread: not taken.**
  - Every hot query uses an index, transactions are short and do no I/O, and the
    projections turn the heaviest statement (the listing's grouped JSON
    aggregation) into primary-key joins. The freeze known when this was decided
    was the busy wait, which the retry above removes.
  - The worker is **format-neutral**: the `Database` service interface is
    already the RPC seam, so taking it later rewrites no storage.
  - **Decided (Q5): the worker is deferred past 1.0.** It is taken only if a
    measured host event-loop stall attributable to the database exceeds 100 ms.

## 9. Module split for `Database.ts`

The store splits by real owners only. Each module owns tables or a stored
contract and has more than one consumer.

| Module             | Owns                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `Database.ts`      | the connection, transactions, seq/commit/claims, lifecycle edges, deletion and collection, the reads, the `data_version` poll |
| `storeSchema.ts`   | DDL, PRAGMAs, `SCHEMA_VERSION`, the open sequence, the pre-1.0 and corrupt moves, page reclaim                                |
| `storeAside.ts`    | aside copies and their names, the busy retry, proving claim owners off the write lock, the damaged-file test                  |
| `rowCodec.ts`      | encode, decode, upcast, blob externalization, aggregate id mapping, the store gate                                            |
| `rowReader.ts`     | one connection's reader of selected rows, the runs it cannot open and why, and the tool cards' read-time output (§10)         |
| `projections.ts`   | the three projectors, their tables' SQL, their versions and catch-up                                                          |
| `currentValues.ts` | `current_value`, `input_history`, and the values' change feed                                                                 |

- **The deletion lifecycle stays in `Database.ts`.** It writes `event_sequence`,
  and the write ratchet admits one writer. Moving it beside `deletionCleanup.ts`
  would make a second one.
- **The aggregate graph is one function.** `edgesOf(draft)`, beside
  `referencedAggregates` in `sessionEvent.ts`, returns the parent to stamp
  (`run.start`), reparenting and the borrowed claim (a `plugin.fact` on a
  plugin-owned aggregate), and closure (`run.removed`). Reads and writes share
  that one statement of the graph.

No module exists only to be called once.

## 10. Tool output stored once

Decided (owner ruling Q1): tool output is stored once.

- On a run with a run history, `tool.end` keeps `{logId, status, files}` and
  stores no `result`.
- The display read already selects the batch, and the `tool.result` rows commit
  in the same transaction; a commit range never splits a transaction.
- `settleCards` (`rowReader.ts`) fills the card's output from the `tool.result`
  committed with it, and the run history row is dropped before anything leaves
  the store. Renderers, the transcript fold and the history query store see the
  card with its output; `tool.result` never reaches a transport.
- Runs without a run history (the agent-CLI children, whose cards
  `TraceEmitter.openToolCard` writes) keep `result` on the card.

The card is still loop-owned: the run loop writes it, it commits in the
settlement batch, and there is no tool-side card and no second append path.
CLAUDE.md "One publisher, loop-owned cards" states the rule.

Rejected: keeping both copies and capping `tool.end` at a display preview. Full
output would then live only in a row renderers may not read.

## 11. Testing

These suites are the store's end-to-end and conformance coverage. They follow
the testing discipline's bar: no unit tests over churning internals.

- **Golden 1.0 store.** `src/test-kernel/fixtures/storage/golden-1.0.sql`,
  SQLite's own `.dump` format, written by the real CLI
  (`packages/cli/scripts/generate-golden-store.mjs`,
  `pnpm --filter @texra-ai/cli run golden:store`) with the internal validation
  model, against a temporary HOME and project. The script's header lists what it
  holds: tool calls, an approved plan, an awaited child, runs sharing context
  blobs, a document task's output fact, a goal, a mid-run model switch, a
  `/compact` `context.edit`, a hook outcome, a parked and a detached child, and
  a queued follow-up. It holds only cleanly finished runs; interrupted states
  come from the crash-point suite (`crashConformance*.vitest.ts`), which
  truncates a clean store at each commit.
- **Conformance suite**
  (`src/test-kernel/controllers/session/goldenStore.vitest.ts`):
  - every row decodes to an event;
  - the `SessionView` and `RunState` folds equal their pinned values;
  - a store a newer build wrote to is refused, and nothing is rewritten;
  - each projection, rebuilt from zero, equals its incremental tables row for
    row;
  - the listing equals the fold over full history;
  - a run killed after its command's effect landed resumes with an unknown
    outcome, never running the command again.
- **Refusal corpus**
  (`src/test-kernel/controllers/session/sessionEvents.vitest.ts`), each store
  generated in the test, with no binary fixtures: a newer `SCHEMA_VERSION` is
  refused untouched, a foreign file is refused, a truncated file is moved aside
  and a fresh store opened, a pre-1.0 store is retired whole to `.pre1` with
  nothing carried over, and a store with one corrupt run still opens and lists
  the healthy ones.
- **Two-OS-process test** (same file): a child Node process appends to the same
  file while the parent appends and reads. It asserts dense seqs and no lost
  appends, a monotonic `observedCommit`, and that the parent's thread is not
  held in SQLite's busy wait past the 25 ms slice.
- **Row versions** (`src/test-kernel/schemas/rowVersions.vitest.ts`): the
  per-kind frozen schemas of §3, and every kind ever stored read or retired.

## 12. Plan

All four lanes of the plan have landed (the 1.0 store, stored contracts,
hygiene, and the golden store with its suites), with one physical layout:
`SCHEMA_VERSION` 101. One step is a release action, not a lane: at the first
release that promises its rows, run `npm run storage:freeze` (the `releasing`
skill) so the frozen schemas become the floor every later build reads, and
change `packages/harness/AGENTS.md` "Storage format" to the §3 wording in the
same change.

## 13. Decisions (2026-09-28)

Every question this note raised is decided. Q6 and Q7 are the owner's 2026-09-30
constraints on the store.

| #   | Question                               | Decision                                                                                                                                             | Where                       |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Q1  | Tool output stored twice               | Store it once. The `tool.end` card is filled from its `tool.result` at read time. The card stays loop-owned; only its output is projected.           | §10                         |
| Q2  | Compatibility after 1.0                | From the 1.0 release on, released rows are read forever through upcasters, in the codec only. Before 1.0 the "no compatibility readers" rule stands. | §3; AGENTS.md at the freeze |
| Q3  | What a pre-1.0 store keeps at the bump | Nothing. The whole store, `current_value` included, moves aside to `.pre1`, and the store starts fully clean.                                        | §3 open sequence            |
| Q4  | Removing orphaned stores               | Only by an explicit `texra doctor --prune-storage`, never automatically.                                                                             | §7                          |
| Q5  | Moving SQLite to a worker thread       | Deferred past 1.0. It is taken only if an event-loop reading shows a stall over the 100 ms budget.                                                   | §8                          |
| Q6  | A daemon owning the store              | Refused (D4). The CLI or SDK process is the unattended runner; several processes share one store, each aggregate held by one claim.                  | §8; ledger                  |
| Q7  | Where a run's retained outputs live    | SQLite (D5). Files are for compiler scratch only.                                                                                                    | §10; ledger                 |
