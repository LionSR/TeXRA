/**
 * The persistence substrate
 * (`docs/proposals/2026-09-03-persistence-substrate-decision.md`): the C1
 * schema, the connection that owns it, and the C6 write path. One database
 * per session root, parameterized by `WorkspaceRoots` (section 7) and never a
 * process singleton; Effect code reads its root from `Context`, never from
 * the async-local `workspaceRoots()`, because the scheduler interleaves
 * fibers.
 *
 * Nothing reads this yet. The memory log (`SessionEventLog.memoryLayer`)
 * stays the authoritative store until stage 2 moves the C7 reads onto the
 * table; this module is stage 1 of the cutover, and no production caller
 * reaches it.
 *
 * `node:sqlite` and `node:fs` are used directly rather than through a
 * `Platform` port on purpose: SQLite opens the path itself, and C1 requires
 * the file and its WAL to be a real local filesystem, so a virtual filesystem
 * port could not carry them. `node:sqlite` is experimental on every host
 * floor measured for stage 0, so this module confines itself to
 * `DatabaseSync`, `StatementSync`, and pragmas, the surface every floor has;
 * `backup` and `Session` are absent from Node 22 and must not be used while
 * that floor stands.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import {
  Context,
  Data,
  Effect,
  Layer,
  Semaphore,
  SubscriptionRef,
} from 'effect';

import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import {
  eventFromRow,
  eventPayload,
  EventRowSchema,
  type CommitOrdinal,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import { ProcessIdentity } from '@shared/session/sessionEvents';

/** The database file of a session root, beside the stores it replaces. */
export const SESSION_DATABASE_FILE = 'session.db';

/**
 * The C1 schema. Two tables and nothing else app-owned on disk.
 *
 * `commit` is a SQLite keyword, so the column is quoted at every site; the
 * stage 0 spike measured `CREATE TABLE t (commit INTEGER ...)` failing with a
 * syntax error on every host floor. The Zod row vocabulary
 * (`@shared/schemas/eventRow`) keeps the name unquoted, and every query below
 * aliases the snake-case columns onto it.
 *
 * `event_sequence` is declared first because `event` references it, and the
 * parent edge is self-referential, so both cascades exist the moment the
 * schema does. `STRICT` makes a wrong-typed value an error at insert instead
 * of a surprise at read: on persisted data, a silent coercion is the same
 * defect as a `.catch()` default.
 *
 * The three `event` indexes are the ones the C7 reads need: latest-of-type
 * per aggregate (the listing tier), one aggregate from a commit (the bounded
 * cross-aggregate resume read), and one type across aggregates in commit
 * order (the listing tier across streams). `UNIQUE (aggregate_id, seq)` is
 * both the density guarantee and the index a single aggregate's history reads
 * from its seq.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS event_sequence (
  aggregate_id TEXT NOT NULL PRIMARY KEY,
  seq          INTEGER NOT NULL,
  owner_id     TEXT,
  parent_id    TEXT REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
  closed       INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX IF NOT EXISTS event_sequence_parent
  ON event_sequence(parent_id);

CREATE TABLE IF NOT EXISTS event (
  "commit"     INTEGER PRIMARY KEY AUTOINCREMENT,
  aggregate_id TEXT NOT NULL
               REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  type         TEXT NOT NULL,
  owner_id     TEXT NOT NULL,
  at           INTEGER NOT NULL,
  data         TEXT NOT NULL,
  UNIQUE (aggregate_id, seq)
) STRICT;

CREATE INDEX IF NOT EXISTS event_agg_type_seq ON event(aggregate_id, type, seq);
CREATE INDEX IF NOT EXISTS event_agg_commit   ON event(aggregate_id, "commit");
CREATE INDEX IF NOT EXISTS event_type_commit  ON event(type, "commit");
`;

/** The database could not be opened, or its schema could not be applied. */
export class DatabaseOpenFailed extends Data.TaggedError('DatabaseOpenFailed')<{
  readonly path: string;
  readonly cause: unknown;
}> {}

/**
 * A batch was rejected. C6 is all-or-nothing: the transaction rolled back, so
 * no member and no sequence change survives, and the wake level did not move.
 */
