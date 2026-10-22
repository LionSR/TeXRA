# Current-value SQLite rows for non-run state

Date: 2026-09-22

Status: implemented

## Decision

Latest-value application state lives in one `current_value` table per
storage root, outside the event history. A repeatedly changed key keeps one
row, not every prior value; no production reader needs the discarded
history. The run/session event journal and the bounded `input_history`
table stay as they are. There is no migration, dual writer, legacy reader
or adapter, and no `state.value.set` event arm.

The owner accepted this bounded table on 2026-09-22.

## Shape

- Table (`packages/harness/src/controllers/session/storeSchema.ts`):
  `current_value(family, key, version, value, at)`, primary key
  `(family, key)`, `STRICT, WITHOUT ROWID`, indexed on `(family, at)`.
  `version` is the row shape's version (`CURRENT_VALUE_VERSION`,
  `shared/schemas/rowVersions.ts`); `at` is the write time and orders a
  family's listing (latest first).
- One writer (`controllers/session/currentValues.ts`): every write is one
  `BEGIN IMMEDIATE` with no aggregate claim. `CurrentValues.modify` reads
  the row, applies the caller's change and writes under the same write lock,
  so a read/modify/write never loses a concurrent change from another
  connection or process. A change that leaves the stored text equal writes
  nothing. Only a deletable family may delete its row.
- Reads (`CurrentValues` in `shared/session/database.ts`: `get`, `modify`,
  `list`, `changes`): a value decodes with its family's Zod schema at the
  database boundary. A row that no longer decodes fails the read; a row a
  newer build wrote fails as `DatabaseStoreNewer`. Neither reads as a
  default.
- Change feed: `changes(family, keys)` re-reads the keys on each wake of the
  connection's level (local commits and the `PRAGMA data_version` poll) and
  emits only a changed snapshot. A current-value write never fabricates an
  event, so event cursors stay on real event commits.
- Format: the event-format stamp names the event vocabulary only. A format
  bump moves the event rows aside and keeps every current value.

## Families

A family is a `ValueFamily` (`shared/session/valueFamily.ts`): its stored
name, the schema its value decodes with, and whether it is deletable. The
harness declares the families its own stores write; every other owner
declares its family beside the code that reads and writes it.

| Family                    | Declared in                                   | Holds                                                   |
| ------------------------- | --------------------------------------------- | ------------------------------------------------------- |
| `app-state`               | `harness/src/shared/session/valueFamily.ts`   | The settings store, keyed by setting key (deletable)    |
| `repo-state`              | same                                          | Settings every checkout of one repository shares        |
| `workspace-store`         | same                                          | The global root's record of each workspace store's root |
| `update-check`            | `texra/src/utils/system/updateCheck.ts`       | Last update check and notification, per host            |
| `external-inquiry/thread` | `texra/src/shared/plugins/externalInquiry.ts` | External inquiry threads, keyed by thread id            |
| `texra-service`           | `texra/src/controllers/server/protocol.ts`    | The storage root's running `texra serve` (deletable)    |
| `desktop-projects`        | `desktop/src/main/desktopProjectRecords.ts`   | The desktop's remembered and recently closed projects   |

Ownership stays with the database identity: global records use the global
root's database, project state its project database. Ephemeral session
databases hold no persistent state.

## Why it is cheaper

A disposable SQLite experiment wrote 10,000 updates to one key: as event
rows it took 10,000 rows and about 3 MB; as one upserted row it took 1 row
and 12 KB. That bounds row growth for a hot key. It is not a latency
measurement: a current-value write still costs a transaction and a WAL
write.
