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
  Scheduler,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect';
import { logFailure } from '@logger/effectLog';
import {
  DatabaseOpenFailed,
  DatabaseReadFailed,
  DatabaseWriteFailed,
  GlobalDatabase,
  INPUT_HISTORY_LIMIT,
  InputHistoryRecordSchema,
} from '@shared/session/database';
import { ensureError } from '@utils/errors/errorMessage';
import { currentValues, READ_RETRY } from './currentValues';
import { SESSION_DATABASE_FILE, storeFile } from './databaseLayer';
import { storeGate } from './rowCodec';
import { mapDatabaseFailure, retryBusy } from './storeAside';
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
): Layer.Layer<GlobalDatabase, DatabaseOpenFailed, FileSystem.FileSystem> =>
  Layer.effect(
    GlobalDatabase,
    Effect.gen(function* () {
      const path = join(storage, SESSION_DATABASE_FILE);
      const openFailed = (cause: unknown) =>
        new DatabaseOpenFailed({ path, cause });
      const readFailed = (cause: unknown) =>
        new DatabaseReadFailed({ path, cause });
      const writeFailed = (cause: unknown) =>
        new DatabaseWriteFailed({ path, cause });
      const filename = yield* Effect.try({
        try: () => storeFile(storage, true),
        catch: (cause) => openFailed(ensureError(cause)),
      });
      // The driver waits out another process's lock while the file is
      // prepared; `openStore` then leaves a 25 ms slice, and the retries
      // below wait on the fiber's schedule instead of inside SQLite.
      const { sql } = yield* openStore(
        SqliteClient.make({ filename, busyTimeout: '5 seconds' }),
        path,
        filename,
      ).pipe(mapDatabaseFailure(openFailed));
      const exec = (statement: string, params?: readonly unknown[]) =>
        sql.unsafe<Record<string, unknown>>(statement, params);
      const execOne = (statement: string, params?: readonly unknown[]) =>
        exec(statement, params).pipe(Effect.map((rows) => rows.at(0)));
      // The store holds no plugin's rows, so the gate knows no fact kind.
      const gate = storeGate(exec, {});
      yield* gate.pipe(mapDatabaseFailure(openFailed));
      const query = <A, E>(read: Effect.Effect<A, E>) =>
        read.pipe(retryBusy, mapDatabaseFailure(readFailed));
      // One uninterrupted turn per transaction (the driver is synchronous
      // and a body awaits nothing), so this connection's writes land in call
      // order; a lock another process holds runs the transaction again whole.
      const transact = <A, E>(body: Effect.Effect<A, E>) =>
        retryBusy(
          Effect.provideService(
            sql.withTransaction(Effect.andThen(gate, body)),
            Scheduler.PreventSchedulerYield,
            true,
          ),
        ).pipe(mapDatabaseFailure(writeFailed));
      /** Moved by every value write, this process's or (by the poll below)
       *  another's: what `values.changes` wakes on. */
      const written = yield* SubscriptionRef.make(0);
      // Each change of `data_version` is another process's commit (the first
      // read, at start, wakes the readers for nothing). A failed read logs
      // and retries.
      yield* Effect.forkScoped(
        Stream.fromEffectSchedule(
          query(execOne('PRAGMA data_version', [])).pipe(
            Effect.map((row) => row?.data_version),
            Effect.tapError(
              logFailure(
                'sessionDatabase',
                'The global store change poll failed; retrying.',
              ),
            ),
            Effect.retry(READ_RETRY),
            Effect.orDie,
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
        values: currentValues({
          exec,
          execOne,
          transact,
          query,
          afterCommit: sql.afterCommit,
          written,
        }),
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
