/**
 * The session store's format stamp (`SESSION_EVENT_FORMAT` in SQLite's
 * `user_version`), read and enforced for `Database`'s open and write paths.
 * The stamp names the one vocabulary a store holds; there are no readers of
 * another and no migrations, so a store of another format is refused or
 * moved aside, never read and never deleted.
 */
import { randomUUID } from 'node:crypto';
import { Effect, FileSystem } from 'effect';
import { withLogChannel } from '@logger/effectLog';
import { SESSION_EVENT_FORMAT } from '@shared/schemas';
import type { SessionStoreMovedAside } from '@shared/session/database';
import type * as SqlClient from 'effect/unstable/sql/SqlClient';
import type { SqlError } from 'effect/unstable/sql/SqlError';

const CHANNEL = 'sessionDatabase';

/**
 * Bring a store stamped with another format to this build's, deleting none of
 * its rows. There are no legacy readers and no migrations, so this build
 * never reads them either:
 *
 * - A newer format is refused untouched. Its rows are a later build's, and an
 *   older build cannot tell what they are worth; `update TeXRA` is the fix.
 *   The open fails rather than falling back to a scratch in-memory store,
 *   because a run that looks saved and vanishes at exit is the silent loss
 *   this refusal exists to prevent.
 * - An older format (or a file stamped before formats existed) is moved
 *   aside: its rows are copied to `<file>.format<N>`, replacing an earlier
 *   copy of that format, and then its tables are dropped and the file
 *   re-stamped under the write lock, in one transaction with the stamp.
 *
 * `VACUUM INTO` cannot run inside a transaction, so the copy is taken first
 * and the transaction proves nothing committed after it: the stamp re-read
 * under the lock is unchanged and `data_version` (which moves on every other
 * connection's commit) is the value the copy was taken at. Otherwise the copy
 * is discarded and the move starts over. Of two processes opening the same
 * store, the second reads this build's stamp and keeps the tables.
 */
export const retireStore = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  path: string,
  filename: string,
  /** `Database`'s drop of its event tables: it alone writes them (C6). */
  dropEventTables: Effect.Effect<void, SqlError>,
) {
  const fs = yield* FileSystem.FileSystem;
  for (;;) {
    const stored = Number(yield* pragmaValue(sql, 'user_version'));
    if (stored === SESSION_EVENT_FORMAT) return null;
    if (stored > SESSION_EVENT_FORMAT) return yield* newerStore(path, stored);
    const version = yield* pragmaValue(sql, 'data_version');
    const rows = yield* storedRows(sql);
    const aside = `${filename}.format${stored}`;
    const staged = rows > 0 ? `${aside}.${randomUUID()}.partial` : null;
    if (staged !== null) {
      yield* sql.unsafe('VACUUM INTO ?', [staged]);
    }
    yield* sql.unsafe('BEGIN IMMEDIATE', []);
    const moved = yield* Effect.gen(function* () {
      const current = Number(yield* pragmaValue(sql, 'user_version'));
      if (current > SESSION_EVENT_FORMAT) {
        return yield* newerStore(path, current);
      }
      if (
        current !== stored ||
        (yield* pragmaValue(sql, 'data_version')) !== version
      ) {
        return false;
      }
      if (staged !== null) yield* fs.rename(staged, aside);
      yield* dropEventTables;
      yield* sql.unsafe(`PRAGMA user_version = ${SESSION_EVENT_FORMAT}`, []);
      return true;
    }).pipe(
      Effect.onError(() =>
        Effect.all([
          sql.unsafe('ROLLBACK', []).pipe(Effect.ignore),
          staged === null
            ? Effect.void
            : fs.remove(staged, { force: true }).pipe(Effect.ignore),
        ]),
      ),
    );
    if (!moved) {
      yield* sql.unsafe('ROLLBACK', []);
      if (staged !== null) yield* fs.remove(staged, { force: true });
      continue;
    }
    yield* sql.unsafe('COMMIT', []);
    if (staged === null) return null;
    yield* Effect.logWarning(
      `Session store ${path} held ${rows === 1 ? '1 row' : `${rows} rows`} of event format ${stored}; this build reads format ${SESSION_EVENT_FORMAT} and keeps no compatibility with earlier persisted data, so they were moved to ${aside}; the store starts fresh.`,
    ).pipe(withLogChannel(CHANNEL));
    return {
      path,
      aside,
      rows,
      storedFormat: stored,
    } satisfies SessionStoreMovedAside;
  }
});

/** The refusal of a store a newer build wrote: nothing in it is touched. */
const newerStore = (path: string, stored: number) =>
  Effect.fail(
    new Error(
      `Session store ${path} was written by a newer TeXRA build (event format ${stored}); this build reads format ${SESSION_EVENT_FORMAT}. Update TeXRA to open it. Nothing in the store was changed.`,
    ),
  );

/** The event rows a store holds, or none when it has no event table yet. */
const storedRows = Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
  const table = (yield* sql.unsafe<Record<string, unknown>>(
    "SELECT count(*) AS present FROM sqlite_master WHERE type = 'table' AND name = 'event'",
    [],
  ))[0];
  if (Number(table?.present ?? 0) === 0) return 0;
  const counted = (yield* sql.unsafe<Record<string, unknown>>(
    'SELECT count(*) AS rows FROM event',
    [],
  ))[0];
  return Number(counted?.rows ?? 0);
});

/** Refuse a write once another build has re-stamped the store under this
 *  process; read inside the write transaction, so the check and the append
 *  see one stamp. */
export const assertStoreFormat = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  path: string,
) {
  const stored = yield* pragmaValue(sql, 'user_version');
  if (stored !== SESSION_EVENT_FORMAT) {
    return yield* Effect.fail(
      new Error(
        `Session store ${path} is stamped with event format ${String(stored)}; this process writes format ${SESSION_EVENT_FORMAT} and stops writing to it.`,
      ),
    );
  }
});

export const pragmaValue = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  pragma: string,
) {
  const row = (yield* sql.unsafe<Record<string, unknown>>(
    `PRAGMA ${pragma}`,
    [],
  ))[0];
  return row?.[pragma];
});
