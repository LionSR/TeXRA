/**
 * The session store's physical schema: its tables, columns, indexes and PRAGMAs, the open sequence that
 * brings a file to them, and `SCHEMA_VERSION` in SQLite's `user_version`.
 *
 * `SCHEMA_VERSION` names the DDL, never the row vocabulary: rows carry
 * their own versions (`rowVersions.ts`), and the kinds a store holds are
 * gated by `rowCodec.ts`, so it moves only for a change an older build
 * cannot write around. An unstamped file gets the schema. A file stamped
 * with another schema fails the open unchanged: an earlier one has no step
 * to this one (there is no migration), a later one is a newer build's. A
 * file SQLite reports damaged is renamed aside and a fresh store opened.
 * This module knows no row kind or payload field.
 */
import { Clock, Effect, Exit, FileSystem, Scope } from 'effect';
import { logFailure, withLogChannel } from '@logger/effectLog';
import {
  isDamaged,
  pragmaValue,
  run,
  STORE_FILE_SUFFIXES,
  StoreCheckFailed,
  type Sql,
} from './storeAside';

const CHANNEL = 'sessionDatabase';

/** The DDL this build creates and writes. */
const SCHEMA_VERSION = 105;

/**
 * The tables every store holds. `commit` is a SQLite keyword, so the column
 * is quoted at every site. `STRICT` makes a wrong-typed value an error at
 * insert rather than a surprise at read.
 *
 * `event_sequence` is one aggregate: a local integer surrogate `id` (never
 * outside the file), the `(kind, logical_id)` the codec maps an
 * `AggregateId` to, the durable `uid`, its sequence counter, its parent
 * edge, and two lifecycle facts written by the transaction that makes
 * them: `start_commit` (the commit of seq 1) and `closed_by` (the
 * deletion marker's commit, `NULL` while open). The foreign keys are the
 * collection mechanism: deleting an aggregate cascades to its dependents,
 * its events, their blob links and its projections, and the last link's
 * deletion takes its blob (`event_blob_collect`).
 *
 * `event_blob` links a row to each blob it needs kept: `inline` is 1 for a
 * string the codec moved out of the row, which a read inflates back, and 0
 * for a media address the row names, never inflated.
 */
