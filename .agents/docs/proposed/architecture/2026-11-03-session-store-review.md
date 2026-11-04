# Session store: holistic review and the 1.x compatibility policy

Date: 2026-11-03
Status: proposed — a read-only review of the storage layer against the 1.0
design (`.agents/docs/implemented/architecture/2026-09-28-storage-v1-design.md`),
with the post-1.0 compatibility policy stated as rules and the pre-freeze
changes those rules need. Baseline: `main` at `9062f1b` (first read at `b411a6d`; the 2026-11-04 rulings reconciled in §5).

## Summary

The store's design holds: one codec knows the stored shape, one publisher
writes, one gate refuses what a build cannot read, projections rebuild from
the rows, and a real store the CLI wrote (`src/test-kernel/fixtures/storage/golden-1.0.sql`)
is read by every build. The owner's question ("we cannot break them forever
after 1.0") is answered by bounding "forever" with major versions, which is
what desktop apps, ORMs and event-sourced systems do. Three facts the readers
need are still inferred at read time instead of stored, and the current-value
families have a freeze but no evolution path. Those are cheap to fix before
the freeze and a major-version change after it. One structural change,
making the SQLite connection a module of its own, takes the 1,075-line
`Database.ts` down to the aggregate store it is.

## 1. Policy after 1.0

Each rule names its precedent so the reasoning stays checkable.

| #   | Rule                                                                                                                                                                                                                                                                                                                  | Precedent                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| P1  | A released row kind changes additively for free (a reader ignores unknown fields, an absent optional field is its default). A change an older build would read wrong bumps the kind's version with an adjacent upcaster in the same commit; `rowVersions.vitest.ts` enforces it once `config/storage/frozen/` exists. | Protocol Buffers' field rules; event-sourcing upcasters (Axon, EventStoreDB); SQLite's read/write version |
| P2  | A change no stored data can fill is a new kind; the old one is retired as `execution` and its runs read as an earlier build's, read-only.                                                                                                                                                                             | Event sourcing: a new event type, never a mutated one                                                     |
| P3  | Within a major, DDL only grows: `CREATE … IF NOT EXISTS` and guarded `ADD COLUMN` at every open, no stamp bump. A rebuild or changed constraint bumps `SCHEMA_VERSION` as one forward step in `BEGIN IMMEDIATE`, tested against the golden store. No downgrade step exists.                                           | Rails, Django, Flyway, Prisma; Firefox `places.sqlite`; Core Data lightweight migration                   |
| P4  | An older build refuses a newer store whole, untouched, naming the host to update. Three hosts share one `texra.db` per project; P1 and P3 keep the event rare.                                                                                                                                                        | Firefox downgrade protection; Chromium's `MetaTable` (which razes instead)                                |
| P5  | A major version compacts (reads every row through the upcasters, writes it back current) and drops the upcasters below its floor. 2.0 reads any 1.x store; 3.0 reads any 2.x store.                                                                                                                                   | PostgreSQL `pg_upgrade`; Django `squashmigrations`; Kubernetes N-1 storage versions                       |
| P6  | Projections are never migrated: a new projector version rebuilds its table. Current values live outside the event tables and never clear.                                                                                                                                                                             | CQRS read models                                                                                          |
| P7  | Nothing else gets a compatibility reader: a pre-1.0 store moves aside whole, `trace.json` fails loudly, `config.json` is additive-only.                                                                                                                                                                               | AGENTS.md "Compatibility and format retirement"                                                           |

These restate the design's Q2 ruling with the support window made explicit
(P5) and the DDL rule split into additive and rebuild (P3).

## 2. What the review found

Read: `storeSchema.ts`, `rowCodec.ts`, `rowReader.ts`, `rowVersions.ts`,
`projections.ts`, `currentValues.ts`, `valueFamily.ts`, `Database.ts`,
`database.ts`, `SessionEvents.ts`, `sessionEvents.ts`, `sessionStore.ts`,
`sessionLog.ts`, `sessionOwners.ts`, `sessionLayer.ts`, `storeAside.ts`,
`deletionCleanup.ts`, `projectDatabase.ts`, `readSessionView.ts`,
`ownerLiveness.ts`, `goldenStore.vitest.ts`, `rowVersions.vitest.ts`,
`storedShapeBoundary.vitest.ts`.

### Kept, and worth saying so

- The codec boundary is a ratchet (`storedShapeBoundary.vitest.ts`): no
  SQL reads a payload field, nothing above the codec sees a version.
