/**
 * The session store's physical schema
 * (`.agents/docs/proposed/architecture/2026-09-28-storage-v1-design.md` §2,
 * §3): its tables, columns, indexes and PRAGMAs, the open sequence that
 * brings a file to them, and `SCHEMA_VERSION` in SQLite's `user_version`.
 *
 * `SCHEMA_VERSION` names the DDL, never the row vocabulary: rows carry
 * their own versions (`rowVersions.ts`), and the kinds a store holds are
 * gated by `rowCodec.ts`, so it moves only for a change an older build
 * cannot write around. The 1.0 baseline is 101. A file below it holding
 * tables was written before 1.0 (100 a pre-release that never shipped);
 * this build reads none and moves it aside whole.
 *
 * This module knows no row kind and no payload field.
 */
import { Clock, Effect, Exit, FileSystem, Scope } from 'effect';
import { withLogChannel } from '@logger/effectLog';
import type { SessionStoreMovedAside } from '@shared/session/database';
import {
  cannotOpen,
  freeName,
  isDamaged,
  pragmaValue,
  retryBusy,
  run,
  underCopy,
  type Sql,
} from './storeAside';

const CHANNEL = 'sessionDatabase';

/** The DDL this build creates and writes. */
const SCHEMA_VERSION = 101;
/** The first stamp a released build wrote. Fixed for good: a store stamped
 *  below it is pre-1.0 and moved aside; one at or above it is kept. */
