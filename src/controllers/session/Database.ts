/**
 * The persistence substrate
 * (`.agents/docs/archived/architecture/2026-09-03-persistence-substrate-decision.md`):
 * the C1 schema, the connection that owns it, and the C6 write path. One
 * database per session root, parameterized by `WorkspaceRoots` (section 7),
 * never a process singleton; Effect code reads its root from `Context`.
 *
 * Persistent sessions open one file; explicitly ephemeral sessions run the same
 * schema and transactions in SQLite memory. A failed file open is an error and
 * never selects the ephemeral mode.
 *
 * Before its write transaction, this layer validates and serializes the
 * complete batch (C6). It also owns the envelope C1 gives its own columns: the
 * writer (C5, from `ProcessIdentity`), the publish clock, and the `seq` and
 * `commit` ordinals, none of which a caller can supply.
 *
 * The official Node SQLite driver owns the scoped connection. Effect SQL owns
 * statement run, connection reservation and transactions; this layer owns the
 * C1 schema, claims, validation and committed wake levels.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import * as Reactivity from 'effect/unstable/reactivity/Reactivity';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';
import {
  Cause,
  Clock,
  Duration,
  Scope,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Result,
  Stream,
  SubscriptionRef,
} from 'effect';
import { z } from 'zod';
import { proveOwnerLiveness } from '@agent/storage/leaseOwnerLiveness';
import { parseJsonWith } from '@common/parsing/safeParseJson';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessProbe } from '@platform/defaults/nodeProcesses';
import {
  AggregateIdSchema,
  DISPLAY_EVENT_TYPES,
  isDisplaySessionEvent,
  RunIdSchema,
  OwnerIdSchema,
  SessionEventDraftSchema,
  SESSION_EVENT_FORMAT,
  SessionEventSchema,
  ownerIdentity,
  aggregateTarget,
  aggregateId as qualifyAggregateId,
  listingTypeOf,
  referencedAggregates,
  type AggregateId,
  type JsonValue,
  type RunParent,
  type SessionEvent,
  type SessionEventDraft,
  type StoredValue,
} from '@shared/schemas';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import {
  InputHistoryRecordSchema,
  INPUT_HISTORY_LIMIT,
  AggregateStateSchema,
  DeletionModeSchema,
  type DeletionMode,
  type AggregateState,
  Database,
  GlobalDatabase,
  DatabaseOpenFailed,
  DatabaseClaimRefused,
  DatabaseNotOwner,
  DatabaseReadFailed,
  DatabaseWriteFailed,
} from '@shared/session/database';
import { PLUGIN_ARMS } from '@tools/pluginArms';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { appStateChangeFeed } from './appStateChanges';
import { localDatabasePath } from './localDatabasePath';
import { USAGE_ROWS } from './usageProjection';
import {
  applySchema,
  assertStoreFormat,
  pragmaValue,
  retireStore,
} from './storeFormat';
import type { SqlError } from 'effect/unstable/sql/SqlError';
/** The database file of a session root, beside the stores it replaces. */
const SESSION_DATABASE_FILE = 'texra.db';
const CHANNEL = 'sessionDatabase';
/** A row or draft that contradicts the store's own protocol: a defect. */
const invariant = (message: string) => Effect.die(new Error(message));
const EVENT_COLUMNS = `e."commit" AS "commit", e.aggregate_id AS aggregateId,
  e.seq, e.type, e.origin AS origin, e.at, e.data`;
/** Listing arms of the present vocabulary; requests and follow-ups are sets. */
const LISTING_TYPES = SessionEventDraftSchema.options
  .map((schema) => schema.shape.type.value)
  .filter(
    (type) =>
      listingTypeOf({ type }) !== null &&
      type !== 'request.opened' &&
      type !== 'request.decided' &&
      type !== 'followup.queued' &&
      type !== 'followup.consumed',
  )
  .map((type) => `${type}.1`);
/** Latest per aggregate, type and family (`listingKeyOf`). */
const LISTING_GROUP = `aggregate_id, type, json_extract(data, '$.fact.key'),
  json_extract(data, '$.plugin'), json_extract(data, '$.kind')`;
const READ_LISTING = `
WITH latest AS (
  SELECT aggregate_id, type, MAX(seq) AS seq FROM event
  WHERE type IN (SELECT value FROM json_each(?))
  GROUP BY ${LISTING_GROUP}
), selected AS (
  SELECT ${EVENT_COLUMNS} FROM latest
  JOIN event e ON e.aggregate_id = latest.aggregate_id
    AND e.type = latest.type AND e.seq = latest.seq
  UNION ALL
  SELECT ${EVENT_COLUMNS} FROM event e
  WHERE e.type = 'request.opened.1' AND NOT EXISTS (
    SELECT 1 FROM event decided
    WHERE decided.aggregate_id = e.aggregate_id
      AND decided.type = 'request.decided.1'
      AND json_extract(decided.data, '$.requestId') = json_extract(e.data, '$.requestId')
  )
  UNION ALL
  SELECT ${EVENT_COLUMNS} FROM event e
  WHERE e.type = 'followup.queued.1' AND NOT EXISTS (
    SELECT 1 FROM event consumed
    WHERE consumed.aggregate_id = e.aggregate_id
      AND consumed.type = 'followup.consumed.1'
      AND json_extract(consumed.data, '$.followUpId') = json_extract(e.data, '$.followUpId')
  )
  UNION ALL
  SELECT ${EVENT_COLUMNS} FROM event e WHERE e.type = 'usage.1'
  UNION ALL
  SELECT * FROM ${USAGE_ROWS}
)
SELECT * FROM selected
ORDER BY "commit"
`;
const READ_STATE = `
SELECT s.aggregate_id AS aggregateId, s.uid, s.owner_id AS ownerId,
  s.closed, s.parent_id AS parentId,
  CASE WHEN json_extract(s.aggregate_id, '$[0]') = 'run'
    THEN (SELECT e."commit" FROM event e
          WHERE e.aggregate_id = s.aggregate_id AND e.seq = 1)
    ELSE NULL END AS startCommit
FROM event_sequence s
WHERE s.aggregate_id IN (SELECT value FROM json_each(?))
`;
const PayloadSchema = z.record(z.string(), z.unknown());
const StoredTypeSchema = z.string().endsWith('.1');
/**
 * Stored versions are checked before reconstructing the typed event. A row
 * that no longer matches the current vocabulary (there are no legacy
 * readers) fails naming itself: the aggregate, seq, and type a reader can
 * act on, not the union's whole discriminator list.
 */