export class DatabaseWriteFailed extends Data.TaggedError(
  'DatabaseWriteFailed',
)<{
  readonly path: string;
  readonly cause: unknown;
}> {}

/** Assign each aggregate its next `seq`, creating its sequence row on first use. */
const NEXT_SEQ = `
INSERT INTO event_sequence (aggregate_id, seq, owner_id)
VALUES (?, 1, ?)
ON CONFLICT(aggregate_id) DO UPDATE SET seq = event_sequence.seq + 1
RETURNING seq
`;

/** Insert one row and read back the ordinal SQLite assigned it. */
const INSERT_EVENT = `
INSERT INTO event (aggregate_id, seq, type, owner_id, at, data)
VALUES (?, ?, ?, ?, ?, ?)
RETURNING "commit" AS "commit"
`;

/** One validated draft, ready to bind: nothing is computed inside the
 *  transaction, because a busy timeout is a blocking wait on the only
 *  JavaScript thread and every other writer waits behind it. */
interface PreparedDraft {
  readonly aggregateId: string;
  readonly type: string;
  readonly data: string;
}

export class Database extends Context.Service<
  Database,
  {
    /**
     * C6: append an ordered batch, possibly across several aggregates, in one
     * `BEGIN IMMEDIATE` under the process's single permit. Each target's
     * `seq` and the database-wide `commit` are assigned in batch order, the
     * writer is this process (C5, derived here, never supplied by a caller),
     * and a failure of any member rolls back every member and every sequence
     * change. Returns the complete committed batch, which is what the fold
     * reads before exposing the state it produced.
     */
    readonly appendAll: (
      drafts: readonly SessionEventDraft[],
      at?: number,
    ) => Effect.Effect<readonly SessionEvent[], DatabaseWriteFailed>;
    /**
     * C6's process-local wake level, advanced after each commit. It carries
     * no payload: a subscriber woken by it reads the rows from the table.
     * A `SubscriptionRef` is Effect's unbounded pub/sub with the current
     * value replayed on subscribe, which is what C7's "drain, then wait for a
     * level above the one observed before the drain" needs: an edge-only
     * channel could drop a commit that lands between the two.
     */
    readonly level: SubscriptionRef.SubscriptionRef<CommitOrdinal>;
  }
>()('@texra/session/Database') {
  static readonly layer: Layer.Layer<
    Database,
    DatabaseOpenFailed,
    WorkspaceRoots | ProcessIdentity
  > = Layer.effect(
    Database,
    Effect.gen(function* () {
      const roots = yield* WorkspaceRoots;
      const identity = yield* ProcessIdentity;
      const path = join(roots.storage, SESSION_DATABASE_FILE);

      const db = yield* Effect.acquireRelease(
        Effect.try({
          try: () => open(roots.storage, path),
          catch: (cause) => new DatabaseOpenFailed({ path, cause }),
        }),
        (connection) => Effect.sync(() => connection.close()),
      );

      const nextSeq = db.prepare(NEXT_SEQ);
      const insertEvent = db.prepare(INSERT_EVENT);
      const level = yield* SubscriptionRef.make<CommitOrdinal>(lastCommit(db));
      const gate = yield* Semaphore.make(1);

      return {
        level,
        appendAll: (drafts, at = Date.now()) =>
          gate.withPermit(
            Effect.uninterruptible(
              Effect.gen(function* () {
                if (drafts.length === 0) return [];
                const committed = yield* Effect.try({
                  try: () =>
                    writeBatch(db, nextSeq, insertEvent, {
                      drafts,
                      at,
                      ownerId: identity.ownerId,
                    }),
                  catch: (cause) => new DatabaseWriteFailed({ path, cause }),
                });
                const last = committed.at(-1);
                if (last !== undefined) {
                  yield* SubscriptionRef.set(level, last.commit);
                }
                return committed;
              }),
            ),
          ),
      };
    }),
  );
}