const TABLES = [
  `CREATE TABLE IF NOT EXISTS event_sequence (
    id           INTEGER PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind <> ''),
    logical_id   TEXT NOT NULL CHECK (logical_id <> ''),
    uid          TEXT NOT NULL UNIQUE,
    seq          INTEGER NOT NULL CHECK (seq >= 1),
    start_commit INTEGER,
    parent_id    INTEGER REFERENCES event_sequence(id) ON DELETE CASCADE,
    closed_by    INTEGER,
    UNIQUE (kind, logical_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS blob (
    digest TEXT PRIMARY KEY CHECK (length(digest) = 64),
    value  BLOB NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS event (
    "commit"  INTEGER PRIMARY KEY AUTOINCREMENT,
    aggregate INTEGER NOT NULL REFERENCES event_sequence(id) ON DELETE CASCADE,
    seq       INTEGER NOT NULL,
    type      TEXT NOT NULL,
    version   INTEGER NOT NULL CHECK (version >= 1),
    at        INTEGER NOT NULL,
    data      TEXT NOT NULL,
    UNIQUE (aggregate, seq)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS event_blob (
    "commit" INTEGER NOT NULL REFERENCES event("commit") ON DELETE CASCADE,
    digest   TEXT NOT NULL REFERENCES blob(digest),
    inline   INTEGER NOT NULL CHECK (inline IN (0, 1)),
    PRIMARY KEY ("commit", digest)
  ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS stored_kind (
    type    TEXT PRIMARY KEY,
    version INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS current_value (
    family  TEXT NOT NULL,
    key     TEXT NOT NULL,
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
 * `projection_state` (`projections.ts`), the indexes, each serving one
 * lookup the reads make, named for the columns it keys, and the blob
 * collector.
 */
const ADDITIVE = [
  `CREATE TABLE IF NOT EXISTS projection_state (
    name           TEXT PRIMARY KEY,
    version        INTEGER NOT NULL,
    through_commit INTEGER NOT NULL
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
  `CREATE INDEX IF NOT EXISTS event_sequence_parent
    ON event_sequence(parent_id) WHERE parent_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS event_aggregate_type ON event(aggregate, type, seq)`,
  `CREATE INDEX IF NOT EXISTS event_type_commit ON event(type, "commit")`,
  `CREATE INDEX IF NOT EXISTS event_blob_digest ON event_blob(digest)`,
  `CREATE INDEX IF NOT EXISTS current_value_at ON current_value(family, at)`,
  // Collection by reachability: a blob goes with the last row linking it,
  // which the cascade from a collected aggregate removes. The link's
  // foreign key refuses deleting a blob any row still links.
  `CREATE TRIGGER IF NOT EXISTS event_blob_collect AFTER DELETE ON event_blob
    WHEN NOT EXISTS (SELECT 1 FROM event_blob r WHERE r.digest = OLD.digest)
    BEGIN DELETE FROM blob WHERE digest = OLD.digest; END`,
];

const verifyPragma = Effect.fnUntraced(function* (
  sql: Sql,
  pragma: string,
  expected: string | number,
) {
  const value = yield* pragmaValue(sql, pragma);
  if (value !== expected)
    return yield* new StoreCheckFailed({
      message: `PRAGMA ${pragma} is ${String(value)}, not ${expected}`,
    });
});

/** Give an empty file its `auto_vacuum` setting, which is fixed when the
 *  first page is written. Enabling WAL already wrote it, so one `VACUUM` of
 *  the empty file applies the setting. */
const incrementalVacuum = Effect.fnUntraced(function* (sql: Sql) {
  yield* run(sql, 'PRAGMA auto_vacuum = INCREMENTAL');
  if ((yield* pragmaValue(sql, 'auto_vacuum')) !== 2) yield* run(sql, 'VACUUM');
});

/** Whether the file is already this build's store (false: an unstamped
 *  file, which the caller gives the schema). A newer build's schema and an
 *  earlier build's, which this build has no step from, fail the open. */
const checkStamps = Effect.fnUntraced(function* (sql: Sql, path: string) {
  const stored = Number(yield* pragmaValue(sql, 'user_version'));
  if (stored === SCHEMA_VERSION) return true;
  if (stored === 0) return false;
  return yield* new StoreCheckFailed({
    message:
      stored > SCHEMA_VERSION
        ? `Session store ${path} has schema ${stored}, newer than this build's ${SCHEMA_VERSION}: a newer build opens it.`
        : `Session store ${path} was written by an earlier build (schema ${stored}; this build writes ${SCHEMA_VERSION}) and this build keeps no compatibility with it; move it away to create a fresh store there.`,
  });
});

/** The filename SQLite opens as a store held in memory, not in a file: it
 *  journals in memory, is never vacuumed and is never moved aside. */
export const IN_MEMORY_STORE = ':memory:';

/**
 * Bring an open connection to the store this build writes: pragmas, and the
 * schema stamped on a new file.
 *
 * The driver sets `busy_timeout` before enabling WAL, and that order is
 * load-bearing: `journal_mode = WAL` takes an exclusive lock, and at zero a
 * second process opening the same file lost appends to `SQLITE_BUSY`. Once the
 * store is ready the timeout drops to a 25 ms slice, and the global store,
 * the one store other processes write, retries a busy transaction on its own
 * fiber schedule instead of freezing the host thread in SQLite. `synchronous = NORMAL` is the WAL-safe setting: `FULL` cost
 * 1.4x to 1.8x, and `kill -9` mid-transaction lost nothing at `NORMAL`.
 *
 * A new file gets the schema under the write lock, which a second process
 * finds stamped.
 */
const prepareStore = Effect.fnUntraced(function* (
  sql: Sql,
  path: string,
  filename: string,
) {
  const persistent = filename !== IN_MEMORY_STORE;
  yield* run(sql, 'PRAGMA foreign_keys = ON');
  yield* run(sql, 'PRAGMA synchronous = NORMAL');
  yield* verifyPragma(sql, 'journal_mode', persistent ? 'wal' : 'memory');
  yield* verifyPragma(sql, 'foreign_keys', 1);
  if (!(yield* checkStamps(sql, path))) {
    if (persistent) yield* incrementalVacuum(sql);
    yield* Effect.gen(function* () {
      // Another process may have stamped the file while this one waited.
      if (yield* checkStamps(sql, path)) return;
      for (const statement of [...TABLES, ...ADDITIVE])
        yield* run(sql, statement);
      yield* run(sql, `PRAGMA user_version = ${SCHEMA_VERSION}`);
    }).pipe(sql.withTransaction);
  }
  for (const statement of ADDITIVE) yield* run(sql, statement);
  if (persistent) {
    yield* run(sql, 'PRAGMA journal_size_limit = 1048576');
  }
  yield* run(sql, 'PRAGMA busy_timeout = 25');
});

/** Pages one reclaim step frees at most: a few milliseconds of the lock. */
const RECLAIM_PAGES = 256;

/**
 * Give the pages a collection freed back to the filesystem, once it
 * commits, in autocommit steps of `incremental_vacuum(N)`, so another
 * fiber's write on this connection waits on one step, never the whole
 * reclaim (only a project store collects, and its holder is its one writer). A driver that
 * steps a statement to its end frees N pages a step, one that steps it once
 * frees one; either way the steps run until the freelist is empty or stops
 * shrinking. It is not interrupted, as the collection is not: a session that
 * closes first would leave the pages. A step that fails ends it, and the
 * next collection reclaims the rest.
 */
export const reclaimFreePages = (sql: Sql, path: string) =>
  Effect.gen(function* () {
    const free = () =>
      pragmaValue(sql, 'freelist_count').pipe(Effect.map(Number));
    for (let left = yield* free(); left > 0;) {
      yield* run(sql, `PRAGMA incremental_vacuum(${RECLAIM_PAGES})`);
      const now = yield* free();
      if (now >= left) return;
      left = now;
    }
  }).pipe(
    Effect.uninterruptible,
    Effect.catch(
      logFailure(
        CHANNEL,
        `Could not return the pages freed in ${path} to the filesystem; the next collection retries.`,
      ),
    ),
  );

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
  path: string,
  filename: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const outer = yield* Effect.scope;
  // The first open in a scope of its own, which a failed open closes: the
  // file is moved only while no connection of this process holds it.
  const scope = yield* Scope.fork(outer, 'sequential');
  const first = yield* connect.pipe(
    Effect.tap((sql) => prepareStore(sql, path, filename)),
    Scope.provide(scope),
    Effect.onError(() => Scope.close(scope, Exit.void)),
    Effect.exit,
  );
  if (Exit.isSuccess(first)) return { sql: first.value, movedAside: null };
  if (filename === IN_MEMORY_STORE || !isDamaged(first.cause))
    return yield* Effect.failCause(first.cause);
  const aside = `${filename}.corrupt-${yield* Clock.currentTimeMillis}`;
  for (const suffix of STORE_FILE_SUFFIXES) {
    if (yield* fs.exists(`${filename}${suffix}`))
      yield* fs.rename(`${filename}${suffix}`, `${aside}${suffix}`);
  }
  yield* Effect.logWarning(
    `Session store ${path} is damaged; it was moved to ${aside} and a fresh store opened.`,
  ).pipe(withLogChannel(CHANNEL));
  const sql = yield* connect;
  yield* prepareStore(sql, path, filename);
  return { sql, movedAside: { path, aside } };
});