function decodeEvent(row: Record<string, unknown>): SessionEvent {
  const payload = Result.getOrThrow(
    parseJsonWith(z.string().parse(row.data), PayloadSchema),
  );
  const type = StoredTypeSchema.parse(row.type).slice(0, -2);
  const parsed = SessionEventSchema.safeParse({
    ...payload,
    aggregateId: row.aggregateId,
    seq: row.seq,
    commit: row.commit,
    origin: row.origin,
    at: row.at,
    type,
  });
  const event = parsed.success ? parsed.data : undefined;
  // A plugin row's value is checked against its arm, if this build has one.
  const arm = PLUGIN_ARMS.get(
    event?.type === 'plugin.fact' ? `${event.plugin}/${event.kind}` : '',
  );
  const refused = arm?.schema.safeParse(payload.value).error;
  if (event !== undefined && refused === undefined) return event;
  const issue = (refused ?? parsed.error)?.issues[0];
  const at = [...(refused ? ['value'] : []), ...(issue?.path ?? [])].join('.');
  const reason =
    at === 'type'
      ? `unknown event type "${type}"`
      : `${type} at ${at || 'event'}: ${issue?.message}`;
  throw new Error(
    `Stored row ${String(row.aggregateId)} seq ${String(row.seq)} does not match the current event format (${reason})`,
  );
}
/** First append claims the aggregate and mints its uid; later need the claim. */
const NEXT_SEQ = `
INSERT INTO event_sequence (aggregate_id, uid, seq, owner_id)
VALUES (?, ?, 1, ?)
ON CONFLICT(aggregate_id) DO UPDATE SET seq = event_sequence.seq + 1
WHERE event_sequence.owner_id = excluded.owner_id AND event_sequence.closed = 0
RETURNING seq
`;
/** Insert one row and read back the ordinal SQLite assigned it. */
const INSERT_EVENT = `
INSERT INTO event (aggregate_id, seq, type, origin, at, data)
VALUES (?, ?, ?, ?, ?, ?)
RETURNING "commit" AS "commit"
`;
export const databaseLayer = (
  mode: 'persistent' | 'ephemeral',
): Layer.Layer<
  Database,
  DatabaseOpenFailed,
  WorkspaceRoots | ProcessIdentity | ProcessProbe
