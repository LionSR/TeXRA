# The global store holds values only

Date: 2026-11-15
Status: proposed — a plan, not started. It follows the storage-errors note
(`2026-11-03-storage-errors-and-stop-paths.md` §1, "The global database"),
which accepted the cut.

## What is there

`globalDatabaseLayer` (`packages/harness/src/controllers/session/databaseLayer.ts`)
builds the whole event `Database` with an empty tool table and narrows it to
`GlobalDatabase` (`packages/harness/src/shared/session/database.ts`), which
serves two members: `values` and `inputHistory` (`currentValues.ts`). So the
global `texra.db` carries every event table, the projection catch-up runs at
its open, and `databaseLayer` keeps a `'global'` mode it reads at three places
(the `data_version` poll, the gate inside every value write, the shared
connection with a 5 s busy timeout).

The other way round, every project store carries `input_history`, and
`Database` has an `inputHistory` member no consumer reads from a project
store: its one reader and writer is the CLI's
`packages/cli/src/chat/tui/history/inputHistory.ts`, over `GlobalDatabase`.

## The change

1. A `valuesStoreLayer(storage)` beside `databaseLayer`, over the same open
   (`openStore` in `storeSchema.ts`), shared connection and busy retry, that
   serves `GlobalDatabase` directly: `currentValues(...)` plus the
   `data_version` poll that today sits behind `mode === 'global'`. No
   `ToolRegistry`, no `rowReader`, no projection upkeep. Its gate is
   `storeGate` over `stored_kind` with no fact kinds.
2. `databaseLayer` loses `'global'`: the poll, the per-write gate
   (`mode === 'global' ? Effect.andThen(gate, body) : body`) and the
   `busyTimeout` branch go with it, leaving `persistent`, `existing` and
   `ephemeral`, all exclusive or in memory.
3. `Database` drops `inputHistory`; `currentValues` returns `values` only to
   `databaseLayer`, and the input history moves into the values store.
4. The schema splits in two DDL lists in `storeSchema.ts`: the global store's
   (`current_value`, `input_history`, `stored_kind`, `current_value_at`) and a
   project store's (everything else, without `input_history`). Each list has
   its own stamp, so a project store that still holds `input_history` and a
   global store that still holds the event tables are both earlier builds'
   stores.

## Stored format

Both stamps change (`SCHEMA_VERSION` 105 → 106 for project stores, a new
stamp for the global store, following `packages/harness/AGENTS.md` "Storage
format"). With no migration, the global `texra.db` written by today's build
fails its open with the "move it away" message, and with it every remembered
setting, project record and the CLI input history. That is the cost to weigh:
the global store holds the user's settings, so either the step is the first
forward step the storage review's S4 proposes (copy `current_value` and
`input_history` into a fresh file), or the release notes say to move the file
away. A project store needs no step if only `input_history` is dropped from
new stores: the table is unused there, and the stamp can stay if the project
DDL keeps creating it until the next bump.

The golden fixture (`src/test-kernel/fixtures/storage/golden-1.0.sql`) is a
project store; it is regenerated only if the project stamp moves.

## Net

About −40 lines in `databaseLayer.ts` (the global branches and the empty tool
table), +60 for the values store layer, −1 table in every project store. The
point is one owner per store kind, not the line count.
