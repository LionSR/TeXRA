/**
 * The persistence substrate: the connection, its transactions, the run
 * history's one write path, the aggregate lifecycle, deletion and
 * collection, and the reads. One database per session root
 * (`WorkspaceRoots`), never a process singleton; a project store is held
 * exclusively by the one process that opened it (`locking_mode =
 * EXCLUSIVE`), the global store is shared across processes; an ephemeral
 * session runs the same schema in SQLite memory, and a failed file open is an
 * error, never the ephemeral mode. `storeSchema.ts` owns the DDL and the open
 * sequence; `rowCodec.ts` every stored shape, by the fact kinds the process's
 * plugins contribute (this module reads no payload); `projections` the
 * projectors and their upkeep, run in this module's transactions. This
 * module owns the envelope: the publish clock, and the `seq` and `commit`
 * ordinals, none of which a caller supplies.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient';
import * as SqlClient from 'effect/sql/SqlClient';
import * as Reactivity from 'effect/reactivity/Reactivity';
import { isSqlError } from 'effect/sql/SqlError';
import {
  Clock,
  Context,
  Effect,
  type FileSystem,
  Layer,
  Option,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import { withLogChannel } from '@logger/effectLog';
import {
  CURRENT_VALUE_VERSION,
  edgesOf,
  isDisplayRow,
  RunIdSchema,
  aggregateTarget,
  type AggregateId,
  type DisplayRow,
  type RunParent,
  type SessionRow,
  type SessionRowDraft,
  factName,
} from '@shared/schemas';
import {
  NO_RUN_ROWS,
  RECORD_ROW_TYPES,
  recordAfter,
} from '@shared/session/runRowReads';
import { InPublisherJob } from '@shared/session/sessionEvents';
import {
  AggregateStateSchema,
  Database,
  GlobalDatabase,
  DatabaseOpenFailed,
  DatabaseAggregateClosed,
  DatabaseReadFailed,
  DatabaseWriteFailed,
  RunChanged,
  type SessionOpenError,
} from '@shared/session/database';
import { factKindsOf } from '@tools/plugins';
import { ToolRegistry, toolTable } from '@tools/toolTable';
import { currentValues, READ_RETRY } from './currentValues';
import { localDatabasePath } from './localDatabasePath';
import { LISTED_TYPES, projectionUpkeep, usageRows } from './projections';
import {
  EVENT_COLUMNS,
  EVENT_FROM,
  EVENT_JOINS,
  aggregateColumns,
  aggregateLists,
  aggregateOf,
  CURRENT_VALUE_KIND,
  encodeDraft,
  pluginKind,
  prepareEventDraft,
  storeGate,
  type EncodedRow,
  type SqlRow,
} from './rowCodec';
import {
  AGGREGATE,
  callCard,
  DISPLAY_READ_TYPES,
  PROJECTED_COLUMNS,
  PROJECTED_FROM,
  READ_LISTING,
  READ_RUN_RECORD,
  rowReader,
} from './rowReader';
import { isBusy, isDamaged, retryBusy } from './storeAside';
import { IN_MEMORY_STORE, openStore, reclaimFreePages } from './storeSchema';
/** The database file of a session root, beside the stores it replaces. */
export const SESSION_DATABASE_FILE = 'texra.db';
const CHANNEL = 'sessionDatabase';
/** A row or draft that contradicts the store's own protocol: a defect. */
const invariant = (message: string) => Effect.die(new Error(message));
/** The open transaction's mode, null outside one. */
const TxMode = Context.Reference<'read' | 'write' | null>(
  '@texra-ai/harness/session/TxMode',
  { defaultValue: () => null },
);
/** First append creates the aggregate and mints its uid; a closed one
 *  takes no more rows. */
