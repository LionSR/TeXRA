/**
 * The persistence substrate
 * (`.agents/docs/proposed/architecture/2026-09-03-persistence-substrate-decision.md`): the C1
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
 * Before its write transaction, this layer validates, redacts, and serializes
 * the complete batch (C3, C6). It also owns the envelope C1 gives its
 * own columns: the writer
 * (C5, from `ProcessIdentity`), the publish clock, and the `seq` and
 * `commit` ordinals, none of which a caller can supply.
 *
 * The official Node SQLite driver owns the scoped connection.
 * Effect SQL owns statement execution, connection reservation and transactions;
 * this layer owns the C1 schema, claims, validation and committed wake levels.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import * as Reactivity from 'effect/unstable/reactivity/Reactivity';
import {
  Cause,
  Clock,
  Scope,
  Effect,
  Exit,
  Layer,
  Result,
  Stream,
  SubscriptionRef,
} from 'effect';
import { z } from 'zod';
import { proveOwnerLiveness } from '@agent/storage/leaseOwnerLiveness';
import { parseJsonWith } from '@common/parsing/safeParseJson';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import {
  AggregateIdSchema,
  RunIdSchema,
  OwnerIdSchema,
  SessionEventDraftSchema,
  SessionEventSchema,
  ownerIdentity,
  aggregateTarget,
  aggregateId as qualifyAggregateId,
  listingTypeOf,
  referencedAggregates,
  type AggregateId,
  type RunId,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { redactTraceDraft } from '@shared/session/traceRedaction';
import {
  InputHistoryRecordSchema,
  INPUT_HISTORY_LIMIT,
  AggregateStateSchema,
  DeletionModeSchema,
  type DeletionMode,
  type AggregateState,
  Database,
  DatabaseOpenFailed,
  DatabaseClaimRefused,
  DatabaseReadFailed,
  DatabaseWriteFailed,
} from '@shared/session/database';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { localDatabasePath } from './localDatabasePath';
/** The database file of a session root, beside the stores it replaces. */
const SESSION_DATABASE_FILE = 'texra.db';
/**
 * Event history and bounded current application records.
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
CREATE TABLE IF NOT EXISTS input_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  value TEXT NOT NULL
) STRICT;

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
CREATE INDEX IF NOT EXISTS event_parent_start ON event(json_extract(data, '$.parentStartCommit')) WHERE type = 'run.start.1';
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
      const filename = yield* Effect.try({
        try: () => {
          if (mode === 'ephemeral') return ':memory:';
          mkdirSync(roots.storage, { recursive: true });
          return localDatabasePath(roots.storage, SESSION_DATABASE_FILE);
        },
        catch: openFailed,
      });
      const sql = yield* SqliteClient.make({
        filename,
        disableWAL: mode === 'ephemeral',
        busyTimeout: '5 seconds',
      }).pipe(mapDatabaseFailure(openFailed));
      yield* configure(sql, mode).pipe(mapDatabaseFailure(openFailed));
      const level = yield* SubscriptionRef.make(0);
      const observedCommit = yield* SubscriptionRef.make(0);
      const highWater = "SELECT seq FROM sqlite_sequence WHERE name = 'event'";
      const commitFromRows = (
        rows: readonly Readonly<Record<string, unknown>>[],
      ) => {
        const row = rows[0];
        return row === undefined ? 0 : z.int().nonnegative().parse(row.seq);
      };
      const writeFailed = (cause: unknown): DatabaseWriteFailed =>
        new DatabaseWriteFailed({ path, cause });
      const readFailed = (cause: unknown): DatabaseReadFailed =>
        new DatabaseReadFailed({ path, cause });
      const query = <A>(
        read: Effect.Effect<A, unknown>,
      ): Effect.Effect<A, DatabaseReadFailed> =>
        read.pipe(mapDatabaseFailure(readFailed));
      const currentCommit = sql
        .unsafe<Record<string, unknown>>(highWater, [])
        .pipe(Effect.map(commitFromRows));
      yield* SubscriptionRef.set(
        observedCommit,
        yield* currentCommit.pipe(mapDatabaseFailure(openFailed)),
      );
      const dependents = `WITH RECURSIVE dependents(aggregate_id) AS (
        SELECT aggregate_id FROM event_sequence WHERE aggregate_id = ?
        UNION ALL
        SELECT child.aggregate_id FROM event_sequence child
        JOIN dependents parent ON child.parent_id = parent.aggregate_id
      )`;
      const dependentIds = `${dependents}
        SELECT aggregate_id FROM dependents ORDER BY aggregate_id`;
      const unownedDependent = `${dependents}
        SELECT aggregate_id FROM event_sequence
        WHERE aggregate_id IN (SELECT aggregate_id FROM dependents)
          AND closed = 0 AND owner_id IS NOT ?
        LIMIT 1
      `;
      const deletionExecutions = `${dependents}
        SELECT json_extract(aggregate_id, '$[1]') AS executionId
        FROM event_sequence
        WHERE aggregate_id IN (SELECT aggregate_id FROM dependents)
          AND json_extract(aggregate_id, '$[0]') = 'execution'
        ORDER BY executionId
      `;
      const closeDependents = `${dependents}
        UPDATE event_sequence SET closed = 1
        WHERE aggregate_id IN (SELECT aggregate_id FROM dependents)
      `;
      const all = `SELECT ${EVENT_COLUMNS} FROM event e
        WHERE e."commit" > ? AND e."commit" <= ?
        ORDER BY e."commit"`;
      const executionRecords = `
        WITH own_stream AS (
          SELECT stream.aggregate_id AS id FROM event_sequence execution
          JOIN event_sequence stream ON stream.aggregate_id = execution.parent_id
          WHERE execution.aggregate_id = ? AND execution.closed = 0 AND stream.closed = 0
        ),
        latest AS (
          SELECT aggregate_id, type, MAX(seq) AS seq FROM event
          WHERE EXISTS (SELECT 1 FROM own_stream) AND (
            aggregate_id = ?
            OR (aggregate_id = (SELECT id FROM own_stream) AND type IN ('run.start.1', 'status.1', 'stream.removed.1'))
          )
          GROUP BY aggregate_id, type
        )
        SELECT ${EVENT_COLUMNS} FROM latest JOIN event e USING (aggregate_id,type,seq)
        ORDER BY "commit"
      `;
      const executionChildren = `
        WITH own_stream AS (SELECT parent_id AS id FROM event_sequence WHERE aggregate_id = ?),
        parent AS (SELECT "commit" AS start FROM event WHERE aggregate_id = (SELECT id FROM own_stream) AND type = 'run.start.1'),
        children AS (SELECT aggregate_id AS id, data FROM event INDEXED BY event_parent_start
          WHERE type = 'run.start.1' AND json_extract(data, '$.parentStartCommit') = (SELECT start FROM parent)),
        relevant AS (
          SELECT id, 'run.start.1' AS type FROM children
          UNION ALL SELECT id, 'stream.removed.1' FROM children
          UNION ALL SELECT json_array('execution',json_extract(data,'$.executionId')), 'execution.launchLabel.1' FROM children
          UNION ALL SELECT id, 'run.start.1' FROM own_stream
          UNION ALL SELECT id, 'stream.removed.1' FROM own_stream
        ),
        latest AS (SELECT e.aggregate_id,e.type,MAX(e.seq) AS seq FROM relevant r JOIN event e ON e.aggregate_id=r.id AND e.type=r.type GROUP BY e.aggregate_id,e.type)
        SELECT ${EVENT_COLUMNS} FROM latest JOIN event e USING (aggregate_id,type,seq) ORDER BY "commit"
      `;
      const aggregate = `SELECT ${EVENT_COLUMNS} FROM event e
        WHERE e.aggregate_id = ? AND e.seq >= ?
        ORDER BY e.seq`;
      const inputTypes = JSON.stringify([
        ...LISTING_TYPES,
        'approval.requested.1',
        'approval.resolved.1',
      ]);
      const inputRows = `
        SELECT ${EVENT_COLUMNS} FROM event e
        WHERE e.type IN (SELECT value FROM json_each(?))
          AND e."commit" > ? AND e."commit" <= ?
        UNION ALL
        SELECT ${EVENT_COLUMNS} FROM event e
        WHERE e.aggregate_id IN (SELECT value FROM json_each(?))
          AND e.type NOT IN (SELECT value FROM json_each(?))
          AND e."commit" > ? AND e."commit" <= ?
        ORDER BY "commit"
      `;
      const dataVersion = 'PRAGMA data_version';
      let version = (yield* sql
        .unsafe<Record<string, unknown>>(dataVersion, [])
        .pipe(mapDatabaseFailure(openFailed)))[0]?.data_version;
      yield* Effect.forkScoped(
        Stream.tick('250 millis').pipe(
          Stream.runForEach(() =>
            Effect.gen(function* () {
              const next = yield* query(
                Effect.gen(function* () {
                  return (yield* sql.unsafe<Record<string, unknown>>(
                    dataVersion,
                    [],
                  ))[0]?.data_version;
                }),
              );
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
      const transactions = (mode: 'read' | 'write') =>
        SqlClient.makeWithTransaction({
          transactionService: sql.transactionService,
          spanAttributes: [['db.system.name', 'sqlite']],
          acquireConnection: Effect.gen(function* () {
            const scope = yield* Scope.make();
            const connection = yield* Scope.provide(sql.reserve, scope);
            // Publish the committed write before the reserved connection is
            // released, including when interruption is pending after COMMIT.
            yield* Scope.addFinalizerExit(scope, (exit) =>
              mode === 'write' && Exit.isSuccess(exit)
                ? Effect.gen(function* () {
                    const committed = commitFromRows(
                      yield* connection.executeUnprepared(
                        highWater,
                        [],
                        undefined,
                      ),
                    );
                    yield* SubscriptionRef.set(observedCommit, committed);
                    yield* SubscriptionRef.update(level, (wake) => wake + 1);
                  }).pipe(Effect.orDie)
                : Effect.void,
            );
            return [scope, connection] as const;
          }),
          begin: (connection) =>
            connection.executeUnprepared(
              mode === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE',
              [],
              undefined,
            ),
          commit: (connection) =>
            connection.executeUnprepared('COMMIT', [], undefined).pipe(
              Effect.orDie,
              Effect.onError(() =>
                connection
                  .executeUnprepared('ROLLBACK', [], undefined)
                  .pipe(Effect.orDie),
              ),
            ),
          rollback: (connection) =>
            connection.executeUnprepared('ROLLBACK', [], undefined),
          savepoint: (connection, id) =>
            connection.executeUnprepared(
              `SAVEPOINT effect_sql_${id}`,
              [],
              undefined,
            ),
          rollbackSavepoint: (connection, id) =>
            connection.executeUnprepared(
              `ROLLBACK TO SAVEPOINT effect_sql_${id}`,
              [],
              undefined,
            ),
        });
      const readTransaction = transactions('read');
      const writeTransaction = transactions('write');
      const transaction = <A, E>(
        mode: 'read' | 'write',
        body: Effect.Effect<A, unknown>,
        failed: (cause: unknown) => E,
      ) =>
        (mode === 'read' ? readTransaction(body) : writeTransaction(body)).pipe(
          mapDatabaseFailure(failed),
        );
      const transact = <A>(body: Effect.Effect<A, unknown>) =>
        transaction('write', body, writeFailed);
      const historyRows = Effect.gen(function* () {
        return (yield* sql.unsafe<Record<string, unknown>>(
          'SELECT at, value FROM input_history ORDER BY id',
        )).map((row) => InputHistoryRecordSchema.parse(row));
      });
      const createExecution = `INSERT INTO event_sequence
        (aggregate_id, seq, owner_id, parent_id) VALUES (?, 0, ?, ?)`;
      const claim = `UPDATE event_sequence SET owner_id = ?
        WHERE aggregate_id = ? AND owner_id IS ? AND closed = 0 RETURNING aggregate_id`;
      const release = `UPDATE event_sequence SET owner_id = NULL
        WHERE aggregate_id IN (SELECT value FROM json_each(?)) AND owner_id = ?`;
      const latestInquiry = `SELECT ${EVENT_COLUMNS} FROM event e
        WHERE e.aggregate_id = ? AND e.type = 'inquiryThreadUpdated.1'
        ORDER BY e.seq DESC LIMIT 1`;
      const reparentInquiry = `UPDATE event_sequence SET parent_id = ?
        WHERE aggregate_id = ? AND owner_id = ? AND closed = 0`;
      const cleanupLanes = new Map<AggregateId, PerKeyLane>();
      const closedTombstone = `SELECT ${EVENT_COLUMNS},
        s.owner_id AS claimOwner FROM event e
        JOIN event_sequence s ON s.aggregate_id = e.aggregate_id
        WHERE e.aggregate_id = ? AND e."commit" = ?
          AND e.seq = s.seq AND s.closed = 1 AND e.type = 'stream.removed.1'`;
      const claimCleanup = `UPDATE event_sequence SET owner_id = ?
        WHERE aggregate_id = ? AND owner_id IS ? AND closed = 1
          AND EXISTS (SELECT 1 FROM event e
            WHERE e.aggregate_id = event_sequence.aggregate_id
              AND e.seq = event_sequence.seq AND e."commit" = ?
              AND e.type = 'stream.removed.1') RETURNING aggregate_id`;
      const collectClosed = `DELETE FROM event_sequence
        WHERE aggregate_id = ? AND owner_id = ? AND closed = 1
          AND EXISTS (SELECT 1 FROM event e
            WHERE e.aggregate_id = event_sequence.aggregate_id
              AND e.seq = event_sequence.seq AND e."commit" = ?
              AND e.type = 'stream.removed.1') RETURNING aggregate_id`;
      const openDependent = `${dependents}
        SELECT aggregate_id FROM event_sequence
        WHERE aggregate_id IN (SELECT aggregate_id FROM dependents)
          AND closed = 0 LIMIT 1`;
      const readState = (ids: readonly AggregateId[]) =>
        Effect.gen(function* () {
          return (yield* sql.unsafe<Record<string, unknown>>(READ_STATE, [
            JSON.stringify(ids),
          ])).map((row) => AggregateStateSchema.parse(row));
        });
      const readDependents = (id: AggregateId) =>
        Effect.gen(function* () {
          return yield* readState(
            (yield* sql.unsafe<Record<string, unknown>>(dependentIds, [
              id,
            ])).map((row) => AggregateIdSchema.parse(row.aggregate_id)),
          );
        });
      const proveReclaimable = (
        observed: readonly AggregateState[],
        mode?: DeletionMode,
      ) =>
        Effect.gen(function* () {
          const owners = new Set(
            observed.flatMap((row) =>
              row.ownerId === null || row.ownerId === identity.ownerId
                ? []
                : [row.ownerId],
            ),
          );
          for (const owner of owners) {
            const verdict = yield* Effect.tryPromise({
              try: () => proveOwnerLiveness(ownerIdentity(owner)),
              catch: writeFailed,
            });
            if (
              verdict !== 'dead' &&
              !(mode === 'single' && verdict === 'unprovable')
            ) {
              return yield* Effect.fail(
                writeFailed(
                  new DatabaseClaimRefused({ ownerId: owner, verdict }),
                ),
              );
            }
          }
        });
      const appendPrepared = (
        prepared: readonly ReturnType<typeof prepareEventDraft>[],
        at: number,
      ) =>
        Effect.forEach(prepared, ({ draft, payload }) =>
          Effect.gen(function* () {
            if (
              draft.type === 'desktop.projects.changed' ||
              draft.type === 'inquiry.recorded' ||
              draft.type === 'update.check.recorded'
            ) {
              // Profile-state writes own their aggregate only during this transaction.
              yield* sql.unsafe<Record<string, unknown>>(claim, [
                identity.ownerId,
                draft.aggregateId,
                null,
              ]);
            }
            if (draft.type === 'inquiryThreadUpdated') {
              // Inquiry writes borrow their claim for this transaction only.
              yield* sql.unsafe<Record<string, unknown>>(claim, [
                identity.ownerId,
                draft.aggregateId,
                null,
              ]);
              const previousRow = (yield* sql.unsafe<Record<string, unknown>>(
                latestInquiry,
                [draft.aggregateId],
              ))[0];
              const previous = previousRow
                ? decodeEvent(previousRow)
                : undefined;
              if (previous && previous.type !== 'inquiryThreadUpdated') {
                throw new Error(
                  `Invalid inquiry history: ${draft.aggregateId}`,
                );
              }
              const reopened =
                previous?.status === 'answered' && draft.status === 'open';
              if (previous && draft.turnCount < previous.turnCount) {
                throw new Error(
                  `Inquiry update must preserve turn order: ${draft.threadId}`,
                );
              }
              if (reopened && draft.turnCount <= previous.turnCount) {
                throw new Error(
                  `Inquiry reopen must advance the turn: ${draft.threadId}`,
                );
              }
              if (
                previous &&
                previous.parentStreamId !== draft.parentStreamId &&
                !reopened
              ) {
                throw new Error(
                  `Only an answered inquiry can change parents: ${draft.aggregateId}`,
                );
              }
              if (
                previous?.status === 'open' &&
                draft.status === 'open' &&
                previous.turnCount !== draft.turnCount
              ) {
                throw new Error(
                  `An open inquiry cannot start another turn: ${draft.aggregateId}`,
                );
              }
              if (
                previous?.status === 'dropped' &&
                draft.status !== 'dropped'
              ) {
                throw new Error(
                  `A dropped inquiry cannot reopen: ${draft.aggregateId}`,
                );
              }
              if ((!previous || reopened) && draft.parentStreamId !== null) {
                const parent = (yield* readState([
                  qualifyAggregateId('stream', draft.parentStreamId),
                ]))[0];
                if (
                  !parent ||
                  parent.closed ||
                  parent.ownerId !== identity.ownerId
                ) {
                  throw new Error(
                    `Inquiry opening requires an owned open parent: ${draft.parentStreamId}`,
                  );
                }
              }
            }
            const seq = (yield* sql.unsafe<Record<string, unknown>>(NEXT_SEQ, [
              draft.aggregateId,
              identity.ownerId,
            ]))[0]?.seq;
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
              (draft.type === 'run.start' || draft.type === 'stream.removed') &&
              target.kind !== 'stream'
            ) {
              throw new Error(
                `Stream lifecycle event has a non-stream target: ${draft.aggregateId}`,
              );
            }
            if (draft.type === 'run.start') {
              // The execution belongs to this stream from creation onward.
              // Its first own event will advance seq from zero to one.
              // An existing execution cannot be assigned to a second run.
              yield* sql.unsafe<Record<string, unknown>>(createExecution, [
                qualifyAggregateId('execution', draft.executionId),
                identity.ownerId,
                draft.aggregateId,
              ]);
            }
            // Capture the declared parent in this same transaction. A
            // reused logical id must not redirect the child to a new run.
            let parentStartCommit: number | undefined;
            let parentExecutionId: RunId | undefined;
            if (draft.type === 'run.start' && draft.parentStreamId != null) {
              const parent = (yield* readState([
                qualifyAggregateId('stream', draft.parentStreamId),
              ]))[0];
              if (!parent || parent.closed || parent.startCommit === null) {
                throw new Error(
                  `Child creation requires an open parent: ${draft.parentStreamId}`,
                );
              }
              parentStartCommit = parent.startCommit;
              const parentRow = (yield* sql.unsafe<Record<string, unknown>>(
                `SELECT ${EVENT_COLUMNS} FROM event e WHERE e.aggregate_id = ? AND e.seq = ?`,
                [qualifyAggregateId('stream', draft.parentStreamId), 1],
              ))[0];
              if (!parentRow) throw new Error('Parent creation row is missing');
              const parentCreation = decodeEvent(parentRow);
              if (parentCreation.type !== 'run.start')
                throw new Error('Parent creation row is missing');
              parentExecutionId = parentCreation.executionId;
            }
            // A tombstone names only execution directories owned by this
            // lifecycle. Derive the targets under the same write permit
            // and transaction as closure; no caller chooses cleanup paths.
            const committedDraft =
              draft.type === 'stream.removed'
                ? {
                    ...draft,
                    executionIds: (yield* sql.unsafe<Record<string, unknown>>(
                      deletionExecutions,
                      [draft.aggregateId],
                    )).map((row) => RunIdSchema.parse(row.executionId)),
                  }
                : {
                    ...draft,
                    ...(parentExecutionId === undefined
                      ? {}
                      : { parentExecutionId }),
                  };
            const committedPayload =
              draft.type === 'stream.removed' || parentExecutionId !== undefined
                ? payloadOf(committedDraft)
                : payload;
            const commit = (yield* sql.unsafe<Record<string, unknown>>(
              INSERT_EVENT,
              [
                draft.aggregateId,
                seq,
                `${draft.type}.1`,
                identity.ownerId,
                at,
                parentStartCommit ?? null,
                committedPayload,
                committedPayload,
                parentStartCommit ?? null,
              ],
            ))[0]?.commit;
            if (typeof commit !== 'number') {
              throw new Error(
                `No commit assigned for aggregate ${draft.aggregateId}`,
              );
            }
            if (
              draft.type === 'desktop.projects.changed' ||
              draft.type === 'inquiry.recorded' ||
              draft.type === 'update.check.recorded'
            ) {
              yield* sql.unsafe<Record<string, unknown>>(release, [
                JSON.stringify([draft.aggregateId]),
                identity.ownerId,
              ]);
            }
            if (draft.type === 'inquiryThreadUpdated') {
              yield* sql.unsafe<Record<string, unknown>>(reparentInquiry, [
                draft.parentStreamId === null
                  ? null
                  : qualifyAggregateId('stream', draft.parentStreamId),
                draft.aggregateId,
                identity.ownerId,
              ]);
              yield* sql.unsafe<Record<string, unknown>>(release, [
                JSON.stringify([draft.aggregateId]),
                identity.ownerId,
              ]);
            }
            if (draft.type === 'stream.removed') {
              // C5/C9: admission must hold every open dependent claim.
              // This check shares the write transaction with the tombstone
              // and recursive closure, so no claimant can change between them.
              const unowned = (yield* sql.unsafe<Record<string, unknown>>(
                unownedDependent,
                [draft.aggregateId, identity.ownerId],
              ))[0];
              if (unowned) {
                throw new Error(
                  `Deletion requires the dependent claim: ${unowned.aggregate_id}`,
                );
              }
              yield* sql.unsafe<Record<string, unknown>>(closeDependents, [
                draft.aggregateId,
              ]);
            }
            return {
              ...committedDraft,
              ...(parentStartCommit === undefined
                ? {}
                : { parentStartCommit, parentExecutionId }),
              seq,
              commit,
              ownerId: identity.ownerId,
              at,
            };
          }),
        );
      const inquiryRecordFromRow = (row: Readonly<Record<string, unknown>>) => {
        const event = decodeEvent(row);
        if (event.type !== 'inquiry.recorded')
          throw new Error('Invalid global inquiry record');
        return event.record;
      };
      const latestEventRow = (id: AggregateId) =>
        sql
          .unsafe<Record<string, unknown>>(
            `SELECT ${EVENT_COLUMNS} FROM event e WHERE e.aggregate_id = ? ORDER BY e.seq DESC LIMIT 1`,
            [id],
          )
          .pipe(Effect.map((rows) => rows[0]));
      const readUpdateCheck = (host: string) =>
        Effect.gen(function* () {
          const row = yield* latestEventRow(
            qualifyAggregateId('update-check', host),
          );
          if (row === undefined) return null;
          const event = decodeEvent(row);
          if (event.type !== 'update.check.recorded')
            throw new Error('Invalid update check record');
          return event.record;
        });
      const readInquiryRecord = (id: string) =>
        Effect.gen(function* () {
          const row = yield* latestEventRow(
            qualifyAggregateId('global-inquiry', id),
          );
          return row === undefined ? null : inquiryRecordFromRow(row);
        });
      return {
        observedCommit,
        level,
        currentCommit: query(currentCommit),
        readAll: (fromCommit, throughCommit) =>
          query(
            Effect.gen(function* () {
              return (yield* sql.unsafe<Record<string, unknown>>(all, [
                fromCommit,
                throughCommit ?? (yield* currentCommit),
              ])).map(decodeEvent);
            }),
          ),
        readListing: () =>
          query(
            Effect.gen(function* () {
              return (yield* sql.unsafe<Record<string, unknown>>(READ_LISTING, [
                JSON.stringify(LISTING_TYPES),
              ])).map(decodeEvent);
            }),
          ),
        readExecutionRecords: (id) =>
          query(
            Effect.gen(function* () {
              return (yield* sql.unsafe<Record<string, unknown>>(
                executionRecords,
                [id, id],
              )).map(decodeEvent);
            }),
          ),
        readExecutionChildren: (id) =>
          query(
            Effect.gen(function* () {
              return (yield* sql.unsafe<Record<string, unknown>>(
                executionChildren,
                [id],
              )).map(decodeEvent);
            }),
          ),
        readUpdateCheck: (host) => query(readUpdateCheck(host)),
        recordUpdateCheck: (host, change) =>
          transact(
            Effect.gen(function* () {
              const current = yield* readUpdateCheck(host);
              const record = {
                lastCheckedAt:
                  change.type === 'checked'
                    ? change.at
                    : (current?.lastCheckedAt ?? null),
                lastNotifiedVersion:
                  change.type === 'notified'
                    ? change.version
                    : (current?.lastNotifiedVersion ?? null),
              };
              const at = yield* Clock.currentTimeMillis;
              yield* appendPrepared(
                [
                  prepareEventDraft({
                    type: 'update.check.recorded',
                    aggregateId: qualifyAggregateId('update-check', host),
                    record,
                  }),
                ],
                at,
              );
            }),
          ),
        readInquiryRecord: (id) => query(readInquiryRecord(id)),
        listInquiryRecords: () =>
          query(
            Effect.gen(function* () {
              const rows = yield* sql.unsafe<Record<string, unknown>>(
                `SELECT ${EVENT_COLUMNS} FROM event e JOIN (SELECT aggregate_id, MAX(seq) AS seq FROM event WHERE type = 'inquiry.recorded.1' GROUP BY aggregate_id) latest USING (aggregate_id, seq) ORDER BY e."commit"`,
                [],
              );
              return rows.map(inquiryRecordFromRow);
            }),
          ),
        updateInquiryRecord: (id, change) =>
          transact(
            Effect.gen(function* () {
              const current = yield* readInquiryRecord(id);
              const result = change(current);
              if (Result.isSuccess(result) && result.success !== null) {
                if (result.success.threadId !== id)
                  throw new Error(
                    'An inquiry transition cannot change its thread identity.',
                  );
                const at = yield* Clock.currentTimeMillis;
                yield* appendPrepared(
                  [
                    prepareEventDraft({
                      type: 'inquiry.recorded',
                      aggregateId: qualifyAggregateId('global-inquiry', id),
                      record: result.success,
                    }),
                  ],
                  at,
                );
              }
              return result;
            }),
          ),
        readInputHistory: () => query(historyRows),
        appendInputHistory: ({ at, value }) =>
          transact(
            Effect.gen(function* () {
              const latest = (yield* sql.unsafe<Record<string, unknown>>(
                'SELECT value FROM input_history ORDER BY id DESC LIMIT 1',
              ))[0];
              if (latest?.value !== value) {
                yield* sql.unsafe(
                  'INSERT INTO input_history (at, value) VALUES (?, ?)',
                  [at, value],
                );
                yield* sql.unsafe(
                  'DELETE FROM input_history WHERE id NOT IN (SELECT id FROM input_history ORDER BY id DESC LIMIT ?)',
                  [INPUT_HISTORY_LIMIT],
                );
              }
            }),
          ),
        readDesktopProjects: (id) =>
          query(
            Effect.gen(function* () {
              const row = yield* latestEventRow(id);
              return row === undefined ? undefined : decodeEvent(row);
            }),
          ),
        readAggregate: (id, fromSeq) =>
          query(
            Effect.gen(function* () {
              return (yield* sql.unsafe<Record<string, unknown>>(aggregate, [
                id,
                fromSeq,
              ])).map(decodeEvent);
            }),
          ),
        aggregateState: (ids) => query(readState(ids)),
        readInputBatch: (ids, fromCommit, checkedIds = ids) =>
          transaction(
            'read',
            Effect.gen(function* () {
              const cursor = yield* currentCommit;
              const events = (yield* sql.unsafe<Record<string, unknown>>(
                inputRows,
                [
                  inputTypes,
                  fromCommit,
                  cursor,
                  JSON.stringify(ids),
                  inputTypes,
                  fromCommit,
                  cursor,
                ],
              )).map(decodeEvent);
              const checked = new Set(checkedIds);
              for (const event of events) {
                for (const id of referencedAggregates(event)) checked.add(id);
              }
              const checkedAggregateIds = [...checked];
              return {
                cursor,
                events,
                checkedAggregateIds,
                state: yield* readState(checkedAggregateIds),
              };
            }),
            readFailed,
          ),
        acquireClaims: (ids) =>
          Effect.gen(function* () {
            if (ids.length === 0) return [];
            const observed = yield* query(readState(ids));
            if (
              observed.length !== new Set(ids).size ||
              observed.some((row) => row.closed)
            ) {
              return yield* Effect.fail(
                writeFailed(new Error('A claim target is missing or closed.')),
              );
            }
            yield* proveReclaimable(observed);
            return yield* transact(
              Effect.gen(function* () {
                for (const row of observed) {
                  if (
                    (yield* sql.unsafe<Record<string, unknown>>(claim, [
                      identity.ownerId,
                      row.aggregateId,
                      row.ownerId,
                    ])).length !== 1
                  ) {
                    throw new Error(
                      `Claim changed before acquisition: ${row.aggregateId}`,
                    );
                  }
                }
                return observed
                  .filter((row) => row.ownerId !== identity.ownerId)
                  .map((row) => row.aggregateId);
              }),
            );
          }),
        removeStream: (id, mode, expectedStartCommit) =>
          Effect.gen(function* () {
            const deletionMode = yield* Effect.try({
              try: () => DeletionModeSchema.parse(mode),
              catch: writeFailed,
            });
            const observed = yield* transaction(
              'read',
              readDependents(id),
              readFailed,
            );
            if (observed.length === 0 || observed.some((row) => row.closed)) {
              return yield* Effect.fail(
                writeFailed(
                  new Error(`Deletion target is missing or closed: ${id}`),
                ),
              );
            }
            if (
              observed.find((row) => row.aggregateId === id)?.startCommit !==
              expectedStartCommit
            ) {
              return yield* Effect.fail(
                writeFailed(
                  new Error(`Deletion target changed since admission: ${id}`),
                ),
              );
            }
            yield* proveReclaimable(observed, deletionMode);
            const at = yield* Clock.currentTimeMillis;
            const removal = yield* Effect.try({
              try: () =>
                prepareEventDraft({ type: 'stream.removed', aggregateId: id }),
              catch: writeFailed,
            });
            return yield* transact(
              Effect.gen(function* () {
                const current = yield* readDependents(id);
                const observedById = new Map(
                  observed.map((row) => [row.aggregateId, row]),
                );
                if (
                  current.length !== observed.length ||
                  !current.every((row) => {
                    const before = observedById.get(row.aggregateId);
                    return (
                      before !== undefined &&
                      !row.closed &&
                      before.startCommit === row.startCommit &&
                      before.parentId === row.parentId
                    );
                  })
                ) {
                  throw new Error(
                    `Deletion dependents changed before acquisition: ${id}`,
                  );
                }
                for (const row of observed) {
                  if (
                    (yield* sql.unsafe<Record<string, unknown>>(claim, [
                      identity.ownerId,
                      row.aggregateId,
                      row.ownerId,
                    ])).length !== 1
                  ) {
                    throw new Error(
                      `Deletion claim changed before acquisition: ${row.aggregateId}`,
                    );
                  }
                }
                return yield* appendPrepared([removal], at);
              }),
            );
          }),
        collectDeletion: (id, tombstoneCommit, cleanup) =>
          Effect.gen(function* () {
            const observed = yield* query(
              Effect.gen(function* () {
                const row = (yield* sql.unsafe<Record<string, unknown>>(
                  closedTombstone,
                  [id, tombstoneCommit],
                ))[0];
                if (!row)
                  throw new Error(
                    `Deletion record is no longer current: ${id}`,
                  );
                const tombstone = decodeEvent(row);
                if (tombstone.type !== 'stream.removed') {
                  throw new Error(`Expected a deletion record: ${id}`);
                }
                return {
                  tombstone,
                  owner: OwnerIdSchema.nullable().parse(row.claimOwner),
                };
              }),
            );
            const owner = observed.owner;
            if (owner !== null && owner !== identity.ownerId) {
              const verdict = yield* Effect.tryPromise({
                try: () => proveOwnerLiveness(ownerIdentity(owner)),
                catch: writeFailed,
              });
              if (verdict !== 'dead') {
                return yield* Effect.fail(
                  writeFailed(
                    new Error(`Cleanup owner is ${verdict}: ${observed.owner}`),
                  ),
                );
              }
            }
            yield* Effect.acquireUseRelease(
              transact(
                Effect.gen(function* () {
                  if (
                    (yield* sql.unsafe<Record<string, unknown>>(claimCleanup, [
                      identity.ownerId,
                      id,
                      observed.owner,
                      tombstoneCommit,
                    ])).length !== 1
                  ) {
                    throw new Error(
                      `Deletion claim changed before cleanup: ${id}`,
                    );
                  }
                }),
              ),
              () =>
                Effect.gen(function* () {
                  // Filesystem promises cannot be undone by fiber interruption.
                  // Keep the local claim lane until that work has actually settled.
                  yield* cleanup(observed.tombstone.executionIds).pipe(
                    Effect.uninterruptible,
                  );
                  yield* transact(
                    Effect.gen(function* () {
                      if (
                        (yield* sql.unsafe<Record<string, unknown>>(
                          openDependent,
                          [id],
                        ))[0]
                      ) {
                        throw new Error(
                          `Deletion has an open dependent: ${id}`,
                        );
                      }
                      if (
                        (yield* sql.unsafe<Record<string, unknown>>(
                          collectClosed,
                          [id, identity.ownerId, tombstoneCommit],
                        )).length !== 1
                      ) {
                        throw new Error(
                          `Deletion claim or tombstone changed during cleanup: ${id}`,
                        );
                      }
                    }),
                  );
                }),
              (_, exit) =>
                Exit.isFailure(exit)
                  ? transact(
                      Effect.gen(function* () {
                        yield* sql.unsafe<Record<string, unknown>>(
                          claimCleanup,
                          [null, id, identity.ownerId, tombstoneCommit],
                        );
                      }),
                    )
                  : Effect.void,
            );
          }).pipe(withPerKeyLane(cleanupLanes, id)),
        releaseClaims: (ids) =>
          ids.length === 0
            ? Effect.void
            : transact(
                Effect.gen(function* () {
                  yield* sql.unsafe<Record<string, unknown>>(release, [
                    JSON.stringify(ids),
                    identity.ownerId,
                  ]);
                }),
              ),
        appendAll: (input) =>
          Effect.gen(function* () {
            if (input.length === 0) return [];
            // Validate and serialize before BEGIN IMMEDIATE. The batch shares one clock.
            const prepared = yield* Effect.try({
              try: () => input.map(prepareEventDraft),
              catch: writeFailed,
            });
            const at = yield* Clock.currentTimeMillis;
            return yield* transact(appendPrepared(prepared, at));
          }),
      };
    }),
  ).pipe(Layer.provide(Reactivity.layer));
function prepareEventDraft(input: SessionEventDraft) {
  const draft = redactTraceDraft(SessionEventDraftSchema.parse(input));
  return { draft, payload: payloadOf(draft) };
}
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
 * Bring the official driver's scoped connection to the state C1 requires.
 *
 * The official driver sets `PRAGMA busy_timeout` before enabling WAL; this
 * function verifies the resulting journal mode. That order is load-bearing
 * because `PRAGMA journal_mode = WAL` itself takes an exclusive lock: the
 * stage 0 spike killed a writer outright
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
const configure = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  mode: 'persistent' | 'ephemeral',
) {
  yield* sql.unsafe('PRAGMA foreign_keys = ON', []);
  yield* sql.unsafe('PRAGMA synchronous = NORMAL', []);
  yield* verifyPragma(
    sql,
    'journal_mode',
    mode === 'persistent' ? 'wal' : 'memory',
  );
  yield* verifyPragma(sql, 'foreign_keys', 1);
  // The official driver prepares one statement at a time. This fixed schema
  // contains only DDL statements, with no semicolons inside SQL literals.
  for (const statement of SCHEMA.split(';')
    .map((sql) => sql.trim())
    .filter(Boolean)) {
    yield* sql.unsafe(statement, []);
  }
});

const verifyPragma = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  pragma: string,
  expected: string | number,
) {
  const row = (yield* sql.unsafe<Record<string, unknown>>(
    `PRAGMA ${pragma}`,
    [],
  ))[0];
  const value = row?.[pragma];
  if (value !== expected) {
    return yield* Effect.fail(
      new Error(
        `PRAGMA ${pragma} is ${String(value)}, expected ${String(expected)}`,
      ),
    );
  }
});

/** Preserve interruption and each SQL/validation failure at the database boundary. */
function mapDatabaseFailure<E>(failed: (cause: unknown) => E) {
  return <A, R>(
    operation: Effect.Effect<A, unknown, R>,
  ): Effect.Effect<A, E, R> =>
    operation.pipe(
      Effect.catchCause((cause) =>
        Effect.failCause(
          Cause.fromReasons(
            cause.reasons.map((reason) =>
              reason._tag === 'Interrupt'
                ? reason
                : Cause.makeFailReason(
                    failed(
                      reason._tag === 'Fail' ? reason.error : reason.defect,
                    ),
                  ),
            ),
          ),
        ),
      ),
    );
}
