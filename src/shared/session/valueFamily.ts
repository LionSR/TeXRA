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
import { z } from 'zod';

import { JsonValueSchema, type JsonValue } from '@shared/schemas';

/**
 * One family of current values: its stored name, the schema its value
 * decodes with, and whether a write may delete its row (`Deletable`), in
 * which case a change may answer `undefined`.
 */
export interface ValueFamily<T, Deletable extends boolean = false> {
  readonly name: string;
  readonly schema: z.ZodType<T>;
  readonly deletable: Deletable;
}

/** The process's settings store, keyed by the setting key. */
export const APP_STATE: ValueFamily<JsonValue, true> = {
  name: 'app-state',
  schema: JsonValueSchema,
  deletable: true,
};

/** The settings every checkout of one repository shares, keyed by the
 *  repository root and the setting key. */
export const REPO_STATE: ValueFamily<JsonValue, true> = {
  name: 'repo-state',
  schema: JsonValueSchema,
  deletable: true,
};

/**
 * The global root's record of a workspace store, keyed by its storage
 * directory id: the root it serves, so `texra doctor --prune-storage` can
 * tell a store whose root is gone.
 */
export const WORKSPACE_STORES: ValueFamily<{ readonly root: string }> = {
  name: 'workspace-store',
  schema: z.object({ root: z.string().min(1) }),
  deletable: false,
};
