# The global store holds values only

Date: 2026-11-15
Status: implemented. The code half landed on 2026-11-19 and the schema
split on 2026-11-21. It follows the storage-errors note
(`.agents/docs/proposed/simplification/2026-11-03-storage-errors-and-stop-paths.md`
§1, "The global database"), which accepted the cut.

## What is there

Since 2026-11-19 the global store has its own layer, `globalDatabaseLayer`
(`packages/harness/src/controllers/session/globalDatabaseLayer.ts`). It
opens the file with the same `openStore` a project store uses and serves
`GlobalDatabase` (`packages/harness/src/shared/session/database.ts`)
directly: the current values (`currentValues.ts`), the CLI input history, the
`data_version` poll, a busy retry, and the store gate in every write. It
builds no tool table, no row reader and no projection.

`databaseLayer` (`packages/harness/src/controllers/session/databaseLayer.ts`)
serves project stores alone, in three modes (`persistent`, `existing`,
`ephemeral`), all held exclusively or in memory. With no other writer it
runs the gate once, at open, and retries no busy lock. `Database` has no
`inputHistory` member; its one reader and writer was already the CLI's
`packages/cli/src/chat/tui/history/inputHistory.ts`, over `GlobalDatabase`.

## The schema split (2026-11-21)

`storeSchema.ts` holds two DDL lists, each with its own stamp:
`GLOBAL_SCHEMA` (107: `stored_kind`, `current_value`, `input_history` and
the `current_value_at` index) and `PROJECT_SCHEMA` (106: the event tables,
the projections, `stored_kind` and the project's own `current_value`, with
no `input_history`). `openStore` takes the schema of the store it opens.

### Stored format

Both stamps moved from 105, with no migration and no copy, which root
`AGENTS.md` rules out. 1.0 has not shipped and `release/0.40` writes no
such file, so the stores this refuses are a development build's: their open
fails unchanged with the "move it away" message
(`packages/harness/AGENTS.md` "Storage format"), and the settings, project
records and input history in a development build's global store stay in the
file that was moved away.

The golden fixture (`src/test-kernel/fixtures/storage/golden-1.0.sql`) is a
project store; it was regenerated for the project stamp.