- One publisher, one write path, `STRICT` tables, `BEGIN IMMEDIATE`,
  fiber-side busy retry, the store gate at open and in every write.
- Content-addressed blobs with reachability collection; incremental vacuum;
  an explicit prune; a network filesystem refused at open.
- The golden store and the crash-conformance suite (a clean store truncated
  at every commit and resumed) are the compatibility tests the policy needs.

### Facts inferred at read time that should be stored (before the freeze)

| #   | Finding                                                                                                                                                                                                                                                                                                                                     | Where                                                                                                   | Fix                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Current-value families are frozen one schema each, but share one version constant (`CURRENT_VALUE_VERSION`), one `stored_kind` entry (`current_value`) and have no upcaster hook: `ValueFamily` is `{ name, schema, deletable }`. The first family change after 1.0 has no path but refusing every older build for a family it never reads. | `valueFamily.ts`, `currentValues.ts` (`UPSERT_VALUE`, `decodeValue`), `rowCodec.ts` (`readableVersion`) | `ValueFamily` gains `version` and `upcast`, like `RowKind`; the row's existing `version` column carries it; `stored_kind` records `current_value/<family>`; `decodeValue` upcasts. Seven families are declared today. |
| F2  | `event_blob` links two different things, an inline reference to inflate and a media address never to inflate, with no discriminator. The reader therefore finds references by a regex over the JSON text (`blobDigests`) after a `decodable` pre-check, a second source of the row-to-blob fact beside the table.                           | `rowReader.ts` `blobDigests`; `rowCodec.ts` `encodeDraft` (`blobs` vs `references`)                     | Add `event_blob.inline INTEGER NOT NULL` (additive) and read a batch's references with one `json_each` statement; delete the regex and the pre-check.                                                                 |
| F3  | A batch's identity is inferred: the display pager ends a page at the first row whose `at` differs (`DISPLAY_PAGE_END`), because a `tool.end` card is settled from the `tool.result` in its batch (`settleCards`) and "a batch's rows share one `at`" is relied on across modules.                                                           | `Database.ts` `DISPLAY_PAGE_END`, `readDisplay`; `rowReader.ts` `settleCards`                           | Store the batch: `event.batch INTEGER` (the batch's first commit, additive). The pager reads the page end from it; the `OFFSET 1999` query and the `at` invariant go.                                                 |
| F4  | A released stamp below `SCHEMA_VERSION` is refused ("no step from it exists") and the additive DDL has no `ADD COLUMN` form, so the first column after 1.0 cannot land in a minor and the first rebuild has no home.                                                                                                                        | `storeSchema.ts` `checkStamps`, `ADDITIVE`                                                              | An empty forward-step table keyed by stamp, a guarded `ADD COLUMN` helper over `pragma_table_info`, and a test that opens `golden-1.0.sql` after the steps.                                                           |

F1 to F3 are row or column additions: free now, a major-version change once
1.0 ships.

### Structure

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Where                                                                                            | Red flag                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| F5  | The connection is an implicit module. `currentValues` takes `{ exec, execOne, transact, query, level, valueWritten }`, `projectionUpkeep` takes `(exec, read, path)`, `rowReader` takes `exec`, `storeGate` takes `exec`: four modules each handed the connection as a bag of closures. `Database.ts` (1,075 lines) holds that plumbing (transactions, savepoints, busy retry, owner proving, the `data_version` poll, three change coordinates) beside aggregate rules (the seq-1 rule, parent stamping, close needs dependent claims). | `Database.ts` lines 60 to 330; `currentValues.ts` signature; `projections.ts` `projectionUpkeep` | services bag; two abstractions in one module |
| F6  | `Database` has 21 members over five concerns (history, claims, deletions, values and input history, the clock). `deletions`, `values` and `inputHistory` are grouped already; the rest are flat.                                                                                                                                                                                                                                                                                                                                         | `database.ts`                                                                                    | wide record                                  |
| F7  | Three change coordinates (`level`, `observedCommit`, `aggregate_change.change`) plus the 250 ms `data_version` poll. Each is justified in its own comment (a claim change wakes without an event; commits only move forward); nothing states the three together.                                                                                                                                                                                                                                                                         | `Database.ts`, `storeSchema.ts`                                                                  | non-obvious code                             |
| F8  | A projected display row is read as an event with `NULL AS version`, and the codec treats a null version as current. The listing is a three-way `UNION ALL`.                                                                                                                                                                                                                                                                                                                                                                              | `rowReader.ts` `PROJECTED_COLUMNS`, `READ_LISTING`; `rowCodec.ts` `rowUpcasts`                   | small information leak; keep                 |
| F9  | `EARLIER_RUNS` runs one index-range scan per kind above version 1 (17 today) on the first strict read of each process, plus a scan of every plugin fact. After the freeze these find nothing in practice.                                                                                                                                                                                                                                                                                                                                | `rowCodec.ts` `EARLIER_RUNS`, `rowReader.ts` `scan`                                              | measure before acting                        |
| F10 | `OwnersUnproven` is thrown as a defect so no body can swallow it, caught by the outermost transaction, which proves the owners off the lock and reruns. Deliberate; the comment says why.                                                                                                                                                                                                                                                                                                                                                | `storeAside.ts`                                                                                  | non-obvious; keep                            |

