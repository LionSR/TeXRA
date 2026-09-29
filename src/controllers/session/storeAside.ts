/**
 * The session store's aside copies: the file-level moves that keep a copy
 * of a store beside it (a pre-1.0 store retired to `.pre1`, a schema
 * stepped forward from `.schema<N>`, a damaged file moved to
 * `.corrupt-<stamp>`), each at a name no earlier copy holds, and the test
 * of whether a failed open is SQLite reporting the file damaged.
 */
import { randomUUID } from 'node:crypto';
import { type Cause, Effect, FileSystem } from 'effect';
import type * as SqlClient from 'effect/unstable/sql/SqlClient';

export type Sql = SqlClient.SqlClient;

export const run = (sql: Sql, statement: string) => sql.unsafe(statement, []);

export const pragmaValue = (sql: Sql, pragma: string) =>
  sql
    .unsafe<Record<string, unknown>>(`PRAGMA ${pragma}`, [])
    .pipe(Effect.map((rows) => rows[0]?.[pragma]));

/**
 * The first of `base`, `base.2`, `base.3`, … that names no file (with its
 * `-wal` and `-shm` companions, for a whole database moved aside): an
 * earlier copy is never replaced, on any platform's `rename`.
 */
export const freeName = Effect.fnUntraced(function* (base: string) {
  const fs = yield* FileSystem.FileSystem;
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base}.${n}`;
    const taken = yield* Effect.forEach(['', '-wal', '-shm'], (suffix) =>
      fs.exists(`${name}${suffix}`),
    );
    if (!taken.some(Boolean)) return name;
  }
});

/**
 * Keep a copy of the store beside it, at the first free name from `base`
 * ({@link freeName}), then run `body` under the write lock only if nothing
 * committed since the copy: `VACUUM INTO` cannot run inside a transaction,
 * so the transaction re-reads `user_version` and `data_version` (which moves
 * on every other connection's commit) and, if either moved, discards the
 * copy and answers null for the caller to start over from what the store
 * now is. The name is chosen under the lock, so two processes retiring one
 * store never pick the same one. Answers the copy's path.
 */
export const underCopy = Effect.fnUntraced(function* <E>(
  sql: Sql,
  base: string,
  body: Effect.Effect<void, E>,
) {
  const fs = yield* FileSystem.FileSystem;
  const stamp = yield* pragmaValue(sql, 'user_version');
  const version = yield* pragmaValue(sql, 'data_version');
  const staged = `${base}.${randomUUID()}.partial`;
  yield* sql.unsafe('VACUUM INTO ?', [staged]);
  yield* run(sql, 'BEGIN IMMEDIATE');
  const moved = yield* Effect.gen(function* () {
    if (
      (yield* pragmaValue(sql, 'user_version')) !== stamp ||
      (yield* pragmaValue(sql, 'data_version')) !== version
    ) {
      return null;
    }
    const aside = yield* freeName(base);
    yield* fs.rename(staged, aside);
    yield* body;
    return aside;
  }).pipe(
    Effect.onError(() =>
      Effect.all([
        run(sql, 'ROLLBACK').pipe(Effect.ignore),
        fs.remove(staged, { force: true }).pipe(Effect.ignore),
      ]),
    ),
  );
  if (moved === null) {
    yield* run(sql, 'ROLLBACK');
    yield* fs.remove(staged, { force: true });
    return null;
  }
  yield* run(sql, 'COMMIT');
  return moved;
});

/** Whether a failed open is SQLite reporting the file damaged or foreign:
 *  `SQLITE_CORRUPT` (11) or `SQLITE_NOTADB` (26), as a driver defect or a
 *  statement's classified cause. */
export function isDamaged(cause: Cause.Cause<unknown>): boolean {
  return cause.reasons.some((reason) => {
    if (reason._tag === 'Interrupt') return false;
    let error: unknown = reason._tag === 'Fail' ? reason.error : reason.defect;
    while (error !== null && typeof error === 'object') {
      const code = (error as { errcode?: unknown }).errcode;
      if (typeof code === 'number') return [11, 26].includes(code & 0xff);
      error =
        (error as { reason?: { cause?: unknown } }).reason?.cause ??
        (error as { cause?: unknown }).cause;
    }
    return false;
  });
}
