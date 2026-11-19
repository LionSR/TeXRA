# The global store holds values only

Date: 2026-11-15
Status: proposed — the code half is in; the schema split (step 4) waits on
one decision. It follows the storage-errors note
(`2026-11-03-storage-errors-and-stop-paths.md` §1, "The global database"),
which accepted the cut.

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

No stored byte changed: both kinds of store still get the one DDL list and
the one stamp in `storeSchema.ts`.

## Still open: the schema split

The global `texra.db` still carries every event table, and every project
store still carries `input_history`, which nothing reads there. The split is
two DDL lists in `storeSchema.ts`: the global store's (`current_value`,
`input_history`, `stored_kind`, `current_value_at`) and a project store's
(everything else, without `input_history`), each with its own stamp, so a
project store that still holds `input_history` and a global store that still
holds the event tables are both earlier builds' stores.

### Stored format

Both stamps would change (`SCHEMA_VERSION` 105 → 106 for project stores, a
new stamp for the global store, following `packages/harness/AGENTS.md`
"Storage format"). With no migration, the global `texra.db` written by
today's build fails its open with the "move it away" message, and with it
every remembered setting, project record and the CLI input history. That is
the cost to weigh, and the decision this step waits on: the global store
holds the user's settings, so either the new store is a new file created
beside the old one (which stays where it is, unread), or the step is the
first forward step the storage review's S4 proposes (copy `current_value`
and `input_history` into a fresh file), or the release notes say to move the
file away. A project store needs no step if only `input_history` is dropped
from new stores: the table is unused there, and the stamp can stay if the
project DDL keeps creating it until the next bump.

The golden fixture (`src/test-kernel/fixtures/storage/golden-1.0.sql`) is a
project store; it is regenerated only if the project stamp moves.