> =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const roots = yield* WorkspaceRoots;
      const identity = yield* ProcessIdentity;
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner;
      const liveness = (owner: string) =>
        proveOwnerLiveness(ownerIdentity(owner)).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(ChildProcessSpawner, spawner),
        );
      const path =
        mode === 'persistent'
          ? join(roots.storage, SESSION_DATABASE_FILE)
          : ':memory:';
      const openFailed = (cause: unknown): DatabaseOpenFailed =>
        new DatabaseOpenFailed({ path, cause });
      const filename =
        mode === 'ephemeral'
          ? ':memory:'
          : yield* localDatabasePath(roots.storage, SESSION_DATABASE_FILE).pipe(
              Effect.mapError(openFailed),
            );
      const sql = yield* SqliteClient.make({
        filename,
        disableWAL: mode === 'ephemeral',
        busyTimeout: '5 seconds',
      }).pipe(mapDatabaseFailure(openFailed));
      const movedAside = yield* configure(sql, mode, path, filename).pipe(
        mapDatabaseFailure(openFailed),
      );
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
      const query = <A, E>(
        read: Effect.Effect<A, E>,
      ): Effect.Effect<A, DatabaseReadFailed> =>
        read.pipe(mapDatabaseFailure(readFailed));
      /** One statement's rows, untyped until the caller parses them. */
      const exec = (statement: string, params?: readonly unknown[]) =>
        sql.unsafe<Record<string, unknown>>(statement, params);
      /** The first row a statement returns, if any. */
      const execOne = (statement: string, params?: readonly unknown[]) =>
        exec(statement, params).pipe(Effect.map((rows) => rows[0]));
      // Plugin kinds this build lacks: kept as written, left out of reads.
      const leftOut = new Set<string>();
      /** The rows a read statement returns, decoded as ledger events. */
      const decodedRows = (
        statement: string,
        params: readonly unknown[],
      ): Effect.Effect<SessionEvent[], SqlError> =>
        exec(statement, params).pipe(
          Effect.flatMap((rows) => {
            const fresh: string[] = [];
            const kept = rows.map(decodeEvent).filter((event) => {
              if (event.type !== 'plugin.fact') return true;
              const kind = `${event.plugin}/${event.kind}`;
              if (PLUGIN_ARMS.has(kind)) return true;
              if (!leftOut.has(kind)) fresh.push(kind);
              return !leftOut.add(kind);
            });
            return fresh.length === 0
              ? Effect.succeed(kept)
              : Effect.logWarning(
                  `${path} holds rows of plugin kinds this build does not have (${fresh.join(', ')}); they stay in the store and are left out of every read.`,
                ).pipe(withLogChannel(CHANNEL), Effect.as(kept));
          }),
        );
      const currentCommit = exec(highWater, []).pipe(
        Effect.map(commitFromRows),
      );
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
      const deletionRuns = `${dependents}
        SELECT json_extract(aggregate_id, '$[1]') AS runId
        FROM event_sequence
        WHERE aggregate_id IN (SELECT aggregate_id FROM dependents)
          AND json_extract(aggregate_id, '$[0]') = 'run'
        ORDER BY runId
      `;
      const closeDependents = `${dependents}
        UPDATE event_sequence SET closed = 1
        WHERE aggregate_id IN (SELECT aggregate_id FROM dependents)
      `;
      const all = `SELECT ${EVENT_COLUMNS} FROM event e
        WHERE e."commit" > ? AND e."commit" <= ?
        ORDER BY e."commit"`;
      // `readAll` narrowed by type, off `event_type_commit`, plus usage. The
      // range sits on the outer select, which SQLite pushes into each arm, so
      // it binds once: Node 22's `node:sqlite` cannot bind a numbered `?NNN`.
      const display = `SELECT * FROM (SELECT ${EVENT_COLUMNS} FROM event e
        WHERE e.type IN (SELECT value FROM json_each(?))
        UNION ALL SELECT * FROM ${USAGE_ROWS}) r
        WHERE r."commit" > ? AND r."commit" <= ? ORDER BY "commit"`;
      const displayTypes = JSON.stringify(
        DISPLAY_EVENT_TYPES.map((type) => `${type}.1`),
      );
      // Each type's latest listing row on one open run (creation, status and
      // tombstone beside its private records; no transcript row); closed: absent.
      const runRecords = `
        WITH latest AS (
          SELECT aggregate_id, type, MAX(seq) AS seq FROM event
          WHERE aggregate_id = ?
            AND EXISTS (SELECT 1 FROM event_sequence s
                        WHERE s.aggregate_id = event.aggregate_id AND s.closed = 0)
            AND type IN (SELECT value FROM json_each(?))
          GROUP BY ${LISTING_GROUP}
        )
        SELECT ${EVENT_COLUMNS} FROM latest JOIN event e USING (aggregate_id,type,seq)
        ORDER BY "commit"
      `;
      const aggregate = `SELECT ${EVENT_COLUMNS} FROM event e
        WHERE e.aggregate_id = ? AND e.seq >= ?
        ORDER BY e.seq`;
      // One aggregate's display rows, its projected `usage` rows among them.
      const displayAggregate = `SELECT * FROM (SELECT ${EVENT_COLUMNS} FROM event e
        WHERE e.type IN (SELECT value FROM json_each(?))
        UNION ALL SELECT * FROM ${USAGE_ROWS}) r
        WHERE r.aggregateId = ? AND r.seq >= ? ORDER BY seq`;
      // The latest `flow.snapshot` of one open run, off `event_agg_type_seq`.
      const runSnapshot = `SELECT ${EVENT_COLUMNS} FROM event e
        WHERE e.aggregate_id = ? AND e.type = 'flow.snapshot.1'
          AND EXISTS (SELECT 1 FROM event_sequence s
                      WHERE s.aggregate_id = e.aggregate_id AND s.closed = 0)
        ORDER BY e.seq DESC LIMIT 1`;
      const inputTypes = JSON.stringify([
        ...LISTING_TYPES,
        'request.opened.1',
        'request.decided.1',
        'followup.queued.1',
        'followup.consumed.1',
        'usage.1',
      ]);
      const inputRows = `SELECT * FROM (SELECT ${EVENT_COLUMNS} FROM event e
        WHERE e.type IN (SELECT value FROM json_each(?))
        UNION ALL SELECT * FROM ${USAGE_ROWS}
        UNION ALL SELECT ${EVENT_COLUMNS} FROM event e
        WHERE e.aggregate_id IN (SELECT value FROM json_each(?))
          AND e.type NOT IN (SELECT value FROM json_each(?))) r
        WHERE r."commit" > ? AND r."commit" <= ? ORDER BY "commit"`;
      const dataVersion = 'PRAGMA data_version';
      let version = (yield* execOne(dataVersion, []).pipe(
        mapDatabaseFailure(openFailed),
      ))?.data_version;
      // A failed read (a busy wait past the timeout, an I/O error) is logged
      // and the poll backs off, doubling from 250 ms to at most 30 s over a
      // streak of failures and resetting on the first healthy tick, so a
      // blip neither ends change notification nor slows it afterwards. The
      // version is checkpointed only once the commit behind it is read, so a
      // tick that fails between the two reads retries both.
      let failures = 0;
      yield* Effect.forkScoped(
        Stream.tick('250 millis').pipe(
          Stream.runForEach(() =>
            Effect.gen(function* () {
              const next = (yield* query(execOne(dataVersion, [])))
                ?.data_version;
              if (next !== version) {
                const commit = yield* query(currentCommit);
                version = next;
                yield* SubscriptionRef.set(observedCommit, commit);
                yield* SubscriptionRef.update(level, (wake) => wake + 1);
              }
              failures = 0;
            }).pipe(
              Effect.catch((error) => {
                failures += 1;
                return Effect.logWarning(
                  'The session database change poll failed; retrying.',
                ).pipe(
                  Effect.annotateLogs({ data: error }),
                  withLogChannel(CHANNEL),
                  Effect.andThen(
                    Effect.sleep(
                      Duration.millis(Math.min(250 * 2 ** failures, 30_000)),
                    ),
                  ),
                );
              }),
            ),
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
      const transaction = <A, E, EBody>(
        mode: 'read' | 'write',
        body: Effect.Effect<A, EBody>,
        failed: (cause: unknown) => E,
      ) =>
        (mode === 'read' ? readTransaction(body) : writeTransaction(body)).pipe(
          mapDatabaseFailure(failed),
        );
      const transact = <A, E>(body: Effect.Effect<A, E>) =>
        transaction('write', body, writeFailed);
      const historyRows = Effect.gen(function* () {
        return (yield* exec(
          'SELECT at, value FROM input_history ORDER BY id',
        )).map((row) => InputHistoryRecordSchema.parse(row));
      });
      const claim = `UPDATE event_sequence SET owner_id = ?
        WHERE aggregate_id = ? AND owner_id IS ? AND closed = 0 RETURNING aggregate_id`;
      const release = `UPDATE event_sequence SET owner_id = NULL
        WHERE aggregate_id IN (SELECT value FROM json_each(?)) AND owner_id = ?`;
      const latestInquiry = `SELECT ${EVENT_COLUMNS} FROM event e
        WHERE e.aggregate_id = ? AND e.type = 'inquiryThreadUpdated.1'
        ORDER BY e.seq DESC LIMIT 1`;
      const reparent = `UPDATE event_sequence SET parent_id = ?
        WHERE aggregate_id = ? AND owner_id = ? AND closed = 0`;
      const cleanupLanes = new Map<AggregateId, PerKeyLane>();
      const closedTombstone = `SELECT ${EVENT_COLUMNS},
        s.owner_id AS claimOwner FROM event e
        JOIN event_sequence s ON s.aggregate_id = e.aggregate_id
        WHERE e.aggregate_id = ? AND e."commit" = ?
          AND e.seq = s.seq AND s.closed = 1 AND e.type = 'run.removed.1'`;
      const claimCleanup = `UPDATE event_sequence SET owner_id = ?
        WHERE aggregate_id = ? AND owner_id IS ? AND closed = 1
          AND EXISTS (SELECT 1 FROM event e
            WHERE e.aggregate_id = event_sequence.aggregate_id
              AND e.seq = event_sequence.seq AND e."commit" = ?
              AND e.type = 'run.removed.1') RETURNING aggregate_id`;
      const collectClosed = `DELETE FROM event_sequence
        WHERE aggregate_id = ? AND owner_id = ? AND closed = 1
          AND EXISTS (SELECT 1 FROM event e
            WHERE e.aggregate_id = event_sequence.aggregate_id
              AND e.seq = event_sequence.seq AND e."commit" = ?
              AND e.type = 'run.removed.1') RETURNING aggregate_id`;
      const openDependent = `${dependents}
        SELECT aggregate_id FROM event_sequence
        WHERE aggregate_id IN (SELECT aggregate_id FROM dependents)
          AND closed = 0 LIMIT 1`;
      const readState = (ids: readonly AggregateId[]) =>
        Effect.gen(function* () {
          return (yield* exec(READ_STATE, [JSON.stringify(ids)])).map((row) =>
            AggregateStateSchema.parse(row),
          );
        });
      const readDependents = (id: AggregateId) =>
        Effect.gen(function* () {
          return yield* readState(
            (yield* exec(dependentIds, [id])).map((row) =>
              AggregateIdSchema.parse(row.aggregate_id),
            ),
          );
        });
      /** C5: a row whose claim moved or closed refused this writer. Read it
       *  in the refusing transaction so the typed refusal names the holder. */
      const refuseWriter = (id: AggregateId, absent: string) =>
        Effect.gen(function* () {
          const held = (yield* readState([id]))[0];
          if (held === undefined) return yield* invariant(`${absent}: ${id}`);
          const { ownerId, closed } = held;
          return yield* new DatabaseNotOwner({
            aggregateId: id,
            ownerId,
            closed,
          });
        });
      /** The refusal leaves typed (D6 b); the transaction wrapper carried it
       *  as the write failure's cause. */
      const typedRefusal = Effect.mapError((failure: DatabaseWriteFailed) =>
        failure.cause instanceof DatabaseNotOwner ? failure.cause : failure,
      );
      /** Claim every observed row in the caller's transaction, refusing the
       *  first whose claim moved since it was read. */
      const claimObserved = (rows: readonly AggregateState[], moved: string) =>
        Effect.gen(function* () {
          for (const row of rows) {
            const claimed = yield* exec(claim, [
              identity.ownerId,
              row.aggregateId,
              row.ownerId,
            ]);
            if (claimed.length !== 1) {
              return yield* refuseWriter(row.aggregateId, moved);
            }
          }
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
            const verdict = yield* liveness(owner);
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
      const appendRows = (
        prepared: readonly ReturnType<typeof prepareEventDraft>[],
        at: number,
      ) =>
        Effect.forEach(prepared, ({ draft, payload }) =>
          Effect.gen(function* () {
            if (borrowsClaim(draft)) {
              yield* exec(claim, [identity.ownerId, draft.aggregateId, null]);
            }
            if (draft.type === 'inquiryThreadUpdated') {
              // Inquiry writes borrow their claim for this transaction only.
              yield* exec(claim, [identity.ownerId, draft.aggregateId, null]);
              const previousRow = yield* execOne(latestInquiry, [
                draft.aggregateId,
              ]);
              const opens = validateInquiryTransition(
                previousRow ? decodeEvent(previousRow) : undefined,
                draft,
              );
              if (opens && draft.parentRunId !== null) {
                const parent = (yield* readState([
                  qualifyAggregateId('run', draft.parentRunId),
                ]))[0];
                if (
                  !parent ||
                  parent.closed ||
                  parent.ownerId !== identity.ownerId
                ) {
                  return yield* invariant(
                    `Inquiry opening requires an owned open parent: ${draft.parentRunId}`,
                  );
                }
              }
            }
            const seq = (yield* execOne(NEXT_SEQ, [
              draft.aggregateId,
              randomUUID(),
              identity.ownerId,
            ]))?.seq;
            if (typeof seq !== 'number') {
              return yield* refuseWriter(
                draft.aggregateId,
                'Sequence refused for an absent aggregate',
              );
            }
            const target = aggregateTarget(draft.aggregateId);
            // The seq-1 rule (decision 9): a run aggregate begins with exactly
            // one `run.start`, and nothing else ever lands at seq 1.
            if (
              target.kind === 'run' &&
              (seq === 1) !== (draft.type === 'run.start')
            ) {
              return yield* invariant(
                `A run must begin with exactly one run.start: ${draft.aggregateId}`,
              );
            }
            if (
              (draft.type === 'run.start' || draft.type === 'run.removed') &&
              target.kind !== 'run'
            ) {
              return yield* invariant(
                `Run lifecycle event has a non-run target: ${draft.aggregateId}`,
              );
            }
            // Stamp the declared parent's incarnation in this transaction: a
            // reused logical id must not redirect the child to a later one.
            let parent: RunParent | null = null;
            if (draft.type === 'run.start' && draft.parent !== null) {
              const parentState = (yield* readState([
                qualifyAggregateId('run', draft.parent.id),
              ]))[0];
              if (
                !parentState ||
                parentState.closed ||
                parentState.startCommit === null
              ) {
                return yield* invariant(
                  `Child creation requires an open parent: ${draft.parent.id}`,
                );
              }
              parent = { id: draft.parent.id, uid: parentState.uid };
            }
            // A tombstone names only run directories this lifecycle owns,
            // derived under the closure's permit and transaction, not a caller.
            const committedDraft = yield* Effect.gen(function* () {
              if (draft.type === 'run.removed') {
                const owned = yield* exec(deletionRuns, [draft.aggregateId]);
                return {
                  ...draft,
                  runIds: owned.map((row) => RunIdSchema.parse(row.runId)),
                };
              }
              if (draft.type === 'run.start') return { ...draft, parent };
              return draft;
            });
            const committedPayload =
              committedDraft === draft ? payload : payloadOf(committedDraft);
            const commit = (yield* execOne(INSERT_EVENT, [
              draft.aggregateId,
              seq,
              `${draft.type}.1`,
              identity.ownerId,
              at,
              committedPayload,
            ]))?.commit;
            if (typeof commit !== 'number')
              return yield* invariant(
                `No commit assigned for aggregate ${draft.aggregateId}`,
              );
            if (borrowsClaim(draft)) {
              yield* exec(release, [
                JSON.stringify([draft.aggregateId]),
                identity.ownerId,
              ]);
            }
            if (draft.type === 'workflow.script') {
              // The checkpoint outlives the workflow run's attempts but not the
              // run that invoked it: hang it under that run so its deletion
              // collects the journal instead of stranding rows no id reaches.
              yield* exec(reparent, [
                qualifyAggregateId('run', draft.parentRunId),
                draft.aggregateId,
                identity.ownerId,
              ]);
            }
            if (draft.type === 'inquiryThreadUpdated') {
              yield* exec(reparent, [
                draft.parentRunId === null
                  ? null
                  : qualifyAggregateId('run', draft.parentRunId),
                draft.aggregateId,
                identity.ownerId,
              ]);
              yield* exec(release, [
                JSON.stringify([draft.aggregateId]),
                identity.ownerId,
              ]);
            }
            if (draft.type === 'run.removed') {
              // C5/C9: admission must hold every open dependent claim.
              // This check shares the write transaction with the tombstone
              // and recursive closure, so no claimant can change between them.
              const unowned = yield* execOne(unownedDependent, [
                draft.aggregateId,
                identity.ownerId,
              ]);
              if (unowned)
                return yield* invariant(
                  `Deletion requires the dependent claim: ${unowned.aggregate_id}`,
                );
              yield* exec(closeDependents, [draft.aggregateId]);
            }
            return {
              ...committedDraft,
              seq,
              commit,
              origin: identity.ownerId,
              at,
            };
          }),
        );
      // Every append checks the store's stamp first: a build that no longer
      // matches it (another re-stamped it) fails instead of writing rows.
      const appendPrepared = (
        prepared: readonly ReturnType<typeof prepareEventDraft>[],
        at: number,
      ) =>
        Effect.andThen(assertStoreFormat(sql, path), appendRows(prepared, at));
      /** One row's stored value, refused when the row is not that family's:
       *  the schema ties each family to its aggregate kind. */
      const storedValue = <K extends StoredValue['key']>(
        row: Readonly<Record<string, unknown>>,
        key: K,
      ) => {
        const event = decodeEvent(row);
        if (event.type !== 'state.value.set' || event.state.key !== key)
          throw new Error(`Stored row is not a ${key} value`);
        return event as Extract<SessionEvent, { type: 'state.value.set' }> & {
          state: Extract<StoredValue, { key: K }>;
        };
      };
      const latestEventRow = (id: AggregateId) =>
        execOne(
          `SELECT ${EVENT_COLUMNS} FROM event e WHERE e.aggregate_id = ? ORDER BY e.seq DESC LIMIT 1`,
          [id],
        );
      /** The latest value of one `kind` aggregate, or `undefined` when none
       *  has been written. */
      const readStoredValue = <K extends StoredValue['key']>(
        kind: K,
        id: string,
      ) =>
        latestEventRow(qualifyAggregateId(kind, id)).pipe(
          Effect.map((row) => (row ? storedValue(row, kind).state : undefined)),
        );
      /** Appends `state` as the latest value of its `state.key` aggregate. */
      const appendStoredValue = (id: string, state: StoredValue) =>
        Effect.gen(function* () {
          const draft = {
            type: 'state.value.set',
            aggregateId: qualifyAggregateId(state.key, id),
            state,
          } as const;
          const at = yield* Clock.currentTimeMillis;
          yield* appendPrepared([prepareEventDraft(draft)], at);
        });
      const readAppStateKey = (key: string) =>
        readStoredValue('app-state', key).pipe(
          Effect.map((state): JsonValue | undefined =>
            state === undefined || state.value.kind === 'undefined'
              ? undefined
              : state.value.value,
          ),
        );
      const readUpdateCheck = (host: string) =>
        readStoredValue('update-check', host).pipe(
          Effect.map((state) => (state ? state.record : null)),
        );
      const readInquiryRecord = (id: string) =>
        readStoredValue('global-inquiry', id).pipe(
          Effect.map((state) => (state ? state.record : null)),
        );
      return {
        observedCommit,
        movedAside,
        level,
        currentCommit: query(currentCommit),
        readAll: (fromCommit, throughCommit) =>
          query(
            Effect.gen(function* () {
              return yield* decodedRows(all, [
                fromCommit,
                throughCommit ?? (yield* currentCommit),
              ]);
            }),
          ),
        readDisplay: (fromCommit) =>
          query(
            Effect.gen(function* () {
              const rows = yield* decodedRows(display, [
                displayTypes,
                fromCommit,
                yield* currentCommit,
              ]);
              return rows.filter(isDisplaySessionEvent);
            }),
          ),
        readListing: () =>
          query(decodedRows(READ_LISTING, [JSON.stringify(LISTING_TYPES)])),
        readRunRecords: (id) =>
          query(decodedRows(runRecords, [id, JSON.stringify(LISTING_TYPES)])),
        readRunSnapshot: (id) =>
          query(
            Effect.gen(function* () {
              const row = yield* execOne(runSnapshot, [id]);
              if (row === undefined) return null;
              const event = decodeEvent(row);
              if (event.type !== 'flow.snapshot')
                return yield* invariant('Invalid run snapshot row');
              return event;
            }),
          ),
        readAppStateKey: (key) => query(readAppStateKey(key)),
        appStateChanges: appStateChangeFeed(level, execOne),
        updateAppStateKey: (key, change) =>
          transact(
            Effect.gen(function* () {
              const result = change(yield* readAppStateKey(key));
              if (Result.isFailure(result)) return result;
              yield* appendStoredValue(key, {
                key: 'app-state',
                value: result.success,
              });
              return result;
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
              yield* appendStoredValue(host, { key: 'update-check', record });
            }),
          ),
        readInquiryRecord: (id) => query(readInquiryRecord(id)),
        listInquiryRecords: () =>
          query(
            Effect.gen(function* () {
              const rows = yield* exec(
                `SELECT ${EVENT_COLUMNS} FROM event e JOIN (SELECT aggregate_id, MAX(seq) AS seq FROM event WHERE type = 'state.value.set.1' AND json_extract(data, '$.state.key') = 'global-inquiry' GROUP BY aggregate_id) latest USING (aggregate_id, seq) ORDER BY e."commit"`,
                [],
              );
              return rows.map(
                (r) => storedValue(r, 'global-inquiry').state.record,
              );
            }),
          ),
        updateInquiryRecord: (id, change) =>
          transact(
            Effect.gen(function* () {
              const current = yield* readInquiryRecord(id);
              const result = change(current);
              if (Result.isSuccess(result) && result.success !== null) {
                if (result.success.threadId !== id)
                  return yield* invariant(
                    'An inquiry transition cannot change its thread identity.',
                  );
                yield* appendStoredValue(id, {
                  key: 'global-inquiry',
                  record: result.success,
                });
              }
              return result;
            }),
          ),
        readInputHistory: () => query(historyRows),
        appendInputHistory: ({ at, value }) =>
          transact(
            Effect.gen(function* () {
              const latest = yield* execOne(
                'SELECT value FROM input_history ORDER BY id DESC LIMIT 1',
              );
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
            latestEventRow(id).pipe(
              Effect.map((row) => (row ? decodeEvent(row) : undefined)),
            ),
          ),
        readAggregate: (id, fromSeq) =>
          query(decodedRows(aggregate, [id, fromSeq])),
        readDisplayAggregate: (id, fromSeq) =>
          query(
            decodedRows(displayAggregate, [displayTypes, id, fromSeq]).pipe(
              Effect.map((rows) => rows.filter(isDisplaySessionEvent)),
            ),
          ),
        aggregateState: (ids) => query(readState(ids)),
        claimOwner: (id) =>
          Effect.gen(function* () {
            const state = (yield* query(readState([id])))[0];
            // A tombstoned row keeps the owner that closed it, but what it
            // named is gone: nothing holds it, so it reads unclaimed.
            const owner =
              state?.closed === true ? null : (state?.ownerId ?? null);
            if (owner === null) return { ownerId: null, liveness: null };
            if (owner === identity.ownerId)
              return { ownerId: owner, liveness: 'self' as const };
            return {
              ownerId: owner,
              liveness: yield* liveness(owner),
            };
          }),
        readInputBatch: (ids, fromCommit, checkedIds = ids) =>
          transaction(
            'read',
            Effect.gen(function* () {
              const cursor = yield* currentCommit;
              const events = yield* decodedRows(inputRows, [
                inputTypes,
                JSON.stringify(ids),
                inputTypes,
                fromCommit,
                cursor,
              ]);
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
                yield* claimObserved(
                  observed,
                  'Claim changed before acquisition',
                );
                return observed
                  .filter((row) => row.ownerId !== identity.ownerId)
                  .map((row) => row.aggregateId);
              }),
            ).pipe(typedRefusal);
          }),
        prepareRunRemoval: (id, mode, expectedStartCommit) =>
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
            const removal = yield* Effect.try({
              try: () =>
                prepareEventDraft({ type: 'run.removed', aggregateId: id }),
              catch: writeFailed,
            });
            // The proofs above run off the publisher's fiber; this
            // transaction is the job it runs, and it rechecks what they read.
            return transact(
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
                  return yield* invariant(
                    `Deletion dependents changed before acquisition: ${id}`,
                  );
                }
                yield* claimObserved(
                  observed,
                  'Deletion claim changed before acquisition',
                );
                return yield* appendPrepared(
                  [removal],
                  yield* Clock.currentTimeMillis,
                );
              }),
            );
          }),
        collectDeletion: (id, tombstoneCommit, cleanup) =>
          Effect.gen(function* () {
            const observed = yield* query(
              Effect.gen(function* () {
                const row = yield* execOne(closedTombstone, [
                  id,
                  tombstoneCommit,
                ]);
                if (!row)
                  return yield* invariant(
                    `Deletion record is no longer current: ${id}`,
                  );
                const tombstone = decodeEvent(row);
                if (tombstone.type !== 'run.removed')
                  return yield* invariant(`Expected a deletion record: ${id}`);
                return {
                  tombstone,
                  owner: OwnerIdSchema.nullable().parse(row.claimOwner),
                };
              }),
            );
            const owner = observed.owner;
            if (owner !== null && owner !== identity.ownerId) {
              const verdict = yield* liveness(owner);
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
                    (yield* exec(claimCleanup, [
                      identity.ownerId,
                      id,
                      observed.owner,
                      tombstoneCommit,
                    ])).length !== 1
                  ) {
                    return yield* invariant(
                      `Deletion claim changed before cleanup: ${id}`,
                    );
                  }
                }),
              ),
              () =>
                Effect.gen(function* () {
                  // Filesystem promises cannot be undone by fiber interruption.
                  // Keep the local claim lane until that work has actually settled.
                  yield* cleanup(observed.tombstone.runIds).pipe(
                    Effect.uninterruptible,
                  );
                  yield* transact(
                    Effect.gen(function* () {
                      if (yield* execOne(openDependent, [id]))
                        return yield* invariant(
                          `Deletion has an open dependent: ${id}`,
                        );
                      if (
                        (yield* exec(collectClosed, [
                          id,
                          identity.ownerId,
                          tombstoneCommit,
                        ])).length !== 1
                      ) {
                        return yield* invariant(
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
                        yield* exec(claimCleanup, [
                          null,
                          id,
                          identity.ownerId,
                          tombstoneCommit,
                        ]);
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
                  yield* exec(release, [JSON.stringify(ids), identity.ownerId]);
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
            return yield* transact(appendPrepared(prepared, at)).pipe(
              typedRefusal,
            );
          }),
      };
    }),
  ).pipe(Layer.provide(Reactivity.layer));

/**
 * The process's handle on the global storage root: one connection, schema and
 * `data_version` poll for every application record of that root, built with
 * the runtime the entry hands it to and closed with it. Building it creates
 * the directory, the SQLite file and the poll fiber, so an entry that must
 * create none passes a refusing layer (`installProcessRuntime`'s option).
 */
export const globalDatabaseLayer = (
  storage: string,
): Layer.Layer<
  GlobalDatabase,
  DatabaseOpenFailed,
  ProcessIdentity | ProcessProbe
> =>
  Layer.effect(GlobalDatabase, Database).pipe(
    Layer.provide(
      databaseLayer('persistent').pipe(
        Layer.provide(Layer.succeed(WorkspaceRoots)({ storage })),
      ),
    ),
  );

function prepareEventDraft(input: SessionEventDraft) {
  const draft = SessionEventDraftSchema.parse(input);
  return { draft, payload: payloadOf(draft) };
}
/** A stored-value write holds its aggregate's claim only for the transaction
 *  that carries it; a run's claim, by contrast, its sequence row keeps. */
function borrowsClaim(draft: SessionEventDraft): boolean {
  return draft.type === 'state.value.set';
}
/**
 * Refuse an inquiry update its thread's latest row does not admit. Returns
 * whether the update opens the thread (its first row, or a reopen of an
 * answered one), which is when it needs an owned open parent.
 */
function validateInquiryTransition(
  previous: SessionEvent | undefined,
  draft: Extract<SessionEventDraft, { type: 'inquiryThreadUpdated' }>,
): boolean {
  if (previous === undefined) return true;
  if (previous.type !== 'inquiryThreadUpdated') {
    throw new Error(`Invalid inquiry history: ${draft.aggregateId}`);
  }
  const reopened = previous.status === 'answered' && draft.status === 'open';
  if (draft.turnCount < previous.turnCount) {
    throw new Error(
      `Inquiry update must preserve turn order: ${draft.threadId}`,
    );
  }
  if (reopened && draft.turnCount <= previous.turnCount) {
    throw new Error(`Inquiry reopen must advance the turn: ${draft.threadId}`);
  }
  if (previous.parentRunId !== draft.parentRunId && !reopened) {
    throw new Error(
      `Only an answered inquiry can change parents: ${draft.aggregateId}`,
    );
  }
  if (
    previous.status === 'open' &&
    draft.status === 'open' &&
    previous.turnCount !== draft.turnCount
  ) {
    throw new Error(
      `An open inquiry cannot start another turn: ${draft.aggregateId}`,
    );
  }
  if (previous.status === 'dropped' && draft.status !== 'dropped') {
    throw new Error(`A dropped inquiry cannot reopen: ${draft.aggregateId}`);
  }
  return reopened;
}
/** Serialize the validated draft before opening the transaction; the type
 *  and aggregate key have their own C1 columns. Child creation adds the
 *  parent's database-owned uid to this payload inside its transaction. */
function payloadOf(draft: {
  readonly type: string;
  readonly aggregateId: AggregateId;
}): string {
  const { type, aggregateId, ...payload } = draft;
  return JSON.stringify(payload);
}
/**
 * Bring the official driver's scoped connection to the state C1 requires.
 *
 * The official driver sets `PRAGMA busy_timeout` before enabling WAL; this
 * function verifies the resulting journal mode. That order is load-bearing
 * because `PRAGMA journal_mode = WAL` itself takes an exclusive lock: the
 * stage 0 spike killed a writer outright with `SQLITE_BUSY_RECOVERY` when a
 * second process opened the same database while the timeout was unset, and
 * setting it first removed the failure. With the timeout set, a second writer
 * blocks and then commits; at zero, the spike lost 26% to 55% of concurrent
 * appends to `SQLITE_BUSY`, so this is a correctness setting, not tuning.
 *
 * `synchronous = NORMAL` is the WAL-safe setting: the spike measured `FULL`
 * at 1.4x to 1.8x the median cost with far worse tails, and `kill -9`
 * mid-transaction left zero uncommitted rows and a clean `integrity_check` at
 * `NORMAL`: the C4 guarantee that a crash loses only the in-flight message.
 *
 * Read cursors use sqlite_sequence's committed high-water mark. Wake levels
 * are separate counters, since a claim-only change must wake readers even
 * when the event ordinal does not change.
 */
const configure = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  mode: 'persistent' | 'ephemeral',
  path: string,
  filename: string,
) {
  yield* sql.unsafe('PRAGMA foreign_keys = ON', []);
  yield* sql.unsafe('PRAGMA synchronous = NORMAL', []);
  yield* verifyPragma(
    sql,
    'journal_mode',
    mode === 'persistent' ? 'wal' : 'memory',
  );
  yield* verifyPragma(sql, 'foreign_keys', 1);
  // A store holds one vocabulary, stamped in SQLite's own slot and read before
  // this build's schema touches it: another format is refused or moved aside.
  const movedAside =
    (yield* pragmaValue(sql, 'user_version')) === SESSION_EVENT_FORMAT
      ? null
      : yield* retireStore(
          sql,
          path,
          filename,
          Effect.all(
            [
              sql.unsafe('DROP TABLE IF EXISTS event', []),
              sql.unsafe('DROP TABLE IF EXISTS event_sequence', []),
            ],
            { discard: true },
          ),
        );
  yield* applySchema(sql);
  return movedAside;
});

const verifyPragma = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
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

/** Preserve interruption and each SQL/validation failure at the database boundary. */
function mapDatabaseFailure<E>(failed: (cause: unknown) => E) {
  return <A, EOp, R>(
    operation: Effect.Effect<A, EOp, R>,
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
