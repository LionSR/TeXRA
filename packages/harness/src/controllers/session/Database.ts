/**
 * The persistence substrate (`2026-09-03-persistence-substrate-decision.md`,
 * reshaped by `2026-09-28-storage-v1-design.md`): the connection, its
 * transactions and busy retry, the run history's one write path, claims, the
 * aggregate lifecycle, deletion and collection, and the reads. One database
 * per session root (`WorkspaceRoots`), never a process singleton; an
 * ephemeral session runs the same schema in SQLite memory, and a failed file
 * open is an error, never the ephemeral mode.
 *
 * `storeSchema.ts` owns the DDL and the open sequence; `rowCodec.ts` every
 * stored shape (this module hands it drafts, gets events or refusals back,
 * and reads no payload field); `projections.ts` the projectors whose
 * operations run in the append transaction. This module owns the envelope:
 * the writer (C5, `ProcessIdentity`), the publish clock, and the `seq` and
 * `commit` ordinals, none of which a caller supplies.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient';
import * as SqlClient from 'effect/sql/SqlClient';
import * as Reactivity from 'effect/reactivity/Reactivity';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import {
  Clock,
  Duration,
  Scope,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Stream,
  SubscriptionRef,
} from 'effect';
import { z } from 'zod';
import { proveOwnerLiveness } from '@agent/storage/leaseOwnerLiveness';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessProbe } from '@platform/defaults/nodeProcesses';
import {
  CURRENT_VALUE_VERSION,
  edgesOf,
  isDisplaySessionEvent,
  RunIdSchema,
  OwnerIdSchema,
  ownerIdentity,
  aggregateTarget,
  referencedAggregates,
  type AggregateId,
  type RunParent,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import {
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
import { currentValues } from './currentValues';
import { localDatabasePath } from './localDatabasePath';
import {
  CATCH_UP,
  PROJECTION_INPUTS,
  PROJECTION_NAMES,
  PROJECTION_TABLE,
  isOwn,
  projectionStates as parseProjectionStates,
  isCurrent,
  PROJECTORS,
  AGGREGATE_LIST,
  READ_LISTING,
  READ_RUN_RECORDS,
  READ_STATE,
  displayUnion,
  DISPLAY_PAGE_END,
  DISPLAY_PAGE_ROWS,
  priorOf,
  type ProjectionName,
  type ProjectionOp,
} from './projections';
import {
  DISPLAY_READ_TYPES,
  EVENT_COLUMNS,
  EVENT_FROM,
  EVENT_JOINS,
  aggregateColumns,
  aggregateLists,
  aggregateOf,
  CURRENT_VALUE_KIND,
  decodeRow,
  encodeDraft,
  pluginKind,
  prepareEventDraft,
  rowReader,
  storeGate,
  type EncodedRow,
  type SqlRow,
} from './rowCodec';
import { isBusy, isDamaged, retryBusy } from './storeAside';
import { openStore, reclaimFreePages } from './storeSchema';
/** The database file of a session root, beside the stores it replaces. */
const SESSION_DATABASE_FILE = 'texra.db';
const CHANNEL = 'sessionDatabase';
/** A row or draft that contradicts the store's own protocol: a defect. */
const invariant = (message: string) => Effect.die(new Error(message));
/** One aggregate's surrogate, from its two columns. */
const AGGREGATE =
  '(SELECT id FROM event_sequence WHERE kind = ? AND logical_id = ?)';
/** First append claims the aggregate and mints its uid; later need the claim. */
const NEXT_SEQ = `
INSERT INTO event_sequence (kind, logical_id, uid, seq, owner_id)
VALUES (?, ?, ?, 1, ?)
ON CONFLICT(kind, logical_id) DO UPDATE SET seq = event_sequence.seq + 1
WHERE event_sequence.owner_id = excluded.owner_id
  AND event_sequence.closed_by IS NULL
RETURNING id, seq
`;
/** Insert one row and read back the ordinal SQLite assigned it. */
const INSERT_EVENT = `
INSERT INTO event (aggregate, seq, type, version, origin, at, data)
VALUES (?, ?, ?, ?, ?, ?, ?)
RETURNING "commit" AS "commit"
`;
/** A blob is stored once per store, whichever run wrote it first. */
const INSERT_BLOB = `INSERT INTO blob (digest, value) VALUES (?, ?)
  ON CONFLICT(digest) DO NOTHING`;
