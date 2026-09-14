/**
 * Host and application state on the session substrate: the `StateStore` every
 * Node-family host opens for its global and workspace scopes, backed by the
 * root's `texra.db` instead of a whole-file JSON rewrite.
 *
 * One aggregate per state key (`['app-state', key]`), one `state.value.set`
 * row per write, latest row wins. That is what the whole-file store could not
 * give: a `set` is a transactional append of one key, so a writer in another
 * process no longer discards every key the loser re-read before it. The
 * scope is the database file — the global-storage root for global state, the
 * workspace storage root for workspace state — so nothing here chooses a
 * scope of its own.
 *
 * Reads keep the shape they had: `open` takes the whole scope's snapshot in
 * one query and `get` serves it synchronously, so this instance's view is
 * still open-time contents plus its own mutations, and none of the state key
 * call sites change. SQLite is acquired and released per write, as the other
 * application records do, so nothing holds a connection open across a project
 * the desktop closes.
 *
 * The `vscode.Memento`-shaped `update` returns a Promise, and R1 puts that
 * conversion at a host entry: the entry that opens the store passes
 * {@link RunStateWrite}, and this file never runs an Effect itself.
 */
import { Effect, Layer } from 'effect';

import {
  nodeProcesses,
  processOwnerId,
} from '@platform/defaults/nodeProcesses';
import type { StateStore } from '@platform/interfaces';
import {
  JsonValueSchema,
  aggregateId,
  type JsonValue,
  type PersistedJsonValue,
} from '@shared/schemas';
import { Database } from '@shared/session/database';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { ensureError } from '@utils/errors/errorMessage';

import { databaseLayer } from './Database';
import { WorkspaceRoots } from './WorkspaceRoots';

/**
 * Runs one durable state write to completion. The port mirrors
 * `vscode.Memento`, whose `update` is a Promise, so the host entry that opens
 * the store supplies the run. A rejected write is the caller's failure, never
 * a logged best-effort.
 */
export type RunStateWrite = (
  write: Effect.Effect<void, Error>,
) => PromiseLike<void>;

/**
 * One write at a time per key and database, module-wide so two stores over
 * one file keep call order — the ordering the flip-and-restore preference
 * writers depend on.
 */
const writeLanes = new Map<string, PerKeyLane>();

/** `undefined` deletes the key, so absence is a written arm, not a gap. */
function encode(key: string, value: unknown) {
  return Effect.try({
    try: (): PersistedJsonValue =>
      value === undefined
        ? { kind: 'undefined' }
        : { kind: 'json', value: JsonValueSchema.parse(value) },
    catch: (cause) =>
      new Error(`State key ${key} was given a value that is not JSON`, {
        cause,
      }),
  });
}

class SqliteStateStore implements StateStore {
  constructor(
    private readonly storage: string,
    private readonly values: Map<string, JsonValue>,
    private readonly write: (
      key: string,
      value: PersistedJsonValue,
    ) => Effect.Effect<void, Error>,
    private readonly runWrite: RunStateWrite,
  ) {}

  get<T>(key: string, defaultValue?: T): T {
    const value = this.values.get(key);
    return value === undefined ? (defaultValue as T) : (value as T);
  }

  /**
   * Append the mutation on the key's lane, then apply it to this instance's
   * view, so the snapshot only ever holds values the database accepted and
   * concurrent writes land in call order. A failed append fails the caller
   * and leaves the view on the last committed value.
   */
  set(key: string, value: unknown): Effect.Effect<void, Error> {
    return Effect.flatMap(encode(key, value), (encoded) =>
      this.write(key, encoded).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (encoded.kind === 'undefined') {
              this.values.delete(key);
            } else {
              this.values.set(key, encoded.value);
            }
          }),
        ),
        withPerKeyLane(writeLanes, `${this.storage}\u0000${key}`),
      ),
    );
  }

  update(key: string, value: unknown): PromiseLike<void> {
    return this.runWrite(this.set(key, value));
  }
}

/**
 * Open the state store of one storage root. The snapshot is read once, here;
 * every later write opens the database again and releases it before
 * returning.
 */
export const openAppStateStore = Effect.fn('appStateStore.openAppStateStore')(
  function* (storage: string, runWrite: RunStateWrite) {
    // Memoized after the entry's own read: a cache hit on every host that
    // installed its process runtime before opening its stores.
    const ownerId = processOwnerId(
      yield* Effect.promise(() => nodeProcesses.selfIdentity()),
    );
    const withDatabase = <A, E>(operation: Effect.Effect<A, E, Database>) =>
      Effect.scoped(
        operation.pipe(
          Effect.provide(
            databaseLayer('persistent').pipe(
              Layer.provide(Layer.succeed(WorkspaceRoots)({ storage })),
              Layer.provide(ProcessIdentity.layer(ownerId)),
            ),
          ),
        ),
      );
    const values = new Map(
      yield* withDatabase(Effect.flatMap(Database, (db) => db.readAppState())),
    );
    const write = (key: string, value: PersistedJsonValue) =>
      withDatabase(
        Effect.flatMap(Database, (db) =>
          db.appendAll([
            {
              type: 'state.value.set',
              aggregateId: aggregateId('app-state', key),
              value,
            },
          ]),
        ),
      ).pipe(Effect.asVoid, Effect.mapError(ensureError));
    return new SqliteStateStore(storage, values, write, runWrite);
  },
);
