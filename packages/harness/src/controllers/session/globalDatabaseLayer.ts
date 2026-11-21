/**
 * The global storage root's store: current values and the CLI input history,
 * and no event rows, so it needs no tool table, row reader or projection.
 * Unlike a project store it is shared: every TeXRA process on the machine
 * opens it, so a write can meet another process's lock (retried), another
 * process's write is found by polling, and another process can be a newer
 * build (the store gate runs in every write, not only at open).
 */
import { join } from 'node:path';
import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient';
import * as Reactivity from 'effect/reactivity/Reactivity';
import {
  Effect,
  type FileSystem,
  Layer,
  Schedule,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect';
import {
  DatabaseOpenFailed,
  GlobalDatabase,
  INPUT_HISTORY_LIMIT,
  InputHistoryRecordSchema,
} from '@shared/session/database';
import { ensureError } from '@utils/errors/errorMessage';
import { AppNamespace, storeFileName } from '@utils/system/appNamespace';
import { changeRead, currentValues } from './currentValues';
import { storeFile } from './databaseLayer';
import { mapDatabaseFailure } from './storeAside';
import { storeConnection } from './storeConnection';
import { openStore } from './storeSchema';

/** Append an entry unless it repeats the latest; a row back when it did. */
const APPEND_HISTORY = `INSERT INTO input_history (at, value)
  SELECT ?1, ?2
  WHERE ?2 IS NOT (SELECT value FROM input_history ORDER BY id DESC LIMIT 1)
  RETURNING id`;
const TRIM_HISTORY = `DELETE FROM input_history WHERE id NOT IN
  (SELECT id FROM input_history ORDER BY id DESC LIMIT ?)`;

const decodeHistoryRecord = Schema.decodeUnknownSync(InputHistoryRecordSchema);

/**
 * The process's handle on the global storage root: one connection and one
 * `data_version` poll for every application record of that root, closed with
 * the entry's runtime. Building it creates the directory, the file and the
 * poll fiber; an entry that must create none passes a refusing layer.
 */
export const globalDatabaseLayer = (
  storage: string,
): Layer.Layer<
  GlobalDatabase,
  DatabaseOpenFailed,
  FileSystem.FileSystem | AppNamespace
> =>
  Layer.effect(
    GlobalDatabase,
    Effect.gen(function* () {
      const name = storeFileName(yield* AppNamespace);
      const path = join(storage, name);
      const openFailed = (cause: unknown) =>
        new DatabaseOpenFailed({ path, cause });
      const filename = yield* Effect.try({
        try: () => storeFile(storage, name, true),
        catch: (cause) => openFailed(ensureError(cause)),
      });
      // The driver waits out another process's lock while the file is
      // prepared; `openStore` then leaves a 25 ms slice, and the
      // connection's retries wait on the fiber's schedule instead of inside
      // SQLite.
      const { sql } = yield* openStore(
        SqliteClient.make({ filename, busyTimeout: '5 seconds' }),
        path,
        filename,
      ).pipe(mapDatabaseFailure(openFailed));
      // The store holds no plugin's rows, so the gate knows no fact kind.
      const store = storeConnection(sql, path, { shared: true, factKinds: {} });
      const { exec, execOne, query, transact } = store;
      yield* store.gate.pipe(mapDatabaseFailure(openFailed));
      /** Moved by every value write, this process's or (by the poll below)
       *  another's: what `values.changes` wakes on. */
      const written = yield* SubscriptionRef.make(0);
      // Each change of `data_version` is another process's commit (the first
      // read, at start, wakes the readers for nothing). A version that
      // cannot be read wakes them too (`changeRead`).
      yield* Effect.forkScoped(
        Stream.fromEffectSchedule(
          changeRead(
            query(execOne('PRAGMA data_version', [])).pipe(
              Effect.map((row) => row?.data_version),
            ),
            'The global store change poll failed',
          ),
          Schedule.spaced('250 millis'),
        ).pipe(
          Stream.changes,
          Stream.runForEach(() =>
            SubscriptionRef.update(written, (wake) => wake + 1),
          ),
        ),
      );
      return {
        values: currentValues(store, written),
        inputHistory: {
          read: query(
            exec('SELECT at, value FROM input_history ORDER BY id').pipe(
              Effect.map((rows) => rows.map((row) => decodeHistoryRecord(row))),
            ),
          ),
          append: ({ at, value }) =>
            transact(
              Effect.gen(function* () {
                if ((yield* execOne(APPEND_HISTORY, [at, value])) !== undefined)
                  yield* exec(TRIM_HISTORY, [INPUT_HISTORY_LIMIT]);
              }),
            ),
        },
      };
    }),
  ).pipe(Layer.provide(Reactivity.layer));