### Target structure

```
 StoreConnection   (new, ~250 lines from Database.ts)
   read / write / derive transactions, savepoints, busy retry, owner proving,
   exec, currentCommit, the wake level and observed commit, the data_version poll
         ▲
 Database          (the aggregate store, ~550 lines)
   append with the lifecycle rules, claims, deletion and collection, the reads
         ▲                      ▲                   ▲
 currentValues         projectionUpkeep         rowReader + storeGate
   over StoreConnection, no closure bags
```

Nothing above `Database` changes. The `Database` service is regrouped once
(`history`, `claims`, `deletions`, `values`, `inputHistory`, `clock`) when
F5 lands, since every caller is touched then anyway.

## 3. Slices

| Slice | Change                                                                                                                                                                                            | When                      | Net LoC |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------- |
| S1    | F1: per-family version and upcasters; `stored_kind` per family; golden store regenerated                                                                                                          | before the freeze, must   | +60     |
| S2    | F2: `event_blob.inline`; references read from SQL; regex and `decodable` pre-check deleted                                                                                                        | before the freeze, must   | −20     |
| S3    | F3: `event.batch`; pager reads the batch end; `DISPLAY_PAGE_END` and the tombstone bookkeeping it needs deleted                                                                                   | before the freeze, should | −40     |
| S4    | F4: forward-step table (empty), guarded `ADD COLUMN`, golden-store upgrade test                                                                                                                   | before the freeze, must   | +80     |
| S5    | F5: `StoreConnection` extracted; closure bags gone; `Database` regrouped (F6)                                                                                                                     | any time                  | −50     |
| S6    | F7: one comment in `StoreConnection` naming the three coordinates and what each wakes                                                                                                             | with S5                   | +15     |
| S7    | `npm run storage:freeze`, commit `config/storage/frozen/`, replace the "Storage format" paragraph of `packages/harness/AGENTS.md` with the post-freeze wording in the design (§3), state P5 there | the release               | docs    |

Order: S1, S2, S3, S4 land first, each regenerating the golden store; S5 and
S6 any time; S7 is the release step. S1 to S4 are the only ones the freeze
makes expensive to defer.

## 4. Codex CLI (Rust) and OpenCode v2, compared

Two coding agents that persist sessions in SQLite, read from their public
sources and issue trackers on 2026-11-03. Neither is a model to copy whole;
each has paid for a lesson TeXRA can take for free.

