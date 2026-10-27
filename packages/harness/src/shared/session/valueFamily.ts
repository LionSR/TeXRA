/**
 * The families of a root's `current_value` table: application state, not
 * history. One row per family and key, replaced in place by each write and
 * kept outside the event tables, so an event-format bump never clears it.
 *
 * The harness owns the table and the families its own settings stores write;
 * every other owner (a plugin, a host, the app) declares its family beside
 * the code that reads and writes it. A family names the schema its value
 * decodes with at the database boundary; a row that no longer decodes fails
 * the read. `CurrentValues` is the store's interface over the families.
 */
import { type Effect, type Result, Schema, type Stream } from 'effect';

import { JsonValueSchema, type JsonValue } from '@shared/schemas';
import type { DatabaseReadFailed, DatabaseWriteFailed } from './database';

/**
 * One family of current values: its stored name, the schema its value
 * decodes with, and whether a write may delete its row (`Deletable`), in
 * which case a change may answer `undefined`.
 */
export interface ValueFamily<T, Deletable extends boolean = false> {
  readonly name: string;
  readonly schema: Schema.Codec<T, unknown>;
  readonly deletable: Deletable;
}

/** A root's current values, read and written by family and key. Every write
 *  is one `BEGIN IMMEDIATE` with no aggregate claim. */
export interface CurrentValues {
  readonly get: <T, D extends boolean>(
    family: ValueFamily<T, D>,
    key: string,
  ) => Effect.Effect<T | undefined, DatabaseReadFailed>;
  /**
   * Change one value from the one read under the write lock: `change`
   * answers with its result and the next value, with its result alone to
   * write nothing, or refuses and nothing is written. Only a deletable
   * family's change may answer `undefined`, which deletes the row.
   */
  readonly modify: <T, D extends boolean, A, E = never>(
    family: ValueFamily<T, D>,
    key: string,
    change: (
      current: T | undefined,
    ) => Result.Result<
      readonly [A] | readonly [A, D extends true ? T | undefined : T],
      E
    >,
  ) => Effect.Effect<A, E | DatabaseWriteFailed>;
  /** Every row of a family, latest write first. */
  readonly list: <T, D extends boolean>(
    family: ValueFamily<T, D>,
  ) => Effect.Effect<
    readonly { readonly key: string; readonly value: T }[],
    DatabaseReadFailed
  >;
  /**
   * Emits as subscribed, then after each commit, by this process or
   * another, that changed one of `keys`' values: the root's wake level
   * narrowed inside the store to those rows. A read that fails is logged and
   * retried, so no change is missed.
   */
  readonly changes: (
    family: Pick<ValueFamily<unknown, boolean>, 'name'>,
    keys: readonly string[],
  ) => Stream.Stream<void>;
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
 * directory id: the root it serves, so a storage prune can tell a store
 * whose root is gone.
 */
export const WORKSPACE_STORES: ValueFamily<{ readonly root: string }> = {
  name: 'workspace-store',
  schema: Schema.Struct({ root: Schema.NonEmptyString }),
  deletable: false,
};
