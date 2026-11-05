/**
 * The families of a root's `current_value` table: application state, not
 * history. One row per family and key, replaced in place by each write and
 * kept outside the event tables, so an event-format bump never clears it.
 *
 * The harness owns the table and the families its own settings stores write;
 * every other owner (a plugin, a host, the app) declares its family beside
 * the code that reads and writes it. A family names the schema its value
 * decodes with at the database boundary; a row that no longer decodes fails
 * the read.
 */
import { Schema } from 'effect';

import { JsonValueSchema, type JsonValue } from '@shared/schemas';

/**
 * One family of current values: its stored name and the schema its value
 * decodes with. A change that answers `undefined` deletes the row.
 */
export interface ValueFamily<T> {
  readonly name: string;
  readonly schema: Schema.Codec<T, unknown>;
}

/** The process's settings store, keyed by the setting key. */
export const APP_STATE: ValueFamily<JsonValue> = {
  name: 'app-state',
  schema: JsonValueSchema,
};

/** The settings every checkout of one repository shares, keyed by the
 *  repository root and the setting key. */
export const REPO_STATE: ValueFamily<JsonValue> = {
  name: 'repo-state',
  schema: JsonValueSchema,
};

/**
 * The global root's record of a workspace store, keyed by its storage
 * directory id: the root it serves, so a storage prune can tell a store
 * whose root is gone.
 */
export const WORKSPACE_STORES: ValueFamily<{ readonly root: string }> = {
  name: 'workspace-store',
  schema: Schema.Struct({ root: Schema.String.check(Schema.isMinLength(1)) }),
};
