/**
 * The persistence substrate
 * (`docs/proposals/2026-09-03-persistence-substrate-decision.md`): the C1
 * schema, the connection that owns it, and the C6 write path. One database
 * per session root, parameterized by `WorkspaceRoots` (section 7) and never a
 * process singleton; Effect code reads its root from `Context`, never from
 * the async-local `workspaceRoots()`, because the scheduler interleaves
 * fibers.
 *
 * Persistent sessions open one file; explicitly ephemeral sessions use the
 * same schema and transaction implementation in SQLite memory. A failed file
 * open is an error and never selects the ephemeral mode.
 *
 * This layer validates, redacts, and serializes the complete batch before
 * beginning its transaction (C3, C6). It also owns the envelope C1 gives its
 * own columns: the writer
 * (C5, from `ProcessIdentity`), the publish clock, and the `seq` and
 * `commit` ordinals, none of which a caller can supply.
 *
 * `node:sqlite` and `node:fs` are used directly rather than through a
 * `Platform` port on purpose: SQLite opens the path itself, and C1 requires
 * the file and its WAL to be a real local filesystem, so a virtual filesystem
 * port could not carry them. `node:sqlite` is experimental on every host
 * floor measured for stage 0, so this module confines itself to
 * `DatabaseSync`, `StatementSync`, and pragmas, the surface every floor has;
 * `backup` and `StatementSync.columns()` arrived only in Node 22.16, after
 * the approved 22.13 floor. Neither belongs to this implementation.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import {
  Clock,
  Effect,
  Exit,
  Layer,
  Semaphore,
  Result,
  Stream,
  SubscriptionRef,
} from 'effect';
import { z } from 'zod';

import { proveOwnerLiveness } from '@agent/storage/leaseOwnerLiveness';
import { parseJsonWith } from '@common/parsing/safeParseJson';

import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import {
  SessionEventDraftSchema,
  SessionEventSchema,
  ownerIdentity,
  aggregateTarget,
  aggregateId as qualifyAggregateId,
  listingTypeOf,
  referencedAggregates,
  type AggregateId,
  type CommitOrdinal,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { redactTraceDraft } from '@shared/session/traceRedaction';
import {
  AggregateStateSchema,
  type AggregateState,
  Database,
  DatabaseOpenFailed,
  DatabaseReadFailed,
  DatabaseWriteFailed,
} from '@shared/session/database';
import { localDatabasePath } from './localDatabasePath';

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

const EVENT_COLUMNS = `e."commit" AS "commit", e.aggregate_id AS aggregateId,
  e.seq, e.type, e.owner_id AS ownerId, e.at, e.data`;

/** Listing arms of the present vocabulary; approval requests are a set. */
const LISTING_TYPES = SessionEventDraftSchema.options
  .map((schema) => schema.shape.type.value)
  .filter(
    (type) =>
      listingTypeOf({ type }) !== null &&
      type !== 'approval.requested' &&
      type !== 'approval.resolved',
  )
  .map((type) => `${type}.1`);

const READ_LISTING = `
WITH latest AS (
  SELECT aggregate_id, type, MAX(seq) AS seq FROM event
  WHERE type IN (SELECT value FROM json_each(?))
  GROUP BY aggregate_id, type
), selected AS (
  SELECT ${EVENT_COLUMNS} FROM latest
  JOIN event e ON e.aggregate_id = latest.aggregate_id
    AND e.type = latest.type AND e.seq = latest.seq
  UNION ALL
  SELECT ${EVENT_COLUMNS} FROM event e
  WHERE e.type = 'approval.requested.1' AND NOT EXISTS (
    SELECT 1 FROM event resolved
    WHERE resolved.aggregate_id = e.aggregate_id
      AND resolved.type = 'approval.resolved.1'
      AND json_extract(resolved.data, '$.requestId') = json_extract(e.data, '$.requestId')
  )
)
SELECT * FROM selected
WHERE json_extract(aggregateId, '$[0]') <> 'migration'
ORDER BY "commit"
`;

