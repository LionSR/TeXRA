/**
 * The session store's physical schema
 * (`.agents/docs/proposed/architecture/2026-09-28-storage-v1-design.md` §2,
 * §3): its tables, columns, indexes and PRAGMAs, the open sequence that
 * brings a file to them, and `SCHEMA_VERSION` in SQLite's `user_version`.
 *
 * `SCHEMA_VERSION` names the DDL, never the row vocabulary: rows carry
 * their own versions (`rowVersions.ts`, read by `rowCodec.ts`), so it moves
 * only for a change an older build cannot write around. It starts at 100;
 * a stamp from 1 to 99 is a store written before 1.0, which this build
 * never reads and moves aside whole.
 *
 * This module knows no row kind and no payload field.
 */
import { randomUUID } from 'node:crypto';
import { Cause, Clock, Effect, Exit, FileSystem, Scope } from 'effect';
import { withLogChannel } from '@logger/effectLog';
import type { SessionStoreMovedAside } from '@shared/session/database';
import type * as SqlClient from 'effect/unstable/sql/SqlClient';

const CHANNEL = 'sessionDatabase';

/** The DDL this build creates and writes. */
const SCHEMA_VERSION = 100;
/** `TeXR`: a TeXRA store, told apart from a foreign SQLite file before
 *  anything in it is touched. */
const APPLICATION_ID = 0x54655852;

/**
 * The tables every store holds. `commit` is a SQLite keyword, so the column
 * is quoted at every site. `STRICT` makes a wrong-typed value an error at
 * insert rather than a surprise at read.
 *
 * `event_sequence` is one aggregate: a local integer surrogate `id` (never
 * outside the file), the `(kind, logical_id)` the codec maps an
 * `AggregateId` to, the durable `uid`, its sequence counter, its claim, its
 * parent edge, and two lifecycle facts written by the transaction that
 * makes them: `start_commit` (the commit of seq 1) and `closed_by` (the
 * tombstone's commit, `NULL` while open). The foreign keys are the
 * collection mechanism: deleting an aggregate cascades to its dependents,
 * its events, its projections and their projected rows.
 */
const TABLES = [
  `CREATE TABLE IF NOT EXISTS event_sequence (
    id           INTEGER PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind <> ''),
    logical_id   TEXT NOT NULL CHECK (logical_id <> ''),
    uid          TEXT NOT NULL UNIQUE,
    seq          INTEGER NOT NULL CHECK (seq >= 1),
    start_commit INTEGER,
    owner_id     TEXT,
    parent_id    INTEGER REFERENCES event_sequence(id) ON DELETE CASCADE,
    closed_by    INTEGER,
    UNIQUE (kind, logical_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS blob (
    digest TEXT PRIMARY KEY CHECK (length(digest) = 64),
    value  TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS event (
    "commit"  INTEGER PRIMARY KEY AUTOINCREMENT,
    aggregate INTEGER NOT NULL REFERENCES event_sequence(id) ON DELETE CASCADE,
    seq       INTEGER NOT NULL,
    type      TEXT NOT NULL,
    version   INTEGER NOT NULL CHECK (version >= 1),
    origin    TEXT NOT NULL,
    at        INTEGER NOT NULL,
    data      TEXT NOT NULL,
    blob      TEXT REFERENCES blob(digest),
    UNIQUE (aggregate, seq)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS stored_kind (
    type    TEXT PRIMARY KEY,
    version INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS current_value (
    family  TEXT NOT NULL,
    key     TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    value   TEXT NOT NULL,
    at      INTEGER NOT NULL,
    PRIMARY KEY (family, key)
  ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS input_history (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    at    INTEGER NOT NULL,
    value TEXT NOT NULL
  ) STRICT`,
];

/**
 * What any build adds without a bump (`CREATE … IF NOT EXISTS` at every
 * open): the projection tables, which carry their own versions in
 * `projection_state` (`projections.ts`), and the indexes, each serving a
 * named read (the design note's §2 table).
 */