/**
 * Open the connection and bring it to the state C1 requires.
 *
 * The pragma order is load-bearing, not stylistic. `PRAGMA busy_timeout` is
 * the first statement on every connection because `PRAGMA journal_mode = WAL`
 * itself takes an exclusive lock: the stage 0 spike killed a writer outright
 * with `SQLITE_BUSY_RECOVERY` when a second process opened the same database
 * while the timeout was still unset, and setting it first removed the failure
 * entirely. With the timeout set, a second writer blocks and then commits;
 * with it at zero, the spike measured 26% to 55% of concurrent appends lost
 * to `SQLITE_BUSY`, so this is a correctness setting and not tuning.
 *
 * `synchronous = NORMAL` is the WAL-safe setting: the spike measured
 * `FULL` at 1.4x to 1.8x the median cost and far worse tails, and measured
 * `kill -9` mid-transaction leaving zero uncommitted rows and a clean
 * `integrity_check` at `NORMAL`, which is exactly the C4 guarantee that a
 * crash loses the in-flight message and nothing else.
 */
function open(root: string, path: string): DatabaseSync {
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  verifyPragma(db, 'journal_mode', 'wal');
  verifyPragma(db, 'foreign_keys', 1);
  db.exec(SCHEMA);
  return db;
}

/** C1 requires every connection to verify its pragmas rather than assume
 *  them: a WAL that silently fell back to a rollback journal, or foreign keys
 *  silently off, would turn the cascade guarantees into wishes. */
function verifyPragma(
  db: DatabaseSync,
  pragma: string,
  expected: string | number,
): void {
  const row = db.prepare(`PRAGMA ${pragma}`).get();
  const value = row?.[pragma];
  if (value !== expected) {
    throw new Error(
      `PRAGMA ${pragma} is ${String(value)}, expected ${String(expected)}`,
    );
  }
}

/**
 * The wake level a reopened database starts from: the committed
 * `AUTOINCREMENT` high-water mark, which is what C7 bounds a read by. It is
 * read from `sqlite_sequence` rather than `MAX("commit")`, because the
 * maximum falls when retention removes rows while the high-water mark, and so
 * every cursor already handed out, does not.
 */
function lastCommit(db: DatabaseSync): CommitOrdinal {
  const row = db
    .prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'event'`)
    .get();
  return typeof row?.seq === 'number' ? row.seq : 0;
}

/**
 * The C6 transaction. Every draft is validated and serialized before
 * `BEGIN IMMEDIATE`, so the write lock is held only for the inserts: the
 * spike measured a deliberately held transaction blocking the other process
 * for its full duration, so slow work inside the lock is a hard rule and not
 * a preference.
 */
function writeBatch(
  db: DatabaseSync,
  nextSeq: StatementSync,
  insertEvent: StatementSync,
  batch: {
    readonly drafts: readonly SessionEventDraft[];
    readonly at: number;
    readonly ownerId: string;
  },
): readonly SessionEvent[] {
  if (!Number.isInteger(batch.at)) {
    throw new Error(`Publish clock ${batch.at} is not an integer millisecond`);
  }
  const prepared: PreparedDraft[] = batch.drafts.map((draft) => ({
    aggregateId: draft.aggregateId,
    type: draft.type,
    data: eventPayload(draft),
  }));

  db.exec('BEGIN IMMEDIATE');
  try {
    const committed = prepared.map((entry) => {
      const seq = nextSeq.get(entry.aggregateId, batch.ownerId)?.seq;
      if (typeof seq !== 'number') {
        throw new Error(`No seq assigned for aggregate ${entry.aggregateId}`);
      }
      const commit = insertEvent.get(
        entry.aggregateId,
        seq,
        entry.type,
        batch.ownerId,
        batch.at,
        entry.data,
      )?.commit;
      if (typeof commit !== 'number') {
        throw new Error(
          `No commit assigned for aggregate ${entry.aggregateId}`,
        );
      }
      return eventFromRow(
        EventRowSchema.parse({
          commit,
          aggregateId: entry.aggregateId,
          seq,
          type: entry.type,
          ownerId: batch.ownerId,
          at: batch.at,
          data: entry.data,
        }),
      );
    });
    db.exec('COMMIT');
    return committed;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