const READ_STATE = `
SELECT s.aggregate_id AS aggregateId, s.owner_id AS ownerId,
  s.closed, s.parent_id AS parentId,
  CASE WHEN json_extract(s.aggregate_id, '$[0]') = 'stream'
    THEN (SELECT e."commit" FROM event e
          WHERE e.aggregate_id = s.aggregate_id AND e.seq = 1)
    ELSE NULL END AS startCommit
FROM event_sequence s
WHERE s.aggregate_id IN (SELECT value FROM json_each(?))
  AND json_extract(s.aggregate_id, '$[0]') <> 'migration'
`;

const PayloadSchema = z.record(z.string(), z.unknown());
const StoredTypeSchema = z.string().endsWith('.1');

/** Stored versions are checked before reconstructing the typed event. */
function decodeEvent(row: Record<string, unknown>): SessionEvent {
  const payload = Result.getOrThrow(
    parseJsonWith(z.string().parse(row.data), PayloadSchema),
  );
  return SessionEventSchema.parse({
    ...payload,
    aggregateId: row.aggregateId,
    seq: row.seq,
    commit: row.commit,
    ownerId: row.ownerId,
    at: row.at,
    type: StoredTypeSchema.parse(row.type).slice(0, -2),
  });
}

/** First append claims the aggregate; later appends require that same claim. */
const NEXT_SEQ = `
INSERT INTO event_sequence (aggregate_id, seq, owner_id)
VALUES (?, 1, ?)
ON CONFLICT(aggregate_id) DO UPDATE SET seq = event_sequence.seq + 1
WHERE event_sequence.owner_id = excluded.owner_id AND event_sequence.closed = 0
RETURNING seq
`;

/** Insert one row and read back the ordinal SQLite assigned it. */
const INSERT_EVENT = `
INSERT INTO event (aggregate_id, seq, type, owner_id, at, data)
VALUES (?, ?, ?, ?, ?,
  CASE WHEN ? IS NULL THEN ? ELSE json_set(?, '$.parentStartCommit', ?) END)
RETURNING "commit" AS "commit"
`;

export const databaseLayer = (
  mode: 'persistent' | 'ephemeral',
): Layer.Layer<
  Database,
  DatabaseOpenFailed,
  WorkspaceRoots | ProcessIdentity