const INSERT_REF = 'INSERT INTO event_blob ("commit", digest) VALUES (?, ?)';
const UPSERT_KIND = `INSERT INTO stored_kind (type, version) VALUES (?, ?)
  ON CONFLICT(type) DO UPDATE
  SET version = max(stored_kind.version, excluded.version)`;
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
      const { sql, movedAside } = yield* openStore(
        SqliteClient.make({
          filename,
          disableWAL: mode === 'ephemeral',
          busyTimeout: '5 seconds',
        }),
        SqliteClient.make({ filename, readonly: true, disableWAL: true }),
        mode,
        path,
        filename,
      ).pipe(mapDatabaseFailure(openFailed));
      const level = yield* SubscriptionRef.make(0);
      const observedCommit = yield* SubscriptionRef.make(0);
      /** Commits only move forward: a poll that read the high-water mark
       *  before a local commit never sets it back. */
      const observe = (commit: number) =>
        SubscriptionRef.update(observedCommit, (c) => Math.max(c, commit));
      const highWater = "SELECT seq FROM sqlite_sequence WHERE name = 'event'";
      const commitFromRows = (rows: readonly SqlRow[]) => {
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
        read.pipe(retryBusy, mapDatabaseFailure(readFailed));
      /** One statement's rows, untyped until the caller parses them. */
      const exec = (statement: string, params?: readonly unknown[]) =>
        sql.unsafe<Record<string, unknown>>(statement, params);
      /** The first row a statement returns, if any. */
      const execOne = (statement: string, params?: readonly unknown[]) =>
        exec(statement, params).pipe(Effect.map((rows) => rows[0]));
      /** The store gate (`storeGate`), in the caller's transaction. */
      const gate = storeGate(exec);
      const decoded = rowReader(path);
      const decodedRows = (
        statement: string,
        params: readonly unknown[],
        whole = false,
      ) =>
        exec(statement, params).pipe(
          Effect.flatMap((rows) => decoded(rows, whole)),
        );
      const currentCommit = exec(highWater, []).pipe(
        Effect.map(commitFromRows),
      );
      yield* SubscriptionRef.set(
        observedCommit,
        yield* currentCommit.pipe(mapDatabaseFailure(openFailed)),
      );
      yield* gate.pipe(mapDatabaseFailure(openFailed));
      const dependents = `WITH RECURSIVE dependents(id) AS (
        SELECT id FROM event_sequence WHERE kind = ? AND logical_id = ?
        UNION ALL
        SELECT child.id FROM event_sequence child
        JOIN dependents parent ON child.parent_id = parent.id
      )`;
      const dependentKeys = `${dependents}
        SELECT kind, logical_id AS logicalId FROM event_sequence
        WHERE id IN (SELECT id FROM dependents) ORDER BY kind, logical_id`;
      const unownedDependent = `${dependents}
        SELECT kind, logical_id AS logicalId FROM event_sequence
        WHERE id IN (SELECT id FROM dependents)
          AND closed_by IS NULL AND owner_id IS NOT ?
        LIMIT 1
      `;
      const deletionRuns = `${dependents}
        SELECT logical_id AS runId FROM event_sequence
        WHERE id IN (SELECT id FROM dependents) AND kind = 'run'
        ORDER BY runId
      `;
      const closeDependents = `${dependents}
        UPDATE event_sequence SET closed_by = ?
        WHERE id IN (SELECT id FROM dependents)
      `;
      const dependentBlobs = `${dependents} SELECT DISTINCT r.digest FROM event_blob r
        JOIN event e ON e."commit" = r."commit" WHERE e.aggregate IN (SELECT id FROM dependents)`;
      /** Blob collection is by reachability: a digest no row references. */
      const collectBlobs = `DELETE FROM blob
        WHERE digest IN (SELECT value FROM json_each(?))
          AND NOT EXISTS (SELECT 1 FROM event_blob r WHERE r.digest = blob.digest)`;
      const all = `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM}
        WHERE e."commit" > ? AND e."commit" <= ?
        ORDER BY e."commit"`;
      // `readAll` narrowed by type, plus projected rows; the range binds once.
      const display = displayUnion(
        '"commit" > ? AND "commit" <= ?',
        '"commit"',
      );
      const aggregate = `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM}
        WHERE s.kind = ? AND s.logical_id = ? AND e.seq >= ?
        ORDER BY e.seq`;
      // Named: for an `IN` list the planner walks the aggregate's seq index.
      const typedRows = `SELECT ${EVENT_COLUMNS} FROM event e
        INDEXED BY event_aggregate_type ${EVENT_JOINS}
        WHERE s.kind = ? AND s.logical_id = ? AND e.seq >= ?
          AND e.type IN (SELECT value FROM json_each(?)) ORDER BY e.seq`;
      // A tombstone closes its run and stays its last row until collected.
      const pendingDeletions = `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM}
        WHERE e.type = 'run.removed' ORDER BY e."commit"`;
      // One aggregate's display rows, its projected rows among them.
      const displayAggregate = displayUnion(
        'kind = ? AND logicalId = ? AND seq >= ?',
        'seq',
      );
      // The latest `run.snapshot` of one open run, off `event_aggregate_type`.
      const runSnapshot = `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM}
        WHERE s.kind = ? AND s.logical_id = ? AND e.type = 'run.snapshot'
          AND s.closed_by IS NULL
        ORDER BY e.seq DESC LIMIT 1`;
      const inputTypes = JSON.stringify([
        ...PROJECTORS.listing.inputs,
        'usage',
      ]);
      // The listing's tail, plus every row of the resident aggregates.
      const inputRows = displayUnion(
        '"commit" > ? AND "commit" <= ?',
        '"commit"',
        `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM}
          WHERE e.aggregate IN (${AGGREGATE_LIST})
            AND e.type NOT IN (SELECT value FROM json_each(?))`,
      );
      const dataVersion = 'PRAGMA data_version';
      let version = (yield* execOne(dataVersion, []).pipe(
        mapDatabaseFailure(openFailed),
      ))?.data_version;
      // A failed read is logged and the poll backs off, 250 ms doubling to
      // 30 s over a streak, reset on the first healthy tick. The version is
      // checkpointed only once the commit behind it is read.
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
                yield* observe(commit);
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
      // `derive` writes only what the rows already imply (a projection's
      // catch-up): it takes the write lock but wakes no reader.
      const transactions = (mode: 'read' | 'write' | 'derive') =>
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
                    yield* observe(
                      commitFromRows(
                        yield* connection.executeUnprepared(
                          highWater,
                          [],
                          undefined,
                        ),
                      ),
                    );
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
      const run = {
        read: transactions('read'),
        write: transactions('write'),
        derive: transactions('derive'),
      };
      // Every body is database-only, so a busy one runs again whole.
      const transaction = <A, E, EBody>(
        mode: 'read' | 'write' | 'derive',
        body: Effect.Effect<A, EBody>,
        failed: (cause: unknown) => E,
      ) => run[mode](body).pipe(retryBusy, mapDatabaseFailure(failed));
      const transact = <A, E>(body: Effect.Effect<A, E>) =>
        transaction('write', body, writeFailed);
      const claim = `UPDATE event_sequence SET owner_id = ?
        WHERE kind = ? AND logical_id = ? AND owner_id IS ?
          AND closed_by IS NULL RETURNING id`;
      const release = `UPDATE event_sequence SET owner_id = NULL
        WHERE id IN (${AGGREGATE_LIST}) AND owner_id = ?`;
      const reparent = `UPDATE event_sequence SET parent_id = ${AGGREGATE}
        WHERE id = ? AND owner_id = ? AND closed_by IS NULL`;
      const cleanupLanes = new Map<AggregateId, PerKeyLane>();
      // The tombstone predicate: the aggregate closed by exactly this commit.
      const closedTombstone = `SELECT ${EVENT_COLUMNS},
        s.owner_id AS claimOwner FROM ${EVENT_FROM}
        WHERE s.kind = ? AND s.logical_id = ? AND e."commit" = ?
          AND s.closed_by = e."commit" AND e.type = 'run.removed'`;
      const claimCleanup = `UPDATE event_sequence SET owner_id = ?
        WHERE kind = ? AND logical_id = ? AND owner_id IS ? AND closed_by = ?
        RETURNING id`;
      const collectClosed = `DELETE FROM event_sequence
        WHERE kind = ? AND logical_id = ? AND owner_id = ? AND closed_by = ?
        RETURNING id`;
      const openDependent = `${dependents}
        SELECT id FROM event_sequence
        WHERE id IN (SELECT id FROM dependents)
          AND closed_by IS NULL LIMIT 1`;
      // An aggregate's plugin rows, for its arms' transition rules.
      const pluginRows = `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM}
        WHERE e.aggregate = ? AND e.type = 'plugin.fact' ORDER BY e.seq`;
      const readState = (ids: readonly AggregateId[]) =>
        Effect.gen(function* () {
          return (yield* exec(READ_STATE, aggregateLists(ids))).map((row) =>
            AggregateStateSchema.parse({
              ...row,
              aggregateId: aggregateOf(row.kind, row.logicalId),
              parentId:
                row.parentKind === null
                  ? null
                  : aggregateOf(row.parentKind, row.parentLogicalId),
            }),
          );
        });
      const readDependents = (id: AggregateId) =>
        Effect.gen(function* () {
          return yield* readState(
            (yield* exec(dependentKeys, aggregateColumns(id))).map((row) =>
              aggregateOf(row.kind, row.logicalId),
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
              ...aggregateColumns(row.aggregateId),
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
      const projectionStates = exec(
        'SELECT name, version, through_commit AS through FROM projection_state',
      ).pipe(Effect.map(parseProjectionStates));
      /** Every projection current in the caller's transaction. */
      const projectionsCurrent = Effect.gen(function* () {
        const states = yield* projectionStates;
        const top = yield* currentCommit;
        return PROJECTION_NAMES.every((name) =>
          isCurrent(name, states.get(name), top),
        );
      });
      const setProjectionState = (name: ProjectionName, through: number) =>
        exec(
          `INSERT INTO projection_state (name, version, through_commit)
           VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET
           version = excluded.version, through_commit = excluded.through_commit`,
          [name, PROJECTORS[name].version, through],
        );
      const applyOp = (op: ProjectionOp) => {
        switch (op.table) {
          case 'listing_entry':
            return op.commit === null
              ? exec(
                  `DELETE FROM listing_entry WHERE aggregate = ${AGGREGATE} AND key = ?`,
                  [...aggregateColumns(op.aggregate), op.key],
                )
              : exec(
                  `INSERT INTO listing_entry (aggregate, key, "commit")
                   VALUES (${AGGREGATE}, ?, ?) ON CONFLICT(aggregate, key)
                   DO UPDATE SET "commit" = excluded."commit"`,
                  [...aggregateColumns(op.aggregate), op.key, op.commit],
                );
          case 'projected_row':
            return exec(
              `INSERT INTO projected_row ("commit", type, data) VALUES (?, ?, ?)
               ON CONFLICT("commit", type) DO UPDATE SET data = excluded.data`,
              [op.commit, op.type, op.data],
            );
          case 'run_usage':
            return exec(
              `INSERT INTO run_usage (aggregate, "commit", usage)
               VALUES (${AGGREGATE}, ?, ?) ON CONFLICT(aggregate) DO UPDATE
               SET "commit" = excluded."commit", usage = excluded.usage`,
              [...aggregateColumns(op.aggregate), op.commit, op.data],
            );
          case 'run_model':
            return exec(
              `INSERT INTO run_model (aggregate, model, "commit")
               VALUES (${AGGREGATE}, ?, ?) ON CONFLICT(aggregate) DO UPDATE
               SET model = excluded.model, "commit" = excluded."commit"`,
              [...aggregateColumns(op.aggregate), op.model, op.commit],
            );
        }
      };
      /** Run the named projectors over decoded events, in the caller's
       *  transaction: a projector with a prior row reads it back first. */
      const project = (
        events: readonly SessionEvent[],
        names: readonly ProjectionName[],
      ) =>
        Effect.forEach(events, (event) =>
          Effect.forEach(names, (name) =>
            Effect.gen(function* () {
              if (!PROJECTION_INPUTS.get(name)?.has(event.type)) return;
              const projector = PROJECTORS[name];
              const prior =
                projector.prior === null
                  ? {}
                  : priorOf(
                      projector.prior,
                      yield* execOne(
                        `SELECT * FROM ${projector.prior} WHERE aggregate = ${AGGREGATE}`,
                        aggregateColumns(event.aggregateId),
                      ),
                    );
              for (const op of projector.project(event, prior))
                yield* applyOp(op);
            }),
          ),
        );
      /** A projection another build versioned is emptied and rebuilt, and
       *  one behind the high-water commit catches up, 1,000 rows per
       *  transaction. */
      const catchUpProjections = Effect.gen(function* () {
        let done = false;
        while (!done) {
          done = yield* transaction(
            'derive',
            Effect.gen(function* () {
              const current = yield* projectionStates;
              const top = yield* currentCommit;
              let all = true;
              for (const name of PROJECTION_NAMES) {
                const state = current.get(name);
                if (isCurrent(name, state, top)) continue;
                const own = isOwn(name, state);
                if (state !== undefined && !own)
                  yield* Effect.logInfo(
                    `Rebuilding the ${name} projection of ${path} (stored version ${state.version}, this build's ${PROJECTORS[name].version}).`,
                  ).pipe(withLogChannel(CHANNEL));
                if (!own) {
                  yield* exec(`DELETE FROM ${PROJECTION_TABLE[name]}`);
                  yield* exec(
                    'DELETE FROM projected_row WHERE type IN (SELECT value FROM json_each(?))',
                    [JSON.stringify(PROJECTORS[name].projects)],
                  );
                }
                const through = own ? (state?.through ?? 0) : 0;
                const rows =
                  through >= top
                    ? []
                    : yield* exec(CATCH_UP, [
                        JSON.stringify(PROJECTORS[name].inputs),
                        through,
                        top,
                      ]);
                yield* project(yield* decoded(rows, false), [name]);
                const reached =
                  rows.length < 1000 ? top : z.int().parse(rows.at(-1)?.commit);
                yield* setProjectionState(name, reached);
                all &&= reached >= top;
              }
              return all;
            }),
            readFailed,
          );
        }
      });
      /** A read of the projections, in the same read transaction as the
       *  check that they are current, so another build's rebuild can never
       *  hand it a half-built projection. When one is not current, it
       *  catches up and the read runs again. */
      const projected = <A, E>(read: Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          for (;;) {
            const result = yield* transaction(
              'read',
              Effect.gen(function* () {
                if (!(yield* projectionsCurrent)) return null;
                return { value: yield* read };
              }),
              readFailed,
            );
            if (result !== null) return result.value;
            yield* catchUpProjections;
          }
        });
      const appendRows = (
        prepared: readonly ReturnType<typeof prepareEventDraft>[],
        at: number,
      ) =>
        Effect.gen(function* () {
          const before = yield* currentCommit;
          const committed = yield* Effect.forEach(prepared, ({ draft, row }) =>
            appendRow(draft, row, at),
          );
          const kinds = new Map(
            prepared.flatMap(({ draft, row }) => [
              [row.type, row.version] as const,
              ...(draft.type === 'plugin.fact'
                ? [
                    [
                      pluginKind(draft.plugin, draft.kind),
                      draft.version,
                    ] as const,
                  ]
                : []),
            ]),
          );
          for (const [type, version] of kinds)
            yield* exec(UPSERT_KIND, [type, version]);
          // A projection of this build's version that has read every row
          // before the batch follows it; any other is left for its owner's
          // next read to catch up.
          const states = yield* projectionStates;
          const current = PROJECTION_NAMES.filter((name) => {
            const state = states.get(name);
            return state === undefined
              ? before === 0
              : isOwn(name, state) && state.through === before;
          });
          yield* project(committed, current);
          const through = yield* currentCommit;
          for (const name of current) yield* setProjectionState(name, through);
          return committed;
        });
      const appendRow = (
        draft: SessionEventDraft,
        row: EncodedRow,
        at: number,
      ) =>
        Effect.gen(function* () {
          const edges = edgesOf(draft);
          const target = aggregateTarget(draft.aggregateId);
          const columns = aggregateColumns(draft.aggregateId);
          if (edges.borrowsClaim) {
            // A plugin's own aggregate borrows its claim for this
            // transaction only.
            yield* exec(claim, [identity.ownerId, ...columns, null]);
          }
          if (edges.reparent != null) {
            // A new parent run must be open and held by this writer.
            const current = (yield* readState([draft.aggregateId]))[0];
            if (current?.parentId !== edges.reparent) {
              const parent = (yield* readState([edges.reparent]))[0];
              if (
                !parent ||
                parent.closed ||
                parent.ownerId !== identity.ownerId
              ) {
                return yield* invariant(
                  `A plugin aggregate's new parent must be open and owned here: ${edges.reparent}`,
                );
              }
            }
          }
          const next = yield* execOne(NEXT_SEQ, [
            ...columns,
            randomUUID(),
            identity.ownerId,
          ]);
          const seq = next?.seq;
          const aggregate = next?.id;
          if (typeof seq !== 'number' || typeof aggregate !== 'number') {
            return yield* refuseWriter(
              draft.aggregateId,
              'Sequence refused for an absent aggregate',
            );
          }
          if (draft.type === 'plugin.fact') {
            const name = `${draft.plugin}/${draft.kind}`;
            // Never over a corrupt row of the aggregate: it fails whole.
            const last = (yield* decoded(
              yield* exec(pluginRows, [aggregate]),
              true,
            )).findLast(
              (row) =>
                row.type === 'plugin.fact' &&
                row.plugin === draft.plugin &&
                row.kind === draft.kind,
            );
            const refused =
              target.kind === 'run' && draft.parent !== null
                ? `A run's own plugin fact names no parent: ${name}`
                : PLUGIN_ARMS.get(name)?.admits?.(
                    last?.type === 'plugin.fact' ? last : undefined,
                    draft,
                  );
            if (refused) return yield* invariant(refused);
          }
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
          if (edges.parent !== null) {
            const parentState = (yield* readState([edges.parent]))[0];
            if (
              !parentState ||
              parentState.closed ||
              parentState.startCommit === null
            ) {
              return yield* invariant(
                `Child creation requires an open parent: ${edges.parent}`,
              );
            }
            parent = {
              id: RunIdSchema.parse(aggregateTarget(edges.parent).id),
              uid: parentState.uid,
              callId:
                draft.type === 'run.start'
                  ? (draft.parent?.callId ?? null)
                  : null,
            };
          }
          // A tombstone names only run directories this lifecycle owns,
          // derived under the closure's permit and transaction, not a caller.
          const committedDraft = yield* Effect.gen(function* () {
            if (draft.type === 'run.removed') {
              const owned = yield* exec(deletionRuns, columns);
              return {
                ...draft,
                runIds: owned.map((owned) => RunIdSchema.parse(owned.runId)),
              };
            }
            if (draft.type === 'run.start') return { ...draft, parent };
            return draft;
          });
          const encoded =
            committedDraft === draft ? row : encodeDraft(committedDraft);
          const commit = (yield* execOne(INSERT_EVENT, [
            aggregate,
            seq,
            encoded.type,
            encoded.version,
            identity.ownerId,
            at,
            encoded.data,
          ]))?.commit;
          if (typeof commit !== 'number')
            return yield* invariant(
              `No commit assigned for aggregate ${draft.aggregateId}`,
            );
          for (const { digest, value } of encoded.blobs) {
            yield* exec(INSERT_BLOB, [digest, value]);
            yield* exec(INSERT_REF, [commit, digest]);
          }
          if (seq === 1) {
            yield* exec(
              'UPDATE event_sequence SET start_commit = ? WHERE id = ?',
              [commit, aggregate],
            );
          }
          if (edges.reparent !== undefined) {
            // A plugin's aggregate hangs under its `parent` run, so that
            // run's deletion collects it, or under none.
            const parentColumns =
              edges.reparent === null
                ? [null, null]
                : aggregateColumns(edges.reparent);
            yield* exec(reparent, [
              ...parentColumns,
              aggregate,
              identity.ownerId,
            ]);
          }
          if (edges.borrowsClaim) {
            yield* exec(
              'UPDATE event_sequence SET owner_id = NULL WHERE id = ? AND owner_id = ?',
              [aggregate, identity.ownerId],
            );
          }
          if (edges.closes) {
            // C5/C9: admission must hold every open dependent claim, in the
            // tombstone's transaction, so no claimant can change between.
            const unowned = yield* execOne(unownedDependent, [
              ...columns,
              identity.ownerId,
            ]);
            if (unowned)
              return yield* invariant(
                `Deletion requires the dependent claim: ${aggregateOf(unowned.kind, unowned.logicalId)}`,
              );
            yield* exec(closeDependents, [...columns, commit]);
          }
          return {
            ...committedDraft,
            seq,
            commit,
            origin: identity.ownerId,
            at,
          };
        });
      // Every append passes the store gate in its transaction: no build
      // writes beside rows it cannot read.
      const appendPrepared = (
        prepared: readonly ReturnType<typeof prepareEventDraft>[],
        at: number,
      ) => Effect.andThen(gate, appendRows(prepared, at));
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
        readDisplay: (fromCommit) => {
          // Pages are separate snapshots: a tombstone seen stays in view.
          const tombstones = new Map<number, SessionEvent>();
          return Stream.paginate(fromCommit, (from) =>
            projected(
              Effect.gen(function* () {
                const top = yield* currentCommit;
                const end = yield* top - from > DISPLAY_PAGE_ROWS
                  ? execOne(DISPLAY_PAGE_END, [from])
                  : Effect.undefined;
                const through = Math.min(top, Number(end?.through ?? top));
                const rows = yield* decodedRows(display, [
                  DISPLAY_READ_TYPES,
                  from,
                  through,
                ]);
                if (through < top)
                  for (const row of yield* decodedRows(pendingDeletions, []))
                    tombstones.set(row.commit, row);
                const read = new Set(rows.map((row) => row.commit));
                const kept = [...tombstones.values()].filter(
                  ({ commit }) =>
                    commit > from && commit <= through && !read.has(commit),
                );
                return [
                  [...rows, ...kept]
                    .sort((x, y) => x.commit - y.commit)
                    .filter(isDisplaySessionEvent),
                  through < top ? Option.some(through) : Option.none(),
                ] as const;
              }),
            ),
          );
        },
        readListing: () => projected(decodedRows(READ_LISTING, [])),
        readPendingDeletions: () => query(decodedRows(pendingDeletions, [])),
        readRunRecords: (id) =>
          projected(decodedRows(READ_RUN_RECORDS, aggregateColumns(id))),
        readRunSnapshot: (id) =>
          Effect.gen(function* () {
            const [event] = yield* query(
              decodedRows(runSnapshot, aggregateColumns(id), true),
            );
            if (event === undefined) return null;
            if (event.type !== 'run.snapshot')
              return yield* invariant('Invalid run snapshot row');
            return event;
          }),
        ...currentValues({
          exec,
          execOne,
          transact,
          query,
          level,
          gate,
          valueWritten: Effect.asVoid(
            exec(UPSERT_KIND, [CURRENT_VALUE_KIND, CURRENT_VALUE_VERSION]),
          ),
        }),
        readAggregate: (id, fromSeq, types) =>
          query(
            types === undefined
              ? decodedRows(aggregate, [...aggregateColumns(id), fromSeq], true)
              : decodedRows(
                  typedRows,
                  [...aggregateColumns(id), fromSeq, JSON.stringify(types)],
                  true,
                ),
          ),
        readDisplayAggregate: (id, fromSeq) =>
          projected(
            decodedRows(displayAggregate, [
              DISPLAY_READ_TYPES,
              ...aggregateColumns(id),
              fromSeq,
            ]).pipe(Effect.map((rows) => rows.filter(isDisplaySessionEvent))),
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
          projected(
            Effect.gen(function* () {
              const cursor = yield* currentCommit;
              const events = yield* decodedRows(inputRows, [
                inputTypes,
                ...aggregateLists(ids),
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
                // A store a newer build wrote is not this build's to drive.
                yield* gate;
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
            const columns = aggregateColumns(id);
            const observed = yield* query(
              Effect.gen(function* () {
                const row = yield* execOne(closedTombstone, [
                  ...columns,
                  tombstoneCommit,
                ]);
                if (!row)
                  return yield* invariant(
                    `Deletion record is no longer current: ${id}`,
                  );
                const tombstone = yield* Effect.fromResult(decodeRow(row));
                if (!('type' in tombstone) || tombstone.type !== 'run.removed')
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
                      ...columns,
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
                      if (yield* execOne(openDependent, columns))
                        return yield* invariant(
                          `Deletion has an open dependent: ${id}`,
                        );
                      const digests = (yield* exec(
                        dependentBlobs,
                        columns,
                      )).map((row) => row.digest);
                      if (
                        (yield* exec(collectClosed, [
                          ...columns,
                          identity.ownerId,
                          tombstoneCommit,
                        ])).length !== 1
                      ) {
                        return yield* invariant(
                          `Deletion claim or tombstone changed during cleanup: ${id}`,
                        );
                      }
                      if (digests.length > 0)
                        yield* exec(collectBlobs, [JSON.stringify(digests)]);
                    }),
                  );
                  yield* reclaimFreePages(sql, path);
                }),
              (_, exit) =>
                Exit.isFailure(exit)
                  ? transact(
                      Effect.gen(function* () {
                        yield* exec(claimCleanup, [
                          null,
                          ...columns,
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
                  yield* exec(release, [
                    ...aggregateLists(ids),
                    identity.ownerId,
                  ]);
                }),
              ),
        appendAll: (input) =>
          Effect.gen(function* () {
            if (input.length === 0) return [];
            // Validate and encode before BEGIN IMMEDIATE. The batch shares one clock.
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

/** Whether another process has the store open (its exclusive lock is
 *  refused), or the file is no SQLite store at all (NOTADB, CORRUPT). */
export const storeOpenElsewhere = (filename: string) =>
  Effect.scoped(
    Effect.flatMap(
      SqliteClient.make({ filename, disableWAL: true, busyTimeout: 0 }),
      (sql) =>
        Effect.andThen(
          sql.unsafe('PRAGMA locking_mode = EXCLUSIVE'),
          sql.unsafe('BEGIN EXCLUSIVE'),
        ),
    ),
  ).pipe(
    Effect.as('free' as const),
    Effect.catchIf(isBusy, () => Effect.succeed('open' as const)),
    Effect.catchCause((cause) =>
      isDamaged(cause)
        ? Effect.succeed('unreadable' as const)
        : Effect.failCause(cause),
    ),
    Effect.provide(Reactivity.layer),
  );

/**
 * The process's handle on the global storage root: one connection, schema and
 * `data_version` poll for every application record of that root, closed with
 * the entry's runtime. Building it creates the directory, the file and the
 * poll fiber, so an entry that must create none passes a refusing layer.
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

/** Interruption stays; a failure or a driver defect becomes `failed`'s. */
function mapDatabaseFailure<E>(failed: (cause: unknown) => E) {
  return <A, EOp, R>(
    operation: Effect.Effect<A, EOp, R>,
  ): Effect.Effect<A, E, R> =>
    operation.pipe(Effect.catchDefect(Effect.fail), Effect.mapError(failed));
}