const ADDITIVE = [
  `CREATE TABLE IF NOT EXISTS projection_state (
    name           TEXT PRIMARY KEY,
    version        INTEGER NOT NULL,
    through_commit INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS projected_row (
    "commit" INTEGER NOT NULL REFERENCES event("commit") ON DELETE CASCADE,
    type     TEXT NOT NULL,
    data     TEXT NOT NULL,
    PRIMARY KEY ("commit", type)
  ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS listing_entry (
    aggregate INTEGER NOT NULL REFERENCES event_sequence(id) ON DELETE CASCADE,
    key       TEXT NOT NULL,
    "commit"  INTEGER NOT NULL,
    PRIMARY KEY (aggregate, key)
  ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS run_usage (
    aggregate INTEGER PRIMARY KEY REFERENCES event_sequence(id) ON DELETE CASCADE,
    "commit"  INTEGER NOT NULL,
    usage     TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS run_model (
    aggregate INTEGER PRIMARY KEY REFERENCES event_sequence(id) ON DELETE CASCADE,
    model     TEXT NOT NULL,
    "commit"  INTEGER
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS event_sequence_parent
    ON event_sequence(parent_id) WHERE parent_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS event_aggregate_type ON event(aggregate, type, seq)`,
  `CREATE INDEX IF NOT EXISTS event_type_commit ON event(type, "commit")`,
  `CREATE INDEX IF NOT EXISTS event_blob ON event(blob) WHERE blob IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS current_value_at ON current_value(family, at)`,
];

/**
 * The forward-only steps from one `SCHEMA_VERSION` to the next: each runs
 * under the write lock, after a copy of the store is kept, and a step that
 * rebuilds a table sets `foreignKeysOff`. None exists yet: 100 is the first
 * version.
 */
const STEPS: readonly {
  readonly from: number;
  readonly foreignKeysOff: boolean;
  readonly statements: readonly string[];
}[] = [];

type Sql = SqlClient.SqlClient;

const run = (sql: Sql, statement: string) => sql.unsafe(statement, []);

const pragmaValue = Effect.fnUntraced(function* (sql: Sql, pragma: string) {
  const row = (yield* sql.unsafe<Record<string, unknown>>(
    `PRAGMA ${pragma}`,
    [],
  ))[0];
  return row?.[pragma];
});

const verifyPragma = Effect.fnUntraced(function* (
  sql: Sql,
  pragma: string,
  expected: string | number,
) {
  const value = yield* pragmaValue(sql, pragma);
  if (value !== expected) {
    return yield* Effect.fail(
      new Error(
        `PRAGMA ${pragma} is ${String(value)}, expected ${String(expected)}`,
      ),
    );
  }
});

/** The user tables a file holds (none: a new file). */
const userTables = (sql: Sql) =>
  sql
    .unsafe<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      [],
    )
    .pipe(Effect.map((rows) => rows.map((row) => row.name)));

/** The refusal of a store a newer build wrote: nothing in it is touched. */
const newerStore = (path: string, stored: number) =>
  Effect.fail(
    new Error(
      `Session store ${path} was written by a newer TeXRA build (schema ${stored}); this build writes schema ${SCHEMA_VERSION}. Update TeXRA to open it. Nothing in the store was changed.`,
    ),
  );

/**
 * Keep a copy of the store at `aside`, then run `body` under the write lock
 * only if nothing committed since the copy: `VACUUM INTO` cannot run inside
 * a transaction, so the transaction re-reads `user_version` and
 * `data_version` (which moves on every other connection's commit) and, if
 * either moved, discards the copy and answers false for the caller to start
 * over from what the store now is.
 */
const underCopy = Effect.fnUntraced(function* <E>(
  sql: Sql,
  aside: string,
  body: Effect.Effect<void, E>,
) {
  const fs = yield* FileSystem.FileSystem;
  const stamp = yield* pragmaValue(sql, 'user_version');
  const version = yield* pragmaValue(sql, 'data_version');
  const staged = `${aside}.${randomUUID()}.partial`;
  yield* sql.unsafe('VACUUM INTO ?', [staged]);
  yield* run(sql, 'BEGIN IMMEDIATE');
  const moved = yield* Effect.gen(function* () {
    if (
      (yield* pragmaValue(sql, 'user_version')) !== stamp ||
      (yield* pragmaValue(sql, 'data_version')) !== version
    ) {
      return false;
    }
    yield* fs.rename(staged, aside);
    yield* body;
    return true;
  }).pipe(
    Effect.onError(() =>
      Effect.all([
        run(sql, 'ROLLBACK').pipe(Effect.ignore),
        fs.remove(staged, { force: true }).pipe(Effect.ignore),
      ]),
    ),
  );
  if (!moved) {
    yield* run(sql, 'ROLLBACK');
    yield* fs.remove(staged, { force: true });
    return false;
  }
  yield* run(sql, 'COMMIT');
  return true;
});