| Dimension               | Codex CLI (`codex-rs`)                                                                                                                                                                                                                                                                                                                                                         | OpenCode v2 (`anomalyco/opencode`)                                                                                                                                                                                                             | TeXRA                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Source of truth         | One append-only JSONL rollout per session under `~/.codex/sessions/YYYY/MM/DD/`, cold files zstd-compressed. SQLite is derived: `state_5.sqlite` (thread index, backfilled from rollouts), `thread_history_1.sqlite` (a UI projection), plus logs, memories, goals and queue databases.                                                                                        | One `opencode.db` for every project, authoritative, Drizzle-managed: relational `session_v2`, `session_message`, `project`, `workspace`, plus durable `event` and `event_sequence` tables and a `kv` table.                                    | One `texra.db` per project, authoritative, event-sourced: `event` and `event_sequence`, projections rebuilt from the rows.                 |
| Schema versioning       | sqlx migrations embedded at compile time, numbered (`0036_drop_thread_dynamic_tools.sql`), forward-only, checksummed in `_sqlx_migrations`. A breaking generation is a new file name (`state_5`, `logs_2`, `memories_v2`), rebuilt from the rollouts.                                                                                                                          | Drizzle migrations by timestamp (`20261010180456_project_time_archived`) in a `migration` table, plus application migrations tracked in `kv` (`migration.v1-v2`). A breaking generation is a new table family (`session_v2` beside `session`). | `user_version` for the DDL, a version per row kind with upcasters in one codec, a version per projection.                                  |
| Older build, newer file | Tolerated by design: the runtime migrator sets `ignore_missing: true` so "an older binary can open a database already migrated by a newer binary running in parallel"; known versions are still checksum-checked. Safe because the database is an index.                                                                                                                       | Not detected. OpenCode 1.19 on a v2 database fails at runtime with `no such column: project_id` and answers HTTP 500 for every session (#55555); a Desktop build refused a database the v2 CLI had migrated.                                   | Refused whole, untouched, naming the kind and version (P4).                                                                                |
| Row evolution           | `cli_version` in the session header, no schema version. The reader is tolerant: it skips lines that do not parse, drops legacy `ghost_snapshot` items, treats `ordinal` as optional. Compatibility code accumulates in the reader.                                                                                                                                             | JSON columns inside relational rows. The v1 to v2 import copied rows unchanged, leaving every session from a non-git directory on the synthetic `global` project and hidden from the list (#41217, #55253, #56312; fix PR #51935 open).        | Per-kind versions with adjacent upcasters; a change that cannot be upcast retires the kind (P1, P2).                                       |
| Pre-1.0 data            | Never had a break: the JSONL format predates the databases, which were added beside it.                                                                                                                                                                                                                                                                                        | JSON files to SQLite in 1.2 (the migration gate was "does `opencode.db` exist", so incremental upgrades skipped it, #13654; 1.2.3 asked users to delete the database and rerun, #13636), then v1 to v2 inside the same file.                   | Moved aside whole to `texra.db.pre1`, never read (Q3). No import, so none of that class of bug.                                            |
| Derived state           | Index and rollouts drift: 274 of 462 sessions missing from the index (#22452); `doctor` reports 231 missing, 179 stale and 45 duplicate thread rows with no fix command (#55933); the history projection is written incrementally with no reconciliation and was never rebuilt after a crash (#40112); backfill stuck at `running` behind a 30 s GUI timeout (#28087, #23787). | Not applicable: no derived store.                                                                                                                                                                                                              | Projections carry a version in `projection_state`, are rebuilt in the reading transaction of the same file, and are never read half-built. |
| Corruption              | `quick_check` at open with a 100 ms budget; on corruption the database and its sidecars move to `db-backups/sqlite-<ts>-<n>` and a fresh one is rebuilt from the rollouts; the history projection is simply unavailable. Earlier, a corrupt `state_5.sqlite` wedged startup (#21750).                                                                                          | Not described.                                                                                                                                                                                                                                 | `SQLITE_CORRUPT` or `NOTADB` at open moves the file to `.corrupt-<stamp>`; no second source to rebuild from. No `quick_check` at open.     |
| Network filesystems     | Detects NFS and runs the database in `DELETE` journal mode there, with a WAL-to-DELETE migration module that stages, integrity-checks and swaps the file.                                                                                                                                                                                                                      | Not described.                                                                                                                                                                                                                                 | Refuses a non-local filesystem at open (`localDatabasePath.ts`).                                                                           |
| Several processes       | Expected: `busy_timeout` 5 s, connect and migration retried on busy, migrations in one transaction (sqlx's own lock is a no-op), binaries of different versions in parallel.                                                                                                                                                                                                   | One global file shared by CLI, Desktop and `serve`; a migration ran under `serve` while the TUI read (#13611).                                                                                                                                 | One file per project, claims by owner with liveness proofs, `BEGIN IMMEDIATE`, retry on the fiber.                                         |
| Migration file hygiene  | A 0.130 to 0.131 update failed with "migration 1 was previously applied but has been modified": the Windows build hashed migration SQL with CRLF, the WSL build with LF (#23787). A later renumbering needed `repair_legacy_recency_migration_version`.                                                                                                                        | Not described.                                                                                                                                                                                                                                 | DDL lives in TypeScript source; the frozen fingerprints are compared as file text.                                                         |

### What the comparison changes

- **P4 is confirmed by OpenCode's failure mode.** An undetected newer schema
  turned into runtime 500s for every session. Refusing whole, untouched, is
  the right side.
- **P3's additive rule gives TeXRA Codex's tolerance for free.** A newer
  build's extra column or table is invisible to an older build that names
  its columns. Codex needs `ignore_missing` because its migrations are the
  only stamp; TeXRA needs nothing.
- **Q3 is confirmed by both.** OpenCode's two in-place imports produced four
  months of hidden-session reports; Codex never had to import. Moving a
  pre-1.0 store aside whole costs visibility of pre-release runs and nothing
  else.
- **P6 is stronger than Codex's projections.** A projection rebuilt inside
  the reading transaction of the same file cannot drift or be read torn,
  which is what #40112 and #55933 are about.
- **Codex's per-major file name is TeXRA's compaction.** `state_5.sqlite`
  is a new file rebuilt from the rollouts; TeXRA has no rollout to rebuild
  from, so a major compacts in place (P5). Same bound, different mechanism.
- **The `session_v2` table name is the `type.vN` pattern the 1.0 design
  rejected**, and the v1 and v2 families now coexist in one file, which is
  what the "no dual formats" rule in `AGENTS.md` exists to prevent.

Two findings to add:

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                   | Fix                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F11 | The frozen fingerprints (`config/storage/frozen/*.json`) are compared to the generated text byte for byte, and the repository has no `.gitattributes`. A Windows checkout with `core.autocrlf` would rewrite them with CRLF and fail every released kind, which is Codex's #23787 in miniature.                                                                           | `.gitattributes` with `config/storage/frozen/** text eol=lf` and `src/test-kernel/fixtures/storage/** text eol=lf`, before the first freeze.                                      |
| F12 | The store never runs `PRAGMA quick_check`; corruption is met either as `SQLITE_CORRUPT` at open or as a failed read mid-session. Three hosts run three SQLite builds against one file (the CLI's Node, Electron's, VS Code's), and the driver (`@effect/sql-sqlite-node` 4.1.0 over `node:sqlite`) pins no minimum; Codex requires 3.51.3 for a WAL-reset corruption fix. | A bounded `quick_check` at open (Codex budgets 100 ms) that moves a failing file aside the same way, and a recorded minimum SQLite version checked at open with the Node version. |

Sources: the `openai/codex` tree (`codex-rs/state/src/{runtime,sqlite,migrations,nfs_migration,runtime/recovery}.rs`, `codex-rs/rollout/src/recorder.rs`) and issues #21750, #22452, #23787, #28087, #40112, #55933; the `anomalyco/opencode` issues #13636, #13654, #41217, #55253, #55555, #56312 and PR #51935; the agentbridge PR #1199, which writes the v2 schema; a third-party write-up of the Codex session lifecycle (codex.danielvaughan.com, 2026-06-08).

## 5. Reconciled with the rulings of 2026-11-04

Two notes were accepted by the owner on 2026-11-04, after this review's
first baseline:
`.agents/docs/proposed/architecture/2026-11-03-one-fact-one-representation.md`
(O1: one process per project store, held by SQLite's own exclusive lock;
claims, liveness proofs and takeover deleted; the freeze waits for its
slices 2, 3, 4 and D) and
`.agents/docs/proposed/simplification/2026-11-03-storage-errors-and-stop-paths.md`
§1 (the upcast fields and loops deleted until a first upcaster exists; a
`ValuesStore` layer split from the event `Database`, with the global database
opened on it; one value gate; `databaseLayer({ file, create })`; one busy
policy). In the same day `main` bumped six row kinds (`run.end` 4 to 6,
`run.position` 2 to 3, `log` 4 to 5, `response.finalized` 1 to 2,
`model.message` 9 to 11, `context.edit` 6 to 7) and regenerated the golden
store four times. After the freeze that day's work is six upcasters. What
changes in this note:

| Item     | Before                                       | After the rulings                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P4       | Three hosts share one `texra.db`             | One process holds a project store; a second opener attaches to the service. The file meets another build only after the holder exits, and P4 still decides that open. The **global store stays multi-process** and holds current values alone, so the mixed-build case moves to `current_value`: F1 is now the main cross-build fact, not a side one.                                                                                                                   |
| P1       | Upcasters run in the codec                   | The deletion is right before the freeze: with no upcaster written, the loops cost every read and prove nothing. It needs one sentence of policy beside it (decision D-A below), or the empty machinery invites bump-and-refuse after the freeze, which reads every older run as an earlier build's.                                                                                                                                                                     |
| F1, S1   | Per-family `version` and `upcast`            | Narrowed: a per-family `version` and one `stored_kind` entry per family; no `upcast` field until a first upcaster exists; the per-read version check goes with "one value gate". Best landed inside the `ValuesStore` split, which touches every site anyway.                                                                                                                                                                                                           |
| F4, S4   | A step table before the freeze               | Now urgent. O1's slice deletes `event_sequence.owner_id`: a column drop is a table rebuild and a `SCHEMA_VERSION` bump, after which every stamp-101 store (every developer's, and the golden fixture as loaded) is refused with "no step from it exists". Either S4 lands before the lock slice, or the column stays as an unused nullable column until the first major (P3's additive rule; a dead column is not a compatibility reader). Recommend: the column stays. |
| F5, S5   | `StoreConnection` out of `Database.ts`       | Smaller and more useful. The claim half (about 250 lines: `acquireClaims`, `releaseClaims`, `claimOwner`, `claimAll`, `prepareRunRemoval`'s claim half, `provingOwners`) leaves with O1, and the `ValuesStore` split needs exactly the connection module: both stores open over one `StoreConnection`. Land S5 before or with the split.                                                                                                                                |
| F7       | Three change coordinates and a poll          | After O1 the 250 ms `data_version` poll and the `aggregate_change` triggers serve only the global store; a project store has one writer. New F13: scope both to the global store and delete `aggregate_change` (its reader is `readInputBatch`'s `changedSince`, which tracked claim changes; an existence change is an event).                                                                                                                                         |
| F10      | A defect as control flow, kept               | Deleted with O1 (`OwnersUnproven`, `provingOwners`, `reclaimable`). Nothing to keep.                                                                                                                                                                                                                                                                                                                                                                                    |
| P5       | A major compacts in place                    | Unchanged. The lock design's sentence "a store's schema change is a version bump, not an upcaster" describes the pre-freeze slice; after the freeze P1 and P2 govern.                                                                                                                                                                                                                                                                                                   |
| §4 table | TeXRA: one file per project, claims by owner | After O1: one process per project store (pi's model), the global store multi-process with a busy retry (Codex's model for its databases).                                                                                                                                                                                                                                                                                                                               |

**Decision for the owner (D-A).** After the freeze, a breaking change to a
released kind ships its adjacent upcaster or a new kind (P1, P2);
bump-and-refuse ends at the freeze. `rowVersions.vitest.ts` enforces the
chain once `config/storage/frozen/` exists, so the accepted deletion keeps
the test's chain check and the registry's place for `upcast` (an empty
tuple costs nothing), or re-adds both with the first upcaster in the same
PR as the first post-freeze bump.

**Revised order.** S4, or the decision to keep `owner_id`, before the lock
slice. S2 and S3 before the freeze. S1 inside the `ValuesStore` split, S5
before or with it. F13 inside the lock slice. S7 after the one-fact note's
slices 2, 3, 4 and D, as that note rules.

## 6. Verified

- Every path and symbol in §2 was read at `b411a6d` and re-checked at `9062f1b`: the closure-bag signatures, the blob regex, `DISPLAY_PAGE_END`, `ValueFamily`, `checkStamps` and `ADDITIVE` are unchanged; `Database.ts` is 1,069 lines after the Effect built-ins refactor (#14635).
- `config/storage/frozen/` does not exist; `rowVersions.vitest.ts` has
  nothing to compare until `storage:freeze` runs.
- `src/test-kernel/fixtures/storage/golden-1.0.sql` exists (690 KB, written
  by the real CLI via `pnpm --filter @texra-ai/cli run golden:store`).
- `ValueFamily` has no version or upcaster field; `UPSERT_VALUE` writes the
  shared constant; `readableVersion` gates one `current_value` entry.
- `blobDigests` scans `row.data` with `/"\$b":"([0-9a-f]{64})"/g`;
  `event_blob` has no discriminator column.
- `DISPLAY_PAGE_END` finds the page end by `e.at <> last.at`.
- `checkStamps` refuses a released stamp other than `SCHEMA_VERSION`;
  `ADDITIVE` holds only `CREATE … IF NOT EXISTS` statements.
- No `.gitattributes` is tracked; `@effect/sql-sqlite-node` 4.1.0 declares
  no SQLite driver dependency in `pnpm-lock.yaml`, so it uses `node:sqlite`.
- The Codex and OpenCode facts come from their public sources and issue
  threads as read on 2026-11-03; where a page gave only a reporter's
  analysis and no maintainer reply, the table says so by citing the issue.
- Not run: the test suite, `check:core-quality`, any measurement of F9.