const NEXT_SEQ = `
INSERT INTO event_sequence (kind, logical_id, uid, seq)
VALUES (?, ?, ?, 1)
ON CONFLICT(kind, logical_id) DO UPDATE SET seq = event_sequence.seq + 1
WHERE event_sequence.closed_by IS NULL
RETURNING id, seq
`;
/** Insert one row and read back the ordinal SQLite assigned it. */
const INSERT_EVENT = `
INSERT INTO event (aggregate, seq, type, version, at, data)
VALUES (?, ?, ?, ?, ?, ?)
RETURNING "commit" AS "commit"
`;
/** A blob is stored once per store, whichever run wrote it first. */
const INSERT_BLOB = `INSERT INTO blob (digest, value) VALUES (?, ?)
  ON CONFLICT(digest) DO NOTHING`;
const INSERT_REF = `INSERT INTO event_blob ("commit", digest, inline)
  VALUES (?, ?, ?)`;
const UPSERT_KIND = `INSERT INTO stored_kind (type, version) VALUES (?, ?)
  ON CONFLICT(type) DO UPDATE
  SET version = max(stored_kind.version, excluded.version)`;

/** Aggregates bound as two parallel `json_each(?)` arrays (`aggregateLists`),
 *  joined in this order: a free planner scans both arrays per aggregate. */
const AGGREGATE_LIST = `WITH k(key, value) AS MATERIALIZED
  (SELECT key, value FROM json_each(?))
  SELECT s.id FROM json_each(?) l CROSS JOIN k ON k.key = l.key
  CROSS JOIN event_sequence s ON s.kind = k.value AND s.logical_id = l.value`;
/** Aggregates' existence, the list bound as `AGGREGATE_LIST` binds. */
const READ_STATE = `
SELECT s.kind, s.logical_id AS logicalId, s.uid,
  s.closed_by IS NOT NULL AS closed, p.kind AS parentKind,
  p.logical_id AS parentLogicalId, s.start_commit AS startCommit
FROM event_sequence s LEFT JOIN event_sequence p ON p.id = s.parent_id
WHERE s.id IN (${AGGREGATE_LIST})
`;

/** The stored rows one display page covers. */
const DISPLAY_PAGE_ROWS = 2000;
/** The kinds a run's record reads, as the JSON list its read binds. */
const RECORD_TYPES = JSON.stringify(RECORD_ROW_TYPES);
/** A run's aggregate `logical_id` column as the `RunId` it is. */
const runIdOf = Schema.decodeUnknownSync(RunIdSchema);
/** The `event` table's autoincrement sequence: a non-negative integer. */
const EventSeqSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** Where a display page after a commit ends: at the last of the stored rows
 *  it covers. A page may end at any row, as each display row is shown from
 *  one stored row. No row: the page runs to the end. Counted in rows, so a
 *  stretch of collected commits bounds nothing. */
const DISPLAY_PAGE_END = `SELECT "commit" AS through FROM event
  WHERE "commit" > ? ORDER BY "commit" LIMIT 1 OFFSET ${DISPLAY_PAGE_ROWS - 1}`;

/**
 * The one display union: the `event` rows of the types bound first, every
 * projected row, and an optional further arm, narrowed by `where` over the
 * union's columns (`"commit"`, `kind`, `logicalId`, `seq`), which SQLite
 * pushes into each arm, so a range binds once.
 */
const displayUnion = (where: string, order: string, arm?: string) =>
  `SELECT * FROM (
    SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM}
      WHERE e.type IN (SELECT value FROM json_each(?))
    UNION ALL SELECT ${PROJECTED_COLUMNS} FROM ${PROJECTED_FROM}
    ${arm === undefined ? '' : `UNION ALL ${arm}`}
  ) WHERE ${where} ORDER BY ${order}`;
/** What a display read shows of one decoded row: a display row itself, a
 *  call row's tool card, nothing of any other private row. */
const shown = (row: SessionRow): readonly DisplayRow[] =>
  isDisplayRow(row) ? [row] : callCard(row);
/** A committed batch's display rows, as a display read of its commits
 *  returns them: what each row shows, then the `usage` row a priced one
 *  projects. */
const displayRows = (rows: readonly SessionRow[]) =>
  rows
    .flatMap((row) => [...shown(row), ...usageRows(row)])
    .filter(isDisplayRow);