> =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const roots = yield* WorkspaceRoots;
      const identity = yield* ProcessIdentity;
      const path =
        mode === 'persistent'
          ? join(roots.storage, SESSION_DATABASE_FILE)
          : ':memory:';
      const openFailed = (cause: unknown): DatabaseOpenFailed =>
        new DatabaseOpenFailed({ path, cause });

      // The connection is scoped before it is configured, so a pragma that
      // does not verify or a schema that does not apply closes the handle it
      // failed on instead of leaving the file and its WAL locked for the
      // life of the process.
      const db = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            if (mode === 'ephemeral') return new DatabaseSync(path);
            mkdirSync(roots.storage, { recursive: true });
            return new DatabaseSync(
              localDatabasePath(roots.storage, SESSION_DATABASE_FILE),
            );
          },
          catch: openFailed,
        }),
        (connection) => Effect.sync(() => connection.close()),
      );
      const { nextSeq, insertEvent } = yield* Effect.try({
        try: () => configure(db, mode),
        catch: openFailed,
      });

      const level = yield* SubscriptionRef.make(0);
      const gate = yield* Semaphore.make(1);
      const writeFailed = (cause: unknown): DatabaseWriteFailed =>
        new DatabaseWriteFailed({ path, cause });

      const readFailed = (cause: unknown): DatabaseReadFailed =>
        new DatabaseReadFailed({ path, cause });
      const query = <A>(read: () => A): Effect.Effect<A, DatabaseReadFailed> =>
        gate.withPermit(Effect.try({ try: read, catch: readFailed }));
      const highWater = db.prepare(
        "SELECT seq FROM sqlite_sequence WHERE name = 'event'",
      );
      const currentCommit = (): CommitOrdinal => {
        const row = highWater.get();
        return row === undefined ? 0 : z.int().nonnegative().parse(row.seq);
      };
      const observedCommit = yield* SubscriptionRef.make(currentCommit());
      const listing = db.prepare(READ_LISTING);
      const state = db.prepare(READ_STATE);
      const dependents = `WITH RECURSIVE dependents(aggregate_id) AS (
        SELECT aggregate_id FROM event_sequence WHERE aggregate_id = ?
        UNION ALL
        SELECT child.aggregate_id FROM event_sequence child
        JOIN dependents parent ON child.parent_id = parent.aggregate_id
      )`;
      const unownedDependent = db.prepare(`${dependents}
        SELECT aggregate_id FROM event_sequence
        WHERE aggregate_id IN (SELECT aggregate_id FROM dependents)
          AND closed = 0 AND owner_id IS NOT ?
        LIMIT 1
      `);
      const closeDependents = db.prepare(`${dependents}
        UPDATE event_sequence SET closed = 1
        WHERE aggregate_id IN (SELECT aggregate_id FROM dependents)
      `);
      const all = db.prepare(`SELECT ${EVENT_COLUMNS} FROM event e
        WHERE e."commit" > ? AND e."commit" <= ?
          AND json_extract(e.aggregate_id, '$[0]') <> 'migration'
        ORDER BY e."commit"`);
      const aggregate = db.prepare(`SELECT ${EVENT_COLUMNS} FROM event e
        WHERE e.aggregate_id = ? AND e.seq >= ?
          AND json_extract(e.aggregate_id, '$[0]') <> 'migration'
        ORDER BY e.seq`);
      const after = db.prepare(`SELECT ${EVENT_COLUMNS} FROM event e
        WHERE e.aggregate_id IN (SELECT value FROM json_each(?))
          AND e."commit" > ? AND e."commit" <= ?
          AND json_extract(e.aggregate_id, '$[0]') <> 'migration'
        ORDER BY e."commit"`);
      const inputTypes = JSON.stringify([
        ...LISTING_TYPES,
        'approval.requested.1',
        'approval.resolved.1',
      ]);
      const inputRows = db.prepare(`
        SELECT ${EVENT_COLUMNS} FROM event e
        WHERE e.type IN (SELECT value FROM json_each(?))
          AND e."commit" > ? AND e."commit" <= ?
          AND json_extract(e.aggregate_id, '$[0]') <> 'migration'
        UNION ALL
        SELECT ${EVENT_COLUMNS} FROM event e
        WHERE e.aggregate_id IN (SELECT value FROM json_each(?))
          AND e.type NOT IN (SELECT value FROM json_each(?))
          AND e."commit" > ? AND e."commit" <= ?
          AND json_extract(e.aggregate_id, '$[0]') <> 'migration'
        ORDER BY "commit"
      `);
      const dataVersion = db.prepare('PRAGMA data_version');
      let version = dataVersion.get()?.data_version;
      yield* Effect.forkScoped(
        Stream.tick('250 millis').pipe(
          Stream.runForEach(() =>
            Effect.gen(function* () {
              const next = yield* query(() => dataVersion.get()?.data_version);
              if (next === version) return;
              version = next;
              yield* SubscriptionRef.set(
                observedCommit,
                yield* query(currentCommit),
              );
              yield* SubscriptionRef.update(level, (wake) => wake + 1);
            }),
          ),
        ),
      );

      const transaction = <A, E>(
        mode: 'read' | 'write',
        body: () => A,
        failed: (cause: unknown) => E,
      ): Effect.Effect<A, E> =>
        gate.withPermit(
          Effect.uninterruptible(
            Effect.acquireUseRelease(
              Effect.try({
                try: () =>
                  db.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN'),
                catch: failed,
              }),
              () => Effect.try({ try: body, catch: failed }),
              (_, exit) =>
                Exit.isSuccess(exit)
                  ? Effect.try({
                      try: () => db.exec('COMMIT'),
                      catch: failed,
                    }).pipe(
                      Effect.tapError(() =>
                        Effect.sync(() => db.exec('ROLLBACK')),
                      ),
                    )
                  : Effect.try({
                      try: () => db.exec('ROLLBACK'),
                      catch: failed,
                    }),
            ).pipe(
              Effect.tap(() =>
                mode === 'write'
                  ? Effect.gen(function* () {
                      yield* SubscriptionRef.set(
                        observedCommit,
                        currentCommit(),
                      );
                      yield* SubscriptionRef.update(level, (wake) => wake + 1);
                    })
                  : Effect.void,
              ),
            ),
          ),
        );
      const transact = <A>(body: () => A) =>
        transaction('write', body, writeFailed);
      const claim = db.prepare(`UPDATE event_sequence SET owner_id = ?
        WHERE aggregate_id = ? AND owner_id IS ? AND closed = 0`);
      const release = db.prepare(`UPDATE event_sequence SET owner_id = NULL
        WHERE aggregate_id IN (SELECT value FROM json_each(?)) AND owner_id = ?`);
      const readState = (
        ids: readonly AggregateId[],
      ): readonly AggregateState[] =>
        state
          .all(JSON.stringify(ids))
          .map((row) => AggregateStateSchema.parse(row));
      return {
        observedCommit,
        level,
        currentCommit: query(currentCommit),
        readAll: (fromCommit, throughCommit) =>
          query(() =>
            all
              .all(fromCommit, throughCommit ?? currentCommit())
              .map(decodeEvent),
          ),
        readListing: () =>
          query(() =>
            listing.all(JSON.stringify(LISTING_TYPES)).map(decodeEvent),
          ),
        readAggregate: (id, fromSeq) =>
          query(() => aggregate.all(id, fromSeq).map(decodeEvent)),
        aggregatesAfterCommit: (ids, afterCommit, throughCommit) =>
          query(() =>
            after
              .all(
                JSON.stringify(ids),
                afterCommit,
                throughCommit ?? currentCommit(),
              )
              .map(decodeEvent),
          ),
        aggregateState: (ids) => query(() => readState(ids)),
        readInputBatch: (ids, fromCommit, checkedIds = ids) =>
          transaction(
            'read',
            () => {
              const cursor = currentCommit();
              const events = inputRows
                .all(
                  inputTypes,
                  fromCommit,
                  cursor,
                  JSON.stringify(ids),
                  inputTypes,
                  fromCommit,
                  cursor,
                )
                .map(decodeEvent);
              const checked = new Set(checkedIds);
              for (const event of events) {
                for (const id of referencedAggregates(event)) checked.add(id);
              }
              const checkedAggregateIds = [...checked];
              return {
                cursor,
                events,
                checkedAggregateIds,
                state: readState(checkedAggregateIds),
              };
            },
            readFailed,
          ),
        acquireClaims: (ids) =>
          Effect.gen(function* () {
            if (ids.length === 0) return;
            const observed = yield* query(() => readState(ids));
            if (
              observed.length !== new Set(ids).size ||
              observed.some((row) => row.closed)
            ) {
              return yield* Effect.fail(
                writeFailed(new Error('A claim target is missing or closed.')),
              );
            }
            const owners = new Set(
              observed.flatMap((row) =>
                row.ownerId === null ? [] : [row.ownerId],
              ),
            );
            for (const owner of owners) {
              const verdict = yield* Effect.tryPromise({
                try: () => proveOwnerLiveness(ownerIdentity(owner)),
                catch: writeFailed,
              });
              if (verdict !== 'dead') {
                return yield* Effect.fail(
                  writeFailed(new Error(`Claim owner is ${verdict}: ${owner}`)),
                );
              }
            }
            yield* transact(() => {
              for (const row of observed) {
                if (
                  claim.run(identity.ownerId, row.aggregateId, row.ownerId)
                    .changes !== 1
                ) {
                  throw new Error(
                    `Claim changed before acquisition: ${row.aggregateId}`,
                  );
                }
              }
            });
          }),
        releaseClaims: (ids) =>
          ids.length === 0
            ? Effect.void
            : transact(() => {
                release.run(JSON.stringify(ids), identity.ownerId);
              }),
        appendAll: (input) =>
          Effect.gen(function* () {
            if (input.length === 0) return [];
            // Validate and serialize before BEGIN IMMEDIATE. The batch shares one clock.
            const prepared = yield* Effect.try({
              try: () =>
                input.map((inputDraft) => {
                  const draft = redactTraceDraft(
                    SessionEventDraftSchema.parse(inputDraft),
                  );
                  return { draft, payload: payloadOf(draft) };
                }),
              catch: writeFailed,
            });
            const at = yield* Clock.currentTimeMillis;
            return yield* transact(() =>
              prepared.map(({ draft, payload }): SessionEvent => {
                const seq = nextSeq.get(
                  draft.aggregateId,
                  identity.ownerId,
                )?.seq;
                if (typeof seq !== 'number') {
                  throw new Error(
                    `Aggregate is closed or not owned: ${draft.aggregateId}`,
                  );
                }
                const target = aggregateTarget(draft.aggregateId);
                if (
                  target.kind === 'stream' &&
                  (seq === 1) !== (draft.type === 'run.start')
                ) {
                  throw new Error(
                    `A stream must begin with exactly one run.start: ${draft.aggregateId}`,
                  );
                }
                if (
                  (draft.type === 'run.start' ||
                    draft.type === 'stream.removed') &&
                  target.kind !== 'stream'
                ) {
                  throw new Error(
                    `Stream lifecycle event has a non-stream target: ${draft.aggregateId}`,
                  );
                }
                // Capture the declared parent in this same transaction. A
                // reused logical id must not redirect the child to a new run.
                let parentStartCommit: number | undefined;
                if (
                  draft.type === 'run.start' &&
                  draft.parentStreamId != null
                ) {
                  const parent = readState([
                    qualifyAggregateId('stream', draft.parentStreamId),
                  ])[0];
                  if (!parent || parent.closed || parent.startCommit === null) {
                    throw new Error(
                      `Child creation requires an open parent: ${draft.parentStreamId}`,
                    );
                  }
                  parentStartCommit = parent.startCommit;
                }
                const commit = insertEvent.get(
                  draft.aggregateId,
                  seq,
                  `${draft.type}.1`,
                  identity.ownerId,
                  at,
                  parentStartCommit ?? null,
                  payload,
                  payload,
                  parentStartCommit ?? null,
                )?.commit;
                if (typeof commit !== 'number') {
                  throw new Error(
                    `No commit assigned for aggregate ${draft.aggregateId}`,
                  );
                }
                if (draft.type === 'stream.removed') {
                  // C5/C9: admission must hold every open dependent claim.
                  // This check shares the write transaction with the tombstone
                  // and recursive closure, so no claimant can change between them.
                  const unowned = unownedDependent.get(
                    draft.aggregateId,
                    identity.ownerId,
                  );
                  if (unowned) {
                    throw new Error(
                      `Deletion requires the dependent claim: ${unowned.aggregate_id}`,
                    );
                  }
                  closeDependents.run(draft.aggregateId);
                }
                return {
                  ...draft,
                  ...(parentStartCommit === undefined
                    ? {}
                    : { parentStartCommit }),
                  seq,
                  commit,
                  ownerId: identity.ownerId,
                  at,
                };
              }),
            );
          }),
      };
    }),
  );

/**
 * Serialize the validated draft before opening the transaction. Draft parsing
 * removes caller-supplied envelope fields; the type and aggregate key have
 * their own C1 columns. Child creation adds the database-owned parent commit
 * to this payload inside the creation transaction.
 */
function payloadOf(draft: SessionEventDraft): string {
  const { type, aggregateId, ...payload } = draft;
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
 * Read cursors use sqlite_sequence's committed high-water mark. Wake levels
 * are separate counters, since a claim-only change must wake readers even
 * when the event ordinal does not change.
 */
function configure(
  db: DatabaseSync,
  mode: 'persistent' | 'ephemeral',
): {
  readonly nextSeq: StatementSync;
  readonly insertEvent: StatementSync;
} {
  db.exec('PRAGMA busy_timeout = 5000');
  if (mode === 'persistent') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  verifyPragma(db, 'journal_mode', mode === 'persistent' ? 'wal' : 'memory');
  verifyPragma(db, 'foreign_keys', 1);
  db.exec(SCHEMA);
  return {
    nextSeq: db.prepare(NEXT_SEQ),
    insertEvent: db.prepare(INSERT_EVENT),
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