/** Give an empty file the 1.0 header: `auto_vacuum` is fixed when the first
 *  page is written, which enabling WAL already did, so one `VACUUM` of the
 *  empty file applies it. */
const incrementalVacuum = Effect.fnUntraced(function* (sql: Sql) {
  yield* run(sql, 'PRAGMA auto_vacuum = INCREMENTAL');
  if ((yield* pragmaValue(sql, 'auto_vacuum')) !== 2) yield* run(sql, 'VACUUM');
});

/**
 * Bring an open connection to the store this build writes (§3's open
 * sequence, steps 2 to 6), answering what it moved aside.
 *
 * The driver sets `busy_timeout` before enabling WAL, and that order is
 * load-bearing: `journal_mode = WAL` takes an exclusive lock, and at zero
 * a second process opening the same file lost appends to `SQLITE_BUSY`.
 * Once the store is ready the timeout drops to a 25 ms slice, and
 * `Database` retries a busy transaction on its own fiber schedule instead of
 * freezing the host thread in SQLite. `synchronous = NORMAL` is the WAL-safe
 * setting: `FULL` cost 1.4x to 1.8x, and `kill -9` mid-transaction lost
 * nothing at `NORMAL`.
 *
 * - A foreign `application_id` or a newer `SCHEMA_VERSION` is refused
 *   untouched.
 * - A store written before 1.0 (a stamp from 1 to 99, or tables with no
 *   stamp) is copied whole to `<file>.pre1`, every table is dropped, and
 *   the file starts fresh: nothing in it is kept, current values included.
 * - An empty file gets the schema, under the write lock; of two processes
 *   creating at once, the second finds it stamped and does nothing.
 * - An older 1.0 schema is copied to `<file>.schema<N>` and stepped forward.
 */
const prepareStore = Effect.fnUntraced(function* (
  sql: Sql,
  mode: 'persistent' | 'ephemeral',
  path: string,
  filename: string,
) {
  yield* run(sql, 'PRAGMA foreign_keys = ON');
  yield* run(sql, 'PRAGMA synchronous = NORMAL');
  yield* verifyPragma(
    sql,
    'journal_mode',
    mode === 'persistent' ? 'wal' : 'memory',
  );
  yield* verifyPragma(sql, 'foreign_keys', 1);
  const application = Number(yield* pragmaValue(sql, 'application_id'));
  if (application !== 0 && application !== APPLICATION_ID) {
    return yield* Effect.fail(
      new Error(
        `${path} is not a TeXRA session store (application id ${application}); nothing in it was changed.`,
      ),
    );
  }
  let movedAside: SessionStoreMovedAside | null = null;
  for (;;) {
    const stored = Number(yield* pragmaValue(sql, 'user_version'));
    if (stored === SCHEMA_VERSION) break;
    if (stored > SCHEMA_VERSION) return yield* newerStore(path, stored);
    const tables = yield* userTables(sql);
    if (stored === 0 && tables.length === 0) {
      if (mode === 'persistent') yield* incrementalVacuum(sql);
      yield* run(sql, 'BEGIN IMMEDIATE');
      yield* Effect.gen(function* () {
        if (Number(yield* pragmaValue(sql, 'user_version')) !== 0) return;
        for (const statement of [...TABLES, ...ADDITIVE])
          yield* run(sql, statement);
        yield* run(sql, `PRAGMA application_id = ${APPLICATION_ID}`);
        yield* run(sql, `PRAGMA user_version = ${SCHEMA_VERSION}`);
      }).pipe(Effect.onError(() => run(sql, 'ROLLBACK').pipe(Effect.ignore)));
      yield* run(sql, 'COMMIT');
      continue;
    }
    if (stored < 100) {
      const aside = `${filename}.pre1`;
      // Off outside the transaction (a no-op inside one): a drop then
      // neither checks nor cascades a foreign key it removes anyway.
      yield* run(sql, 'PRAGMA foreign_keys = OFF');
      const retired = yield* underCopy(
        sql,
        aside,
        Effect.gen(function* () {
          for (const table of yield* userTables(sql))
            yield* run(sql, `DROP TABLE "${table}"`);
          yield* run(sql, 'PRAGMA user_version = 0');
        }),
      ).pipe(
        Effect.ensuring(
          run(sql, 'PRAGMA foreign_keys = ON').pipe(Effect.ignore),
        ),
      );
      if (!retired) continue;
      yield* incrementalVacuum(sql);
      yield* Effect.logWarning(
        `Session store ${path} was written before TeXRA 1.0 (format ${stored}); this build keeps no compatibility with it, so the whole store was moved to ${aside} and starts fresh.`,
      ).pipe(withLogChannel(CHANNEL));
      movedAside = { path, aside, reason: 'pre-1.0' };
      continue;
    }
    const steps = STEPS.filter((step) => step.from >= stored);
    const foreignKeysOff = steps.some((step) => step.foreignKeysOff);
    if (foreignKeysOff) yield* run(sql, 'PRAGMA foreign_keys = OFF');
    yield* underCopy(
      sql,
      `${filename}.schema${stored}`,
      Effect.gen(function* () {
        for (const step of steps)
          for (const statement of step.statements) yield* run(sql, statement);
        const violation = (yield* sql.unsafe('PRAGMA foreign_key_check', []))
          .length;
        if (violation > 0)
          return yield* Effect.fail(
            new Error(
              `Upgrading ${path} from schema ${stored} left ${violation} foreign-key violations; nothing was changed.`,
            ),
          );
        yield* run(sql, `PRAGMA user_version = ${SCHEMA_VERSION}`);
      }),
    ).pipe(
      Effect.ensuring(
        foreignKeysOff
          ? run(sql, 'PRAGMA foreign_keys = ON').pipe(Effect.ignore)
          : Effect.void,
      ),
    );
  }
  for (const statement of ADDITIVE) yield* run(sql, statement);
  if (mode === 'persistent') {
    yield* run(sql, 'PRAGMA journal_size_limit = 1048576');
  }
  yield* run(sql, 'PRAGMA busy_timeout = 25');
  return movedAside;
});