/** How a store is opened: a project store, created if absent
 *  (`persistent`) or only opened (`existing`), is held exclusively by this
 *  process for the connection's life; the `global` store is shared across
 *  processes and polled for their commits; `ephemeral` runs in memory. */
export type StoreMode = 'persistent' | 'existing' | 'ephemeral' | 'global';

/** Why a project store did not open: another process holds it. */
export const STORE_HELD_MESSAGE =
  'Another TeXRA process holds this project; close it there first.';

/** Whether a session failed to open because another process holds its
 *  project store: what a service that replaces a retiring one waits out. */
export const storeHeld = (error: SessionOpenError): boolean =>
  error._tag === 'DatabaseOpenFailed' &&
  error.cause instanceof Error &&
  error.cause.message === STORE_HELD_MESSAGE;

export const databaseLayer = (
  mode: StoreMode,
): Layer.Layer<
  Database,
  DatabaseOpenFailed,
  WorkspaceRoots | FileSystem.FileSystem | ChildProcessSpawner | ToolRegistry
> =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const roots = yield* WorkspaceRoots;
      const path =
        mode === 'ephemeral'
          ? IN_MEMORY_STORE
          : join(roots.storage, SESSION_DATABASE_FILE);
      const openFailed = (cause: unknown): DatabaseOpenFailed =>
        new DatabaseOpenFailed({ path, cause });
      const create = mode !== 'existing';
      const exclusive = mode === 'persistent' || mode === 'existing';
      const filename =
        mode === 'ephemeral'
          ? IN_MEMORY_STORE
          : yield* localDatabasePath(
              roots.storage,
              SESSION_DATABASE_FILE,
              create,
            ).pipe(Effect.mapError(openFailed));
      // A project store never waits for a lock: its one holder is this
      // process, and a lock another holds refuses the open at once, on the
      // fiber, never by blocking the thread in SQLite.
      const busyTimeout = exclusive ? 0 : '5 seconds';
      const { sql, movedAside } = yield* openStore(
        SqliteClient.make({
          filename: create
            ? filename
            : `file:${filename.replaceAll(/[%?#]/g, encodeURIComponent)}?mode=rw`,
          disableWAL: mode === 'ephemeral',
          busyTimeout,
        }),
        SqliteClient.make({
          filename,
          readonly: true,
          disableWAL: true,
          busyTimeout,
        }),
        path,
        filename,
      ).pipe(
        Effect.catchIf(isBusy, () =>
          Effect.fail(openFailed(new Error(STORE_HELD_MESSAGE))),
        ),
        mapDatabaseFailure(openFailed),
      );
      if (exclusive)
        // Taken once and kept for the connection's life: in WAL mode an
        // exclusive holder keeps the wal-index in its own memory, so no
        // other process reads or writes the store until it closes.
        yield* Effect.all([
          sql.unsafe('PRAGMA locking_mode = EXCLUSIVE'),
          sql.unsafe('BEGIN IMMEDIATE'),
          sql.unsafe('COMMIT'),
        ]).pipe(
          Effect.catchIf(isBusy, () =>
            Effect.fail(openFailed(new Error(STORE_HELD_MESSAGE))),
          ),
          mapDatabaseFailure(openFailed),
        );
      /** Moved by every value write, this process's or (on the global
       *  store, by the poll) another's: what `values.changes` wakes on. */
      const valuesWritten = yield* SubscriptionRef.make(0);
      const highWater = "SELECT seq FROM sqlite_sequence WHERE name = 'event'";
      const commitFromRows = ([row]: readonly SqlRow[]) =>
        row === undefined
          ? 0
          : Schema.decodeUnknownSync(EventSeqSchema)(row.seq);
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
        exec(statement, params).pipe(Effect.map((rows) => rows.at(0)));
      /** The store gate (`storeGate`), run at open. A project store's one
       *  writer is this process, so what it holds cannot change under it;
       *  the global store's other processes can be newer builds, so there
       *  the gate runs again in every value write (`transact`). */
      const factKinds = factKindsOf((yield* ToolRegistry).entries.values());
      const gate = storeGate(exec, factKinds);
      const reader = rowReader(path, factKinds, exec);
      const decodedRows = (
        statement: string,
        params: readonly unknown[],
        whole = false,
      ) =>
        exec(statement, params).pipe(
          Effect.flatMap((rows) => reader.read(rows, whole)),
        );
      const currentCommit = exec(highWater, []).pipe(
        Effect.map(commitFromRows),
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
      // The display types in a commit range, plus projected rows.
      const display = displayUnion(
        '"commit" > ? AND "commit" <= ?',
        '"commit"',
      );
      // Named: for an `IN` list the planner walks the aggregate's seq index.
      const typedRows = `SELECT ${EVENT_COLUMNS} FROM event e
        INDEXED BY event_aggregate_type ${EVENT_JOINS}
        WHERE s.kind = ? AND s.logical_id = ? AND e.seq BETWEEN ? AND ?
          AND e.type IN (SELECT value FROM json_each(?)) ORDER BY e.seq`;
      // A deletion marker closes its run and stays its last row until collected.
      const pendingDeletions = `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM}
        WHERE e.type = 'run.removed' ORDER BY e."commit"`;
      // One aggregate's display rows, its projected rows among them.
      const displayAggregate = displayUnion(
        'kind = ? AND logicalId = ? AND seq >= ?',
        'seq',
      );
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
      // Only the global store has other writers to watch for, and it holds
      // values alone. A failed read logs and retries.
      if (mode === 'global')
        yield* Effect.forkScoped(
          Stream.tick('250 millis').pipe(
            Stream.runForEach(
              Effect.fnUntraced(
                function* () {
                  const next = (yield* query(execOne(dataVersion, [])))
                    ?.data_version;
                  if (next !== version) {
                    version = next;
                    yield* SubscriptionRef.update(
                      valuesWritten,
                      (wake) => wake + 1,
                    );
                  }
                },
                Effect.tapError((error) =>
                  Effect.logWarning(
                    'The session database change poll failed; retrying.',
                  ).pipe(
                    Effect.annotateLogs({ data: error }),
                    withLogChannel(CHANNEL),
                  ),
                ),
                Effect.retry(READ_RETRY),
                Effect.orDie,
              ),
            ),
          ),
        );
      // One transaction wrapper, so a nested call of any mode finds the
      // savepoint semaphore its outermost opened; that one's mode is `TxMode`.
      const withTransaction = SqlClient.makeWithTransaction({
        transactionService: sql.transactionService,
        spanAttributes: [['db.system.name', 'sqlite']],
        acquireConnection: (restore) => restore(sql.reserve),
        begin: (connection) =>
          Effect.flatMap(TxMode, (mode) =>
            connection.executeUnprepared(
              mode === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE',
              [],
              undefined,
            ),
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
      // Every body is database-only. A busy lock (the global store's other
      // writers) runs the body again whole. In a caller's transaction a body
      // is a savepoint.
      const own = <A, E>(txMode: 'read' | 'write', body: Effect.Effect<A, E>) =>
        Effect.flatMap(TxMode, (outer) =>
          outer !== null
            ? withTransaction(body)
            : retryBusy(withTransaction(body)).pipe(
                Effect.provideService(TxMode, txMode),
              ),
        );
      const transaction = <A, E, EBody>(
        mode: 'read' | 'write',
        body: Effect.Effect<A, EBody>,
        failed: (cause: unknown) => E,
      ) => own(mode, body).pipe(mapDatabaseFailure(failed));
      /** A write transaction. A closed-aggregate rejection the body raised
       *  leaves as itself, as it does from `job`; any other failure is the
       *  write's. On the global store, whose other processes can be newer
       *  builds, the gate runs first in each (`job` serves a project store
       *  alone, whose gate ran at open). */
      const transact = <A, E>(body: Effect.Effect<A, E>) =>
        transaction(
          'write',
          mode === 'global' ? Effect.andThen(gate, body) : body,
          (cause) =>
            cause instanceof DatabaseAggregateClosed
              ? // cast: only a body raises it, so it is one of its errors.
                (cause as Extract<E, DatabaseAggregateClosed>)
              : writeFailed(cause),
        );
      const reparent = `UPDATE event_sequence SET parent_id = ${AGGREGATE}
        WHERE id = ? AND closed_by IS NULL`;
      // A closed aggregate's sequence row, collected with its dependents
      // and rows by the foreign keys' cascade.
      const closedBy = `SELECT id FROM event_sequence
        WHERE kind = ? AND logical_id = ? AND closed_by = ?`;
      const collectClosed = `DELETE FROM event_sequence
        WHERE kind = ? AND logical_id = ? AND closed_by = ?`;
      const readState = (ids: readonly AggregateId[]) =>
        Effect.map(exec(READ_STATE, aggregateLists(ids)), (rows) =>
          rows.map((row) =>
            Schema.decodeUnknownSync(AggregateStateSchema)({
              ...row,
              aggregateId: aggregateOf(row.kind, row.logicalId),
              parentId:
                row.parentKind === null
                  ? null
                  : aggregateOf(row.parentKind, row.parentLogicalId),
            }),
          ),
        );
      const readDependents = Effect.fn('readDependents')(function* (
        id: AggregateId,
      ) {
        return yield* readState(
          (yield* exec(dependentKeys, aggregateColumns(id))).map((row) =>
            aggregateOf(row.kind, row.logicalId),
          ),
        );
      });
      /** A row whose aggregate is closed rejects this writer; one whose
       *  aggregate was never created is the caller's defect. */
      const refuseWriter = Effect.fn('refuseWriter')(function* (
        id: AggregateId,
        absent: string,
      ) {
        const held = (yield* readState([id]))[0];
        if (held === undefined) return yield* invariant(`${absent}: ${id}`);
        return yield* new DatabaseAggregateClosed({ aggregateId: id });
      });
      const upkeep = projectionUpkeep(exec, reader.read, path);
      /** A read of several statements, as one snapshot. */
      const snapshot = <A, E>(read: Effect.Effect<A, E>) =>
        transaction('read', read, readFailed);
      const appendRows = Effect.fn('appendRows')(function* (
        prepared: readonly ReturnType<typeof prepareEventDraft>[],
        at: number,
      ) {
        const committed = yield* Effect.forEach(prepared, ({ draft, row }) =>
          appendRow(draft, row, at),
        );
        const kinds = new Map(
          prepared.flatMap(({ draft, row }) => [
            [row.type, row.version] as const,
            ...(draft.type === 'plugin.fact'
              ? [[pluginKind(draft.plugin, draft.kind), draft.version] as const]
              : []),
          ]),
        );
        for (const [type, version] of kinds)
          yield* exec(UPSERT_KIND, [type, version]);
        yield* upkeep.follow(committed);
        return committed;
      });
      const appendRow = Effect.fn('appendRow')(function* (
        draft: SessionRowDraft,
        row: EncodedRow,
        at: number,
      ) {
        const edges = edgesOf(draft);
        const target = aggregateTarget(draft.aggregateId);
        const columns = aggregateColumns(draft.aggregateId);
        if (edges.reparent != null) {
          // A new parent run must be open: the plugin's writer checks it in
          // its job (`ownFactsChecked`), so one that is not is a defect.
          const current = (yield* readState([draft.aggregateId]))[0];
          if (current?.parentId !== edges.reparent) {
            const parent = (yield* readState([edges.reparent]))[0];
            if (!parent || parent.closed)
              return yield* invariant(
                `A plugin aggregate's new parent must be open: ${edges.reparent}`,
              );
          }
        }
        const next = yield* execOne(NEXT_SEQ, [...columns, randomUUID()]);
        const seq = next?.seq;
        const aggregate = next?.id;
        if (typeof seq !== 'number' || typeof aggregate !== 'number') {
          return yield* refuseWriter(
            draft.aggregateId,
            'Sequence refused for an absent aggregate',
          );
        }
        if (
          draft.type === 'plugin.fact' &&
          target.kind === 'run' &&
          draft.parent !== null
        )
          return yield* invariant(
            `A run's own plugin fact names no parent: ${factName(draft)}`,
          );
        // The seq-1 rule: a run aggregate begins with exactly
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
            id: runIdOf(aggregateTarget(edges.parent).id),
            uid: parentState.uid,
            call:
              draft.type === 'run.start' ? (draft.parent?.call ?? null) : null,
          };
        }
        // A deletion marker names only run directories this lifecycle owns,
        // derived under the closure's permit and transaction, not a caller.
        const committedDraft = yield* Effect.gen(function* () {
          if (draft.type === 'run.removed') {
            const owned = yield* exec(deletionRuns, columns);
            return { ...draft, runIds: owned.map((r) => runIdOf(r.runId)) };
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
          at,
          encoded.data,
        ]))?.commit;
        if (typeof commit !== 'number')
          return yield* invariant(
            `No commit assigned for aggregate ${draft.aggregateId}`,
          );
        for (const { digest, value, inline } of encoded.blobs) {
          yield* exec(INSERT_BLOB, [digest, value]);
          yield* exec(INSERT_REF, [commit, digest, inline ? 1 : 0]);
        }
        // Linked, not written: the foreign key refuses a blob that is gone.
        for (const digest of encoded.references)
          yield* exec(INSERT_REF, [commit, digest, 0]);
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
          yield* exec(reparent, [...parentColumns, aggregate]);
        }
        if (edges.closes) yield* exec(closeDependents, [...columns, commit]);
        return {
          ...committedDraft,
          seq,
          commit,
          at,
        };
      });
      // Every projection is caught up here, before the first read: from then
      // on this process is the store's one writer (the global store holds no
      // event rows), and each append keeps them current (`follow`).
      yield* transaction(
        'write',
        Effect.flatMap(currentCommit, upkeep.catchUp),
        openFailed,
      ).pipe(Effect.repeat({ until: (done) => done }));
      return {
        movedAside,
        currentCommit: query(currentCommit),
        displayRows,
        readDisplay: (fromCommit) => {
          // Pages are separate snapshots: a deletion marker seen stays in view.
          const tombstones = new Map<number, SessionRow>();
          return Stream.paginate(fromCommit, (from) =>
            snapshot(
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
                    .flatMap(shown),
                  through < top ? Option.some(through) : Option.none(),
                ] as const;
              }),
            ),
          );
        },
        readListing: () => query(decodedRows(READ_LISTING, [])),
        readBlobs: (digests) => query(reader.blobs(digests)),
        readRunRecord: (id) =>
          query(
            Effect.map(
              decodedRows(
                READ_RUN_RECORD,
                [...aggregateColumns(id), RECORD_TYPES],
                true,
              ),
              // Only a run has a start: a plugin's own aggregate has no record.
              (rows) => {
                const record = rows.reduce(recordAfter, NO_RUN_ROWS);
                return record.start === null ? null : record;
              },
            ),
          ),
        ...currentValues({
          exec,
          execOne,
          transact,
          query,
          afterCommit: sql.afterCommit,
          written: valuesWritten,
          valueWritten: Effect.asVoid(
            exec(UPSERT_KIND, [CURRENT_VALUE_KIND, CURRENT_VALUE_VERSION]),
          ),
        }),
        readAggregate: (id, fromSeq, types, toSeq = Number.MAX_SAFE_INTEGER) =>
          query(
            decodedRows(
              typedRows,
              [...aggregateColumns(id), fromSeq, toSeq, JSON.stringify(types)],
              true,
            ),
          ),
        readDisplayAggregate: (id, fromSeq) =>
          query(
            decodedRows(displayAggregate, [
              DISPLAY_READ_TYPES,
              ...aggregateColumns(id),
              fromSeq,
            ]).pipe(Effect.map((rows) => rows.flatMap(shown))),
          ),
        aggregateState: (ids) => query(readState(ids)),
        readInputBatch: (ids, fromCommit, throughCommit, checkedIds) =>
          snapshot(
            Effect.gen(function* () {
              const events = yield* decodedRows(inputRows, [
                LISTED_TYPES,
                ...aggregateLists(ids),
                LISTED_TYPES,
                fromCommit,
                throughCommit,
              ]);
              return {
                events: events.flatMap(shown),
                state: yield* readState(checkedIds),
                damaged: yield* reader.damaged,
              };
            }),
          ),
        runRemoval: (id, expectedStartCommit) =>
          transaction(
            'write',
            Effect.gen(function* () {
              const observed = yield* readDependents(id);
              const target = observed.find((row) => row.aggregateId === id);
              if (target === undefined || observed.some((row) => row.closed))
                return yield* new DatabaseAggregateClosed({ aggregateId: id });
              if (target.startCommit !== expectedStartCommit)
                return yield* new RunChanged({ aggregateId: id });
              return yield* appendRows(
                [prepareEventDraft({ type: 'run.removed', aggregateId: id })],
                yield* Clock.currentTimeMillis,
              );
            }),
            (cause) =>
              cause instanceof DatabaseAggregateClosed ||
              cause instanceof RunChanged
                ? cause
                : writeFailed(cause),
          ),
        deletions: {
          pending: () => query(decodedRows(pendingDeletions, [])),
          collect: Effect.fn('collect')(function* (tombstone, cleanup) {
            const columns = aggregateColumns(tombstone.aggregateId);
            // Already collected: the open's pass and the collector can both
            // hold a marker.
            if (
              (yield* query(
                execOne(closedBy, [...columns, tombstone.commit]),
              )) === undefined
            )
              return;
            // Filesystem promises cannot be undone by fiber interruption.
            yield* cleanup(tombstone.runIds).pipe(Effect.uninterruptible);
            yield* transact(
              Effect.gen(function* () {
                const digests = (yield* exec(dependentBlobs, columns)).map(
                  (row) => row.digest,
                );
                yield* exec(collectClosed, [...columns, tombstone.commit]);
                if (digests.length > 0)
                  yield* exec(collectBlobs, [JSON.stringify(digests)]);
              }),
            );
            yield* reclaimFreePages(sql, path);
          }),
        },
        job: (body) =>
          own('write', Effect.provideService(body, InPublisherJob, true)).pipe(
            // BEGIN's or COMMIT's failure; the body's leave typed.
            Effect.catchIf(isSqlError, (e) => Effect.fail(writeFailed(e))),
            Effect.catchDefect((d) =>
              isSqlError(d) ? Effect.fail(writeFailed(d)) : Effect.die(d),
            ),
          ),
        appendAll: Effect.fn('Database.appendAll')(function* (input) {
          if (input.length === 0) return [];
          // Validate and encode before BEGIN IMMEDIATE. The batch shares one clock.
          const prepared = yield* Effect.try({
            try: () => input.map(prepareEventDraft),
            catch: writeFailed,
          });
          const at = yield* Clock.currentTimeMillis;
          return yield* transact(appendRows(prepared, at));
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
 * poll fiber; an entry that must create none passes a refusing layer. */
export const globalDatabaseLayer = (
  storage: string,
): Layer.Layer<
  GlobalDatabase,
  DatabaseOpenFailed,
  FileSystem.FileSystem | ChildProcessSpawner
> =>
  Layer.effect(GlobalDatabase, Database).pipe(
    Layer.provide(
      databaseLayer('global').pipe(
        Layer.provide(Layer.succeed(WorkspaceRoots)({ storage })),
        Layer.provide(Layer.succeed(ToolRegistry)(toolTable([]))),
      ),
    ),
  );

/** Interruption stays; a failure, or SQLite's error raised as a defect (a
 *  failed COMMIT), becomes `failed`'s. Any other defect dies: the store's
 *  own protocol refusals (`invariant`) are a caller's defect, never a disk
 *  failure. */
function mapDatabaseFailure<E>(failed: (cause: unknown) => E) {
  return <A, EOp, R>(
    operation: Effect.Effect<A, EOp, R>,
  ): Effect.Effect<A, E, R> =>
    operation.pipe(
      Effect.catchDefect((defect) =>
        isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect),
      ),
      Effect.mapError(failed),
    );
}
