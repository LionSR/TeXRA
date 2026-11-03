# Session store: holistic review and the 1.x compatibility policy

Date: 2026-11-03
Status: proposed — a read-only review of the storage layer against the 1.0
design (`.agents/docs/implemented/architecture/2026-09-28-storage-v1-design.md`),
with the post-1.0 compatibility policy stated as rules and the pre-freeze
changes those rules need. Baseline: `main` at `b411a6d`.

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

## 4. Verified

- Every path and symbol above was read in the tree at `b411a6d`.
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
- Not run: the test suite, `check:core-quality`, any measurement of F9.