/**
 * Open the store at `filename` through `connect` and prepare it. A file
 * SQLite reports damaged or not a database (`SQLITE_CORRUPT`,
 * `SQLITE_NOTADB`) at open is closed, moved aside with its WAL and
 * shared-memory files to `<file>.corrupt-<stamp>`, and a fresh store opens
 * in its place. Mid-session corruption fails its read instead: a file
 * another connection may hold is never moved while open.
 */
export const openStore = Effect.fnUntraced(function* <E, R>(
  connect: Effect.Effect<Sql, E, R | Scope.Scope>,
  mode: 'persistent' | 'ephemeral',
  path: string,
  filename: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const outer = yield* Effect.scope;
  const first = yield* Scope.fork(outer, 'sequential');
  const attempt = yield* connect.pipe(
    Effect.flatMap((sql) =>
      Effect.map(prepareStore(sql, mode, path, filename), (movedAside) => ({
        sql,
        movedAside,
      })),
    ),
    Scope.provide(first),
    Effect.catchCause((cause) => Effect.succeed({ cause })),
  );
  if ('sql' in attempt) return attempt;
  if (mode !== 'persistent' || !isDamaged(attempt.cause)) {
    return yield* Effect.failCause(attempt.cause);
  }
  yield* Scope.close(first, Exit.void);
  const aside = `${filename}.corrupt-${yield* Clock.currentTimeMillis}`;
  for (const suffix of ['', '-wal', '-shm']) {
    if (yield* fs.exists(`${filename}${suffix}`))
      yield* fs.rename(`${filename}${suffix}`, `${aside}${suffix}`);
  }
  yield* Effect.logWarning(
    `Session store ${path} is damaged; it was moved to ${aside} and a fresh store opened.`,
  ).pipe(withLogChannel(CHANNEL));
  const sql = yield* connect;
  yield* prepareStore(sql, mode, path, filename);
  return {
    sql,
    movedAside: { path, aside, reason: 'corrupt' } as SessionStoreMovedAside,
  };
});

/** Whether a failed open is SQLite reporting the file damaged or foreign:
 *  `SQLITE_CORRUPT` (11) or `SQLITE_NOTADB` (26), as a driver defect or a
 *  statement's classified cause. */
function isDamaged(cause: Cause.Cause<unknown>): boolean {
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

/** Refuse a write once another build has re-stamped the store under this
 *  process; read inside the write transaction, so the check and the append
 *  see one stamp. */
export const assertStoreFormat = Effect.fnUntraced(function* (
  sql: Sql,
  path: string,
) {
  const stored = yield* pragmaValue(sql, 'user_version');
  if (stored !== SCHEMA_VERSION) {
    return yield* Effect.fail(
      new Error(
        `Session store ${path} is stamped with schema ${String(stored)}; this process writes schema ${SCHEMA_VERSION} and stops writing to it.`,
      ),
    );
  }
});