const BASELINE_1_0 = 101;
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
    value  BLOB NOT NULL
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
    UNIQUE (aggregate, seq)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS event_blob (
    "commit" INTEGER NOT NULL REFERENCES event("commit") ON DELETE CASCADE,
    digest   TEXT NOT NULL REFERENCES blob(digest),
    PRIMARY KEY ("commit", digest)
  ) STRICT, WITHOUT ROWID`,
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
  `CREATE INDEX IF NOT EXISTS event_blob_digest ON event_blob(digest)`,
  `CREATE INDEX IF NOT EXISTS current_value_at ON current_value(family, at)`,
];

const verifyPragma = Effect.fnUntraced(function* (
  sql: Sql,
  pragma: string,
  expected: string | number,
) {
  const value = yield* pragmaValue(sql, pragma);
  if (value !== expected)
    return yield* Effect.fail(
      new Error(`PRAGMA ${pragma} is ${String(value)}, not ${expected}`),
    );
});

/** The user tables a file holds (none: a new file). */
const userTables = (sql: Sql) =>
  sql
    .unsafe<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      [],
    )
    .pipe(Effect.map((rows) => rows.map((row) => row.name)));

/** A pre-1.0 TeXRA store's mark: `event`, `event_sequence` keyed by `aggregate_id`. */
const PRE1_SIGNATURE = `SELECT count(*) AS keyed FROM pragma_table_info('event') a,
  pragma_table_info('event_sequence') b
  WHERE a.name = 'aggregate_id' AND b.name = 'aggregate_id'`;

/** The refusal of a file this build must not touch. */
const refused = (path: string, why: string) =>
  Effect.fail(
    new Error(`Session store ${path} ${why}; nothing in it was changed.`),
  );

/** Give an empty file the 1.0 header: `auto_vacuum` is fixed when the first
 *  page is written, which enabling WAL already did, so one `VACUUM` of the
 *  empty file applies it. */
const incrementalVacuum = Effect.fnUntraced(function* (sql: Sql) {
  yield* run(sql, 'PRAGMA auto_vacuum = INCREMENTAL');
  if ((yield* pragmaValue(sql, 'auto_vacuum')) !== 2) yield* run(sql, 'VACUUM');
});

/**
 * Refuse a file this build must not touch, answering whether it is a store
 * written before 1.0, which the caller moves aside (a released store never
 * is). Refused: another application's file (its `application_id`, a 1.0
 * stamp without TeXRA's, or tables without `PRE1_SIGNATURE` below the
 * baseline), a newer schema, and a released one this build has no step from.
 * Run read-only before the store's own connection enables WAL, and again.
 */
const checkStamps = Effect.fnUntraced(function* (sql: Sql, path: string) {
  const application = Number(yield* pragmaValue(sql, 'application_id'));
  const stored = Number(yield* pragmaValue(sql, 'user_version'));
  const pre1 = stored < BASELINE_1_0 && (yield* userTables(sql)).length > 0;
  const signed =
    pre1 &&
    (yield* sql.unsafe<{ keyed: number }>(PRE1_SIGNATURE, []))[0]?.keyed === 1;
  if (
    application === 0
      ? stored >= BASELINE_1_0 || (pre1 && !signed)
      : application !== APPLICATION_ID
  )
    return yield* refused(
      path,
      `is not a TeXRA store (application id ${application}, schema ${stored}); move it away to let TeXRA create its store there`,
    );
  if (stored >= BASELINE_1_0 && stored !== SCHEMA_VERSION)
    return yield* refused(
      path,
      `has schema ${stored} and this build writes ${SCHEMA_VERSION}: ${stored > SCHEMA_VERSION ? 'update TeXRA to open it' : 'no step from it exists'}`,
    );
  return pre1;
});

/**
 * Bring an open connection to the store this build writes (§3's open
 * sequence, steps 2 to 6), answering what it moved aside.
 *
 * The driver sets `busy_timeout` before enabling WAL, and that order is
 * load-bearing: `journal_mode = WAL` takes an exclusive lock, and at zero a
 * second process opening the same file lost appends to `SQLITE_BUSY`. Once the
 * store is ready the timeout drops to a 25 ms slice, and `Database` retries a
 * busy transaction on its own fiber schedule instead of freezing the host
 * thread in SQLite. `synchronous = NORMAL` is the WAL-safe setting: `FULL` cost
 * 1.4x to 1.8x, and `kill -9` mid-transaction lost nothing at `NORMAL`.
 *
 * A store written before 1.0 is copied whole to the first free `.pre1`
 * name and every table dropped (`underCopy`); an empty file gets the schema
 * under the write lock, which a second process finds stamped.
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
  let movedAside: SessionStoreMovedAside | null = null;
  for (;;) {
    const pre1 = yield* checkStamps(sql, path);
    const stored = Number(yield* pragmaValue(sql, 'user_version'));
    if (stored === SCHEMA_VERSION) break;
    if (!pre1) {
      if (mode === 'persistent') yield* incrementalVacuum(sql);
      yield* run(sql, 'BEGIN IMMEDIATE');
      yield* Effect.gen(function* () {
        // Another process stamped the file while this one waited: the
        // loop checks it again.
        if (Number(yield* pragmaValue(sql, 'user_version')) !== stored) return;
        for (const statement of [...TABLES, ...ADDITIVE])
          yield* run(sql, statement);
        yield* run(sql, `PRAGMA application_id = ${APPLICATION_ID}`);
        yield* run(sql, `PRAGMA user_version = ${SCHEMA_VERSION}`);
      }).pipe(Effect.onError(() => run(sql, 'ROLLBACK').pipe(Effect.ignore)));
      yield* run(sql, 'COMMIT');
      continue;
    }
    // Off outside the transaction (a no-op inside one): a drop then
    // neither checks nor cascades a foreign key it removes anyway.
    yield* run(sql, 'PRAGMA foreign_keys = OFF');
    const aside = yield* underCopy(
      sql,
      `${filename}.pre1`,
      Effect.gen(function* () {
        for (const table of yield* userTables(sql))
          yield* run(sql, `DROP TABLE "${table}"`);
        yield* run(sql, 'PRAGMA user_version = 0');
      }),
    ).pipe(
      Effect.ensuring(run(sql, 'PRAGMA foreign_keys = ON').pipe(Effect.ignore)),
    );
    if (aside === null) continue;
    yield* incrementalVacuum(sql);
    yield* Effect.logWarning(
      `Session store ${path} was written before TeXRA 1.0 (format ${stored}); this build keeps no compatibility with it, so the whole store was moved to ${aside} and starts fresh.`,
    ).pipe(withLogChannel(CHANNEL));
    movedAside = { path, aside, reason: 'pre-1.0' };
  }
  for (const statement of ADDITIVE) yield* run(sql, statement);
  if (mode === 'persistent') {
    yield* run(sql, 'PRAGMA journal_size_limit = 1048576');
  }
  yield* run(sql, 'PRAGMA busy_timeout = 25');
  return movedAside;
});

/** Pages one reclaim step frees at most: a few milliseconds of the lock. */
const RECLAIM_PAGES = 256;

/**
 * Give the pages a collection freed back to the filesystem (the design's
 * §7), once it commits, in autocommit steps of `incremental_vacuum(N)`, so
 * another writer waits on one step, never the whole reclaim. A driver that
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
      yield* retryBusy(run(sql, `PRAGMA incremental_vacuum(${RECLAIM_PAGES})`));
      const now = yield* free();
      if (now >= left) return;
      left = now;
    }
  }).pipe(
    Effect.uninterruptible,
    Effect.catch((error) =>
      Effect.logWarning(
        `Could not return the pages freed in ${path} to the filesystem; the next collection retries.`,
      ).pipe(Effect.annotateLogs({ data: error }), withLogChannel(CHANNEL)),
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
  /** A read-only connection that changes nothing in the file. */
  probe: Effect.Effect<Sql, E, R | Scope.Scope>,
  mode: 'persistent' | 'ephemeral',
  path: string,
  filename: string,
) {
  const fs = yield* FileSystem.FileSystem;
  // A file the probe cannot open (none yet) is the open's to create; one
  // SQLite reads as damaged (cut short in its first page) is moved below.
  if (mode === 'persistent')
    yield* Effect.scoped(
      Effect.flatMap(probe, (sql) => checkStamps(sql, path)),
    ).pipe(
      Effect.catchCause((cause) =>
        cannotOpen(cause) || isDamaged(cause)
          ? Effect.void
          : Effect.failCause(cause),
      ),
    );
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
  // Another process may have seen the same damage and already put a fresh
  // store here: move the file only while it is the one that still fails a
  // read, by the same identity (inode, size, mtime) up to the rename.
  const identity = fs.stat(filename).pipe(
    Effect.map((info) => `${info.ino}/${info.size}/${info.mtime}`),
    Effect.orElseSucceed(() => null),
  );
  const seen = yield* identity;
  const stillDamaged = yield* Effect.scoped(
    Effect.flatMap(probe, (sql) => userTables(sql)),
  ).pipe(
    Effect.as(false),
    Effect.catchCause((cause) => Effect.succeed(isDamaged(cause))),
  );
  if (!stillDamaged || seen === null || (yield* identity) !== seen) {
    const sql = yield* connect;
    return { sql, movedAside: yield* prepareStore(sql, mode, path, filename) };
  }
  const aside = yield* freeName(
    `${filename}.corrupt-${yield* Clock.currentTimeMillis}`,
  );
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
    movedAside: { path, aside, reason: 'corrupt' as const },
  };
});
