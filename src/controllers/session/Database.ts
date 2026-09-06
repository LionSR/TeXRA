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
 * reaches it. It cannot be provided in `sessionLayer.ts` before then either:
 * the roots a session is opened over are virtual under the test platform
 * (`/workspace/.texra/storage`), and C1 requires a real local file, so the
 * layer is built by whoever holds a real root until the substrate owns them.
 *
 * Validation and redaction of a batch are the publish boundary's (C3, C6):
 * they run above this layer, on the drafts, before the substrate sees them.
 * What this layer owns is the envelope C1 gives its own columns: the writer
 * (C5, from `ProcessIdentity`), the publish clock, and the `seq` and
 * `commit` ordinals, none of which a caller can supply.
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
  Clock,
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  Semaphore,
  SubscriptionRef,
} from 'effect';

import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import type {
  CommitOrdinal,
  SessionEvent,
  SessionEventDraft,
} from '@shared/schemas';
import { ProcessIdentity } from '@shared/session/sessionEvents';

/** The database file of a session root, beside the stores it replaces. */
const SESSION_DATABASE_FILE = 'texra.db';

/**
 * The C1 schema. Two tables and nothing else app-owned on disk.
 *
 * `commit` is a SQLite keyword, so the column is quoted at every site; the
 * stage 0 spike measured `CREATE TABLE t (commit INTEGER ...)` failing with a
 * syntax error on every host floor. The event vocabulary keeps the name
 * unquoted, and every query below aliases the snake-case columns onto it.
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

/**
 * Assign each aggregate its next `seq`, creating its sequence row on first
 * use. `owner_id` is left NULL: C1 defines that column as the *current*
 * sequence writer, and a claim is one atomic acquire or takeover under C5,
 * which stage 6 implements. A first writer stamped here and never verified,
 * released, or taken over would say "owned forever" in a column that means
 * "owned now".
 */
const NEXT_SEQ = `
INSERT INTO event_sequence (aggregate_id, seq)
VALUES (?, 1)
ON CONFLICT(aggregate_id) DO UPDATE SET seq = event_sequence.seq + 1
RETURNING seq
`;

/** Insert one row and read back the ordinal SQLite assigned it. */
const INSERT_EVENT = `
INSERT INTO event (aggregate_id, seq, type, owner_id, at, data)
VALUES (?, ?, ?, ?, ?, ?)
RETURNING "commit" AS "commit"
`;

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
      const openFailed = (cause: unknown): DatabaseOpenFailed =>
        new DatabaseOpenFailed({ path, cause });

      // The connection is scoped before it is configured, so a pragma that
      // does not verify or a schema that does not apply closes the handle it
      // failed on instead of leaving the file and its WAL locked for the
      // life of the process.
      const db = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            mkdirSync(roots.storage, { recursive: true });
            return new DatabaseSync(path);
          },
          catch: openFailed,
        }),
        (connection) => Effect.sync(() => connection.close()),
      );
      const { nextSeq, insertEvent, lastCommit } = yield* Effect.try({
        try: () => configure(db),
        catch: openFailed,
      });

      const level = yield* SubscriptionRef.make<CommitOrdinal>(lastCommit);
      const gate = yield* Semaphore.make(1);
      const writeFailed = (cause: unknown): DatabaseWriteFailed =>
        new DatabaseWriteFailed({ path, cause });

      return {
        level,
        appendAll: (drafts) =>
          gate.withPermit(
            Effect.uninterruptible(
              Effect.gen(function* () {
                if (drafts.length === 0) return [];
                const at = yield* Clock.currentTimeMillis;
                // Serialized before the transaction opens. A busy timeout is
                // a blocking wait on the only JavaScript thread, so anything
                // computed under the write lock is time every other writer
                // spends blocked; the spike measured a deliberately held
                // transaction blocking the other process for its full
                // duration.
                const payloads = yield* Effect.try({
                  try: () => drafts.map(payloadOf),
                  catch: writeFailed,
                });
                const committed = yield* Effect.acquireUseRelease(
                  Effect.try({
                    try: () => db.exec('BEGIN IMMEDIATE'),
                    catch: writeFailed,
                  }),
                  () =>
                    Effect.try({
                      try: () =>
                        drafts.map((draft, index): SessionEvent => {
                          const seq = nextSeq.get(draft.aggregateId)?.seq;
                          if (typeof seq !== 'number') {
                            throw new Error(
                              `No seq assigned for aggregate ${draft.aggregateId}`,
                            );
                          }
                          const commit = insertEvent.get(
                            draft.aggregateId,
                            seq,
                            draft.type,
                            identity.ownerId,
                            at,
                            payloads[index]!,
                          )?.commit;
                          if (typeof commit !== 'number') {
                            throw new Error(
                              `No commit assigned for aggregate ${draft.aggregateId}`,
                            );
                          }
                          return {
                            ...draft,
                            seq,
                            commit,
                            ownerId: identity.ownerId,
                            at,
                          } as SessionEvent;
                        }),
                      catch: writeFailed,
                    }),
                  // The exit decides the verb, so an interrupted or failed
                  // batch rolls back whole and a `COMMIT` that cannot land
                  // rolls back rather than leaving the transaction open.
                  (_, exit) =>
                    Exit.isSuccess(exit)
                      ? Effect.try({
                          try: () => db.exec('COMMIT'),
                          catch: writeFailed,
                        }).pipe(
                          Effect.tapError(() =>
                            Effect.sync(() => db.exec('ROLLBACK')),
                          ),
                        )
                      : Effect.try({
                          try: () => db.exec('ROLLBACK'),
                          catch: writeFailed,
                        }),
                );
                yield* SubscriptionRef.set(level, committed.at(-1)!.commit);
                return committed;
              }),
            ),
          ),
      };
    }),
  );
}

/**
 * The `data` column of a draft: the arm minus the two fields C1 gives their
 * own columns. Structural typing permits a stamped event as a draft, so
 * explicitly remove every envelope key before serializing the payload.
 */
function payloadOf(draft: SessionEventDraft): string {
  const payload: Partial<SessionEvent> = { ...draft };
  delete payload.type;
  delete payload.aggregateId;
  delete payload.seq;
  delete payload.commit;
  delete payload.ownerId;
  delete payload.at;
  return JSON.stringify(payload);
}

/**
 * Bring an open connection to the state C1 requires, and prepare the two
 * statements the write path binds.
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
 *
 * `lastCommit` is the wake level a reopened database starts from: the
 * committed `AUTOINCREMENT` high-water mark, which is what C7 bounds a read
 * by. It is read from `sqlite_sequence` rather than `MAX("commit")`, because
 * the maximum falls when retention removes rows while the high-water mark,
 * and so every cursor already handed out, does not.
 */
function configure(db: DatabaseSync): {
  readonly nextSeq: StatementSync;
  readonly insertEvent: StatementSync;
  readonly lastCommit: CommitOrdinal;
} {
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  verifyPragma(db, 'journal_mode', 'wal');
  verifyPragma(db, 'foreign_keys', 1);
  db.exec(SCHEMA);
  const high = db
    .prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'event'`)
    .get();
  return {
    nextSeq: db.prepare(NEXT_SEQ),
    insertEvent: db.prepare(INSERT_EVENT),
    lastCommit: typeof high?.seq === 'number' ? high.seq : 0,
  };
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
