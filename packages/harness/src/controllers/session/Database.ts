/**
 * The persistence substrate: the connection (its transaction wrapper and
 * retries are `storeAside.ts`'s), the run history's one write path, claims,
 * the aggregate lifecycle, deletion and collection, and the reads. One
 * database per session root (`WorkspaceRoots`), never a process singleton; an ephemeral
 * session runs the same schema in SQLite memory, and a failed file open is an
 * error, never the ephemeral mode. `storeSchema.ts` owns the DDL and the open
 * sequence; `rowCodec.ts` every stored shape, by the arms the process's
 * plugins contribute (this module reads no payload); `projections` the
 * projectors and their upkeep, run in this module's transactions. This
 * module owns the envelope: the writer (`ProcessIdentity`), the publish
 * clock, and the `seq` and `commit` ordinals, none of which a caller
 * supplies.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient';
import * as Reactivity from 'effect/reactivity/Reactivity';
import { isSqlError, type SqlError } from 'effect/sql/SqlError';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import {
  Clock,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect';
import { proveOwnerLiveness } from '@agent/storage/leaseOwnerLiveness';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessProbe } from '@platform/defaults/nodeProcesses';
import {
  CURRENT_VALUE_VERSION,
  edgesOf,
  isDisplaySessionEvent,
  RunIdSchema,
  ownerIdentity,
  PluginFactDraftSchema,
  aggregateTarget,
  referencedAggregates,
  type AggregateEdges,
  type AggregateId,
  type RunParent,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import { committing, ProcessIdentity } from '@shared/session/sessionEvents';
import {
  AggregateStateSchema,
  type DeletionMode,
  type AggregateState,
  Database,
  GlobalDatabase,
  DatabaseClaimRefused,
  DatabaseOpenFailed,
  DatabaseNotOwner,
  DatabaseReadFailed,
  DatabaseStoreNewer,
  DatabaseWriteFailed,
} from '@shared/session/database';
import { armsOf } from '@tools/plugins';
import { ToolRegistry, toolTable } from '@tools/toolTable';
import { currentValues, READ_RETRY } from './currentValues';
import { localDatabasePath } from './localDatabasePath';
import { LISTED_TYPES, projectionUpkeep } from './projections';
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
  DISPLAY_READ_TYPES,
  PROJECTED_COLUMNS,
  PROJECTED_FROM,
  READ_LISTING,
  READ_RUN_RECORDS,
  rowReader,
  settleCards,
  type Exec,
} from './rowReader';
import {
  commitFromRows,
  HIGH_WATER,
  isBusy,
  isDamaged,
  mapDatabaseFailure,
  ProvenOwners,
  provingOwners,
  reclaimable,
  retryBusy,
  storeTransactions,
  TxMode,
} from './storeAside';
import { openStore, reclaimFreePages } from './storeSchema';
/** The database file of a session root, beside the stores it replaces. */
const SESSION_DATABASE_FILE = 'texra.db';
const CHANNEL = 'sessionDatabase';
/** A row or draft that contradicts the store's own protocol: a defect. */
const invariant = (message: string) => Effect.die(new Error(message));
/** The run-lifecycle rule a draft at `seq` of its aggregate breaks, if any:
 *  a run begins with exactly one `run.start`, nothing else lands at its
 *  seq 1, and only a run starts or is removed. */
function lifecycleRefusal(
  draft: SessionEventDraft,
  onRun: boolean,
  seq: number,
): string | undefined {
  if (onRun && (seq === 1) !== (draft.type === 'run.start'))
    return `A run must begin with exactly one run.start: ${draft.aggregateId}`;
  if ((draft.type === 'run.start' || draft.type === 'run.removed') && !onRun)
    return `Run lifecycle event has a non-run target: ${draft.aggregateId}`;
  return undefined;
}
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

/** Aggregates bound as two parallel `json_each(?)` arrays (`aggregateLists`),
 *  joined in this order: a free planner scans both arrays per aggregate. */
const AGGREGATE_LIST = `WITH k(key, value) AS MATERIALIZED
  (SELECT key, value FROM json_each(?))
  SELECT s.id FROM json_each(?) l CROSS JOIN k ON k.key = l.key
  CROSS JOIN event_sequence s ON s.kind = k.value AND s.logical_id = l.value`;
/** Aggregates' claim state, the list bound as `AGGREGATE_LIST` binds. */
const READ_STATE = `
SELECT s.kind, s.logical_id AS logicalId, s.uid, s.owner_id AS ownerId,
  s.closed_by IS NOT NULL AS closed, p.kind AS parentKind,
  p.logical_id AS parentLogicalId, s.start_commit AS startCommit
FROM event_sequence s LEFT JOIN event_sequence p ON p.id = s.parent_id
WHERE s.id IN (${AGGREGATE_LIST})
`;

/** Stored rows a display page reads before it runs on to its batch's end. */
const DISPLAY_PAGE_ROWS = 2000;
/** A run's aggregate `logical_id` column as the `RunId` it is. */
const runIdOf = Schema.decodeUnknownSync(RunIdSchema);
/** Where a display page after a commit ends: 2,000 stored rows on, run to
 *  the end of the batch the last one is in, as a card's `tool.end` and the
 *  settlement it projects from share one batch (`settleCards`) and a batch's
 *  rows share one `at`. No row, or a NULL `through`: the page runs to the
 *  end. Counted in rows, so a stretch of collected commits bounds nothing. */
const DISPLAY_PAGE_END = `WITH last AS (SELECT "commit", at FROM event
    WHERE "commit" > ? ORDER BY "commit" LIMIT 1 OFFSET ${DISPLAY_PAGE_ROWS - 1})
  SELECT (SELECT e."commit" - 1 FROM event e
    WHERE e."commit" > last."commit" AND e.at <> last.at
    ORDER BY e."commit" LIMIT 1) AS through FROM last`;

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
/** One `READ_STATE` row as the aggregate state it is. */
const stateOf = (row: SqlRow): AggregateState =>
  Schema.decodeUnknownSync(AggregateStateSchema)({
    ...row,
    aggregateId: aggregateOf(row.kind, row.logicalId),
    parentId:
      row.parentKind === null
        ? null
        : aggregateOf(row.parentKind, row.parentLogicalId),
  });
/** Moves on every other connection's commit: the change poll's signal. */
const DATA_VERSION = 'PRAGMA data_version';
/** An aggregate and every aggregate under it, by the parent edges. */
const DEPENDENTS = `WITH RECURSIVE dependents(id) AS (
  SELECT id FROM event_sequence WHERE kind = ? AND logical_id = ?
  UNION ALL
  SELECT child.id FROM event_sequence child
  JOIN dependents parent ON child.parent_id = parent.id
)`;
const DEPENDENT_KEYS = `${DEPENDENTS}
  SELECT kind, logical_id AS logicalId FROM event_sequence
  WHERE id IN (SELECT id FROM dependents) ORDER BY kind, logical_id`;
const UNOWNED_DEPENDENT = `${DEPENDENTS}
  SELECT kind, logical_id AS logicalId FROM event_sequence
  WHERE id IN (SELECT id FROM dependents)
    AND closed_by IS NULL AND owner_id IS NOT ?
  LIMIT 1`;
const DELETION_RUNS = `${DEPENDENTS}
  SELECT logical_id AS runId FROM event_sequence
  WHERE id IN (SELECT id FROM dependents) AND kind = 'run'
  ORDER BY runId`;
const CLOSE_DEPENDENTS = `${DEPENDENTS}
  UPDATE event_sequence SET closed_by = ?
  WHERE id IN (SELECT id FROM dependents)`;
const DEPENDENT_BLOBS = `${DEPENDENTS} SELECT DISTINCT r.digest FROM event_blob r
  JOIN event e ON e."commit" = r."commit" WHERE e.aggregate IN (SELECT id FROM dependents)`;
/** Blob collection is by reachability: a digest no row references. */
const COLLECT_BLOBS = `DELETE FROM blob
  WHERE digest IN (SELECT value FROM json_each(?))
    AND NOT EXISTS (SELECT 1 FROM event_blob r WHERE r.digest = blob.digest)`;
/** The display types in a commit range, plus projected rows. */
const READ_DISPLAY = displayUnion('"commit" > ? AND "commit" <= ?', '"commit"');
const READ_AGGREGATE = `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM}
  WHERE s.kind = ? AND s.logical_id = ? AND e.seq >= ?
  ORDER BY e.seq`;
/** Named: for an `IN` list the planner walks the aggregate's seq index. */
const READ_TYPED_ROWS = `SELECT ${EVENT_COLUMNS} FROM event e
  INDEXED BY event_aggregate_type ${EVENT_JOINS}
  WHERE s.kind = ? AND s.logical_id = ? AND e.seq >= ?
    AND e.type IN (SELECT value FROM json_each(?)) ORDER BY e.seq`;
/** A tombstone closes its run and stays its last row until collected. */
const PENDING_DELETIONS = `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM}
  WHERE e.type = 'run.removed' ORDER BY e."commit"`;
/** One aggregate's display rows, its projected rows among them. */
const READ_DISPLAY_AGGREGATE = displayUnion(
  'kind = ? AND logicalId = ? AND seq >= ?',
  'seq',
);
/** The listing's tail, plus every row of the resident aggregates. */
const READ_INPUT_ROWS = displayUnion(
  '"commit" > ? AND "commit" <= ?',
  '"commit"',
  `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM}
    WHERE e.aggregate IN (${AGGREGATE_LIST})
      AND e.type NOT IN (SELECT value FROM json_each(?))`,
);
const CLAIM = `UPDATE event_sequence SET owner_id = ?
  WHERE kind = ? AND logical_id = ? AND owner_id IS ?
    AND closed_by IS NULL RETURNING id`;
const RELEASE = `UPDATE event_sequence SET owner_id = NULL
  WHERE id IN (${AGGREGATE_LIST}) AND owner_id = ?`;
const REPARENT = `UPDATE event_sequence SET parent_id = ${AGGREGATE}
  WHERE id = ? AND owner_id = ? AND closed_by IS NULL`;
/** A closed aggregate's sequence row, collected with its dependents and
 *  rows by the foreign keys' cascade. */
const CLOSED_BY = `SELECT id FROM event_sequence
  WHERE kind = ? AND logical_id = ? AND closed_by = ?`;
const COLLECT_CLOSED = `DELETE FROM event_sequence
  WHERE kind = ? AND logical_id = ? AND closed_by = ?`;
/** An aggregate's plugin rows, for its arms' transition rules. */
const PLUGIN_ROWS = `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM}
  WHERE e.aggregate = ? AND e.type = 'plugin.fact' ORDER BY e.seq`;

/**
 * The session database of the root in context: `persistent` opens or
 * creates its `texra.db`, `existing` opens one only if it is there, and
 * `ephemeral` runs the same schema in SQLite memory.
 */
export const databaseLayer = (
  mode: 'persistent' | 'ephemeral' | 'existing',
): Layer.Layer<
  Database,
  DatabaseOpenFailed,
  WorkspaceRoots | ProcessIdentity | ProcessProbe | ToolRegistry
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
        mode === 'ephemeral'
          ? ':memory:'
          : join(roots.storage, SESSION_DATABASE_FILE);
      const openFailed = (cause: unknown): DatabaseOpenFailed =>
        new DatabaseOpenFailed({ path, cause });
      const create = mode !== 'existing';
      const filename =
        mode === 'ephemeral'
          ? ':memory:'
          : yield* localDatabasePath(
              roots.storage,
              SESSION_DATABASE_FILE,
              create,
            ).pipe(Effect.mapError(openFailed));
      const { sql, movedAside } = yield* openStore(
        SqliteClient.make({
          filename: create
            ? filename
            : `file:${filename.replaceAll(/[%?#]/g, encodeURIComponent)}?mode=rw`,
          disableWAL: mode === 'ephemeral',
          busyTimeout: '5 seconds',
        }),
        SqliteClient.make({ filename, readonly: true, disableWAL: true }),
        mode === 'ephemeral' ? mode : 'persistent',
        path,
        filename,
      ).pipe(mapDatabaseFailure(openFailed));
      const level = yield* SubscriptionRef.make(0);
      const observedCommit = yield* SubscriptionRef.make(0);
      /** A commit seen, written here or found by the poll: the observed
       *  mark moves, only forward (a poll that read the high-water mark
       *  before a local commit never sets it back), and every reader wakes. */
      const published = (commit: number) =>
        SubscriptionRef.update(observedCommit, (c) => Math.max(c, commit)).pipe(
          Effect.andThen(SubscriptionRef.update(level, (wake) => wake + 1)),
        );
      const writeFailed = (cause: unknown): DatabaseWriteFailed =>
        new DatabaseWriteFailed({ path, cause });
      const readFailed = (cause: unknown): DatabaseReadFailed =>
        new DatabaseReadFailed({ path, cause });
      const query = <A, E>(
        read: Effect.Effect<A, E>,
      ): Effect.Effect<A, DatabaseReadFailed> =>
        read.pipe(retryBusy, mapDatabaseFailure(readFailed));
      /** One statement's rows, untyped until the caller parses them. */
      const exec: Exec<SqlError> = sql.unsafe;
      /** The first row a statement returns, if any. */
      const execOne = (statement: string, params?: readonly unknown[]) =>
        exec(statement, params).pipe(Effect.map((rows) => rows[0]));
      /** The store gate (`storeGate`), in the caller's transaction. */
      const arms = armsOf((yield* ToolRegistry).entries.values());
      const gate = storeGate(exec, arms);
      const reader = rowReader(path, arms, exec);
      const decodedRows = (
        statement: string,
        params: readonly unknown[],
        whole = false,
      ) =>
        exec(statement, params).pipe(
          Effect.flatMap((rows) => reader.read(rows, whole)),
          Effect.map(settleCards),
        );
      const currentCommit = exec(HIGH_WATER, []).pipe(
        Effect.map(commitFromRows),
      );
      yield* SubscriptionRef.set(
        observedCommit,
        yield* currentCommit.pipe(mapDatabaseFailure(openFailed)),
      );
      yield* gate.pipe(mapDatabaseFailure(openFailed));
      let version = (yield* execOne(DATA_VERSION, []).pipe(
        mapDatabaseFailure(openFailed),
      ))?.data_version;
      // A failed read logs and retries; `version` moves once its commit is read.
      yield* Effect.forkScoped(
        Stream.tick('250 millis').pipe(
          Stream.runForEach(() =>
            Effect.gen(function* () {
              const next = (yield* query(execOne(DATA_VERSION, [])))
                ?.data_version;
              if (next !== version) {
                const commit = yield* query(currentCommit);
                version = next;
                yield* published(commit);
              }
            }).pipe(
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
      const withTransaction = storeTransactions(sql, published);
      // Every body is database-only, so a busy one runs again whole. The
      // store gate runs inside every outermost write and derive: a store
      // holding a kind this build does not read takes no write from it, bar
      // `releaseClaims` (`gated` false), which writes no row and gives back
      // this process's claims. In a caller's transaction a body is a savepoint.
      const own = <A, E>(
        mode: 'read' | 'write' | 'derive',
        body: Effect.Effect<A, E>,
        gated = mode !== 'read',
      ) =>
        Effect.flatMap(TxMode, (outer) =>
          outer !== null
            ? withTransaction(body)
            : provingOwners(liveness)(
                retryBusy(
                  withTransaction(gated ? Effect.andThen(gate, body) : body),
                ).pipe(Effect.provideService(TxMode, mode)),
              ),
        );
      const transaction = <A, E, EBody>(
        mode: 'read' | 'write' | 'derive',
        body: Effect.Effect<A, EBody>,
        failed: (cause: unknown) => E,
        gated?: boolean,
      ) => own(mode, body, gated).pipe(mapDatabaseFailure(failed));
      /** A write transaction. An ownership rejection the body raised leaves
       *  as itself, as it does from `job`; any other failure is the write's. */
      const transact = <A, E>(body: Effect.Effect<A, E>) =>
        transaction('write', body, (cause) =>
          cause instanceof DatabaseNotOwner ||
          cause instanceof DatabaseClaimRefused
            ? // cast: only a body raises these, so it is one of its errors.
              (cause as Extract<E, DatabaseNotOwner | DatabaseClaimRefused>)
            : writeFailed(cause),
        );
      const readState = (ids: readonly AggregateId[]) =>
        Effect.gen(function* () {
          return (yield* exec(READ_STATE, aggregateLists(ids))).map(stateOf);
        });
      const readDependents = (id: AggregateId) =>
        Effect.gen(function* () {
          return yield* readState(
            (yield* exec(DEPENDENT_KEYS, aggregateColumns(id))).map((row) =>
              aggregateOf(row.kind, row.logicalId),
            ),
          );
        });
      /** A row whose claim moved or closed rejects this writer. Read in the
       *  rejecting transaction, so the typed rejection names the holder. */
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
      const othersOf = (observed: readonly AggregateState[]) =>
        new Set(
          observed.flatMap((row) =>
            row.ownerId === null || row.ownerId === identity.ownerId
              ? []
              : [row.ownerId],
          ),
        );
      /** Claim `observed`, which MUST be read in this same transaction, once
       *  its other owners are proven dead (deleting a single run: or unprovable). */
      const claimAll = (
        observed: readonly AggregateState[],
        mode?: DeletionMode,
      ) =>
        Effect.gen(function* () {
          yield* reclaimable(othersOf(observed), mode === 'single');
          yield* exec(
            `UPDATE event_sequence SET owner_id = ? WHERE id IN (${AGGREGATE_LIST}) AND closed_by IS NULL`,
            [
              identity.ownerId,
              ...aggregateLists(observed.map((row) => row.aggregateId)),
            ],
          );
        });
      const upkeep = projectionUpkeep(exec, reader.read, path);
      /** A read of the projections, in the same read transaction as the
       *  check that they are current, so another build's rebuild never hands
       *  it a half-built one; a stale one catches up, a transaction a step,
       *  and the read runs again. */
      const projected = <A, E>(read: Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          for (;;) {
            const result = yield* transaction(
              'read',
              Effect.gen(function* () {
                if (!(yield* upkeep.current(yield* currentCommit))) return null;
                return { value: yield* read };
              }),
              readFailed,
            );
            if (result !== null) return result.value;
            yield* transaction(
              'derive',
              Effect.flatMap(currentCommit, upkeep.catchUp),
              readFailed,
            ).pipe(Effect.repeat({ until: (done) => done }));
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
          yield* upkeep.follow(committed, before);
          return committed;
        });
      /** A plugin aggregate's new parent run must be open and held here. */
      const checkReparent = (id: AggregateId, reparent: AggregateId) =>
        Effect.gen(function* () {
          if ((yield* readState([id]))[0]?.parentId === reparent) return;
          const parent = (yield* readState([reparent]))[0];
          if (!parent || parent.closed || parent.ownerId !== identity.ownerId)
            return yield* invariant(
              `A plugin aggregate's new parent must be open and owned here: ${reparent}`,
            );
        });
      /** Why the fact's arm refuses it after the aggregate's last fact of
       *  that kind, if it does. Never over a corrupt row of the aggregate: it
       *  fails whole. */
      const pluginRefusal = (
        draft: typeof PluginFactDraftSchema.Type,
        onRun: boolean,
        aggregate: number,
      ) =>
        Effect.gen(function* () {
          const name = `${draft.plugin}/${draft.kind}`;
          const last = (yield* reader.read(
            yield* exec(PLUGIN_ROWS, [aggregate]),
            true,
          )).findLast(
            (row) =>
              row.type === 'plugin.fact' &&
              `${row.plugin}/${row.kind}` === name,
          );
          return onRun && draft.parent !== null
            ? `A run's own plugin fact names no parent: ${name}`
            : arms[name]?.admits?.(
                last?.type === 'plugin.fact' ? last : undefined,
                draft,
              );
        });
      /** The declared parent's incarnation, stamped in this transaction: a
       *  reused logical id must not redirect the child to a later one. */
      const parentOf = (draft: SessionEventDraft, parentId: AggregateId) =>
        Effect.gen(function* () {
          const state = (yield* readState([parentId]))[0];
          if (!state || state.closed || state.startCommit === null)
            return yield* invariant(
              `Child creation requires an open parent: ${parentId}`,
            );
          const parent: RunParent = {
            id: runIdOf(aggregateTarget(parentId).id),
            uid: state.uid,
            callId:
              draft.type === 'run.start'
                ? (draft.parent?.callId ?? null)
                : null,
          };
          return parent;
        });
      /** Insert one encoded row at `seq` of `aggregate` with its blobs and
       *  references, answering the commit SQLite assigned it. */
      const insertRow = (
        id: AggregateId,
        aggregate: number,
        seq: number,
        encoded: EncodedRow,
        at: number,
      ) =>
        Effect.gen(function* () {
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
            return yield* invariant(`No commit assigned for aggregate ${id}`);
          for (const { digest, value } of encoded.blobs) {
            yield* exec(INSERT_BLOB, [digest, value]);
            yield* exec(INSERT_REF, [commit, digest]);
          }
          // Linked, not written: the foreign key refuses a blob that is gone.
          for (const digest of encoded.references)
            yield* exec(INSERT_REF, [commit, digest]);
          return commit;
        });
      /** The aggregate-graph edges a committed row moves: the run's start
       *  commit, a plugin aggregate's parent, its borrowed claim given back,
       *  and the dependents a tombstone closes. */
      const moveEdges = (
        edges: AggregateEdges,
        columns: readonly unknown[],
        aggregate: number,
        seq: number,
        commit: number,
      ) =>
        Effect.gen(function* () {
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
            yield* exec(REPARENT, [
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
            // Closing an aggregate requires every open dependent claim, held
            // in the tombstone's transaction, so no claimant can change between.
            const unowned = yield* execOne(UNOWNED_DEPENDENT, [
              ...columns,
              identity.ownerId,
            ]);
            if (unowned)
              return yield* invariant(
                `Deletion requires the dependent claim: ${aggregateOf(unowned.kind, unowned.logicalId)}`,
              );
            yield* exec(CLOSE_DEPENDENTS, [...columns, commit]);
          }
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
            // A plugin's own aggregate borrows its claim for this transaction only.
            yield* exec(CLAIM, [identity.ownerId, ...columns, null]);
          }
          if (edges.reparent != null)
            yield* checkReparent(draft.aggregateId, edges.reparent);
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
            const refused = yield* pluginRefusal(
              draft,
              target.kind === 'run',
              aggregate,
            );
            if (refused) return yield* invariant(refused);
          }
          const broken = lifecycleRefusal(draft, target.kind === 'run', seq);
          if (broken !== undefined) return yield* invariant(broken);
          const parent =
            edges.parent === null ? null : yield* parentOf(draft, edges.parent);
          // A tombstone names only run directories this lifecycle owns,
          // derived under the closure's permit and transaction, not a caller.
          const committedDraft = yield* Effect.gen(function* () {
            if (draft.type === 'run.removed') {
              const owned = yield* exec(DELETION_RUNS, columns);
              return { ...draft, runIds: owned.map((r) => runIdOf(r.runId)) };
            }
            if (draft.type === 'run.start') return { ...draft, parent };
            return draft;
          });
          const commit = yield* insertRow(
            draft.aggregateId,
            aggregate,
            seq,
            committedDraft === draft ? row : encodeDraft(committedDraft),
            at,
          );
          yield* moveEdges(edges, columns, aggregate, seq, commit);
          return {
            ...committedDraft,
            seq,
            commit,
            origin: identity.ownerId,
            at,
          };
        });
      return {
        observedCommit,
        movedAside,
        level,
        currentCommit: query(currentCommit),
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
                const rows = yield* decodedRows(READ_DISPLAY, [
                  DISPLAY_READ_TYPES,
                  from,
                  through,
                ]);
                if (through < top)
                  for (const row of yield* decodedRows(PENDING_DELETIONS, []))
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
        readBlobs: (digests) => query(reader.blobs(digests)),
        readRunRecords: (id) =>
          projected(decodedRows(READ_RUN_RECORDS, aggregateColumns(id), true)),
        ...currentValues({
          exec,
          execOne,
          transact,
          query,
          level,
          valueWritten: Effect.asVoid(
            exec(UPSERT_KIND, [CURRENT_VALUE_KIND, CURRENT_VALUE_VERSION]),
          ),
        }),
        readAggregate: (id, fromSeq, types) =>
          query(
            types === undefined
              ? decodedRows(
                  READ_AGGREGATE,
                  [...aggregateColumns(id), fromSeq],
                  true,
                )
              : decodedRows(
                  READ_TYPED_ROWS,
                  [...aggregateColumns(id), fromSeq, JSON.stringify(types)],
                  true,
                ),
          ),
        readDisplayAggregate: (id, fromSeq) =>
          projected(
            decodedRows(READ_DISPLAY_AGGREGATE, [
              DISPLAY_READ_TYPES,
              ...aggregateColumns(id),
              fromSeq,
            ]).pipe(Effect.map((rows) => rows.filter(isDisplaySessionEvent))),
          ),
        aggregateState: (ids) => query(readState(ids)),
        claimOwner: Effect.fn('Database.claimOwner')(function* (id) {
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
              const events = yield* decodedRows(READ_INPUT_ROWS, [
                LISTED_TYPES,
                ...aggregateLists(ids),
                LISTED_TYPES,
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
                damaged: yield* reader.damaged,
              };
            }),
          ),
        acquireClaims: (ids) =>
          ids.length === 0
            ? Effect.succeed([])
            : transact(
                Effect.gen(function* () {
                  const observed = yield* readState(ids);
                  if (
                    observed.length !== new Set(ids).size ||
                    observed.some((row) => row.closed)
                  )
                    return yield* Effect.fail(
                      new Error('A claim target is missing or closed.'),
                    );
                  yield* claimAll(observed);
                  return observed
                    .filter((row) => row.ownerId !== identity.ownerId)
                    .map((row) => row.aggregateId);
                }),
              ),
        prepareRunRemoval: Effect.fn('Database.prepareRunRemoval')(
          function* (id, mode, expectedStartCommit) {
            const seen = yield* query(readDependents(id));
            // Outside the transaction: each probe may spawn a process.
            const verdicts = yield* Effect.forEach(
              othersOf(seen),
              (owner) =>
                Effect.map(liveness(owner), (v) => [owner, v] as const),
              { concurrency: 'unbounded' },
            );
            const removing = Effect.gen(function* () {
              const observed = yield* readDependents(id);
              const target = observed.find((row) => row.aggregateId === id);
              if (target === undefined || observed.some((row) => row.closed))
                return yield* Effect.fail(
                  new Error(`Deletion target is missing or closed: ${id}`),
                );
              if (target.startCommit !== expectedStartCommit)
                return yield* Effect.fail(
                  new Error(`Deletion target changed since admission: ${id}`),
                );
              yield* claimAll(observed, mode);
              return yield* appendRows(
                [prepareEventDraft({ type: 'run.removed', aggregateId: id })],
                yield* Clock.currentTimeMillis,
              );
            });
            return Effect.flatMap(ProvenOwners, (proven) =>
              transact(removing).pipe(
                Effect.provideService(
                  ProvenOwners,
                  new Map([...verdicts, ...proven]),
                ),
              ),
            );
          },
        ),
        deletions: {
          pending: () => query(decodedRows(PENDING_DELETIONS, [])),
          collect: (tombstone, cleanup) =>
            Effect.gen(function* () {
              const columns = aggregateColumns(tombstone.aggregateId);
              // Already collected (by this pass before, or another process).
              if (
                (yield* query(
                  execOne(CLOSED_BY, [...columns, tombstone.commit]),
                )) === undefined
              )
                return;
              // A store a newer build wrote takes no deletion from this one,
              // and the files go only once the store would take the collection.
              yield* query(gate);
              // Filesystem promises cannot be undone by fiber interruption.
              yield* cleanup(tombstone.runIds).pipe(Effect.uninterruptible);
              yield* transact(
                Effect.gen(function* () {
                  const digests = (yield* exec(DEPENDENT_BLOBS, columns)).map(
                    (row) => row.digest,
                  );
                  yield* exec(COLLECT_CLOSED, [...columns, tombstone.commit]);
                  if (digests.length > 0)
                    yield* exec(COLLECT_BLOBS, [JSON.stringify(digests)]);
                }),
              );
              yield* reclaimFreePages(sql, path);
            }),
        },
        releaseClaims: (ids) =>
          ids.length === 0
            ? Effect.void
            : transaction(
                'write',
                exec(RELEASE, [...aggregateLists(ids), identity.ownerId]),
                writeFailed,
                false,
              ),
        job: (body) =>
          committing(
            (attempt) =>
              own('write', attempt).pipe(
                // The gate's, BEGIN's or COMMIT's failure; the body's leave typed.
                Effect.catchIf(
                  (e) => isSqlError(e) || e instanceof DatabaseStoreNewer,
                  (e) => Effect.fail(writeFailed(e)),
                ),
                Effect.catchDefect((d) =>
                  isSqlError(d) ? Effect.fail(writeFailed(d)) : Effect.die(d),
                ),
              ),
            body,
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
export const storeOpenElsewhere = (
  filename: string,
): Effect.Effect<'free' | 'open' | 'unreadable', SqlError> =>
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
  ProcessIdentity | ProcessProbe
> =>
  Layer.effect(GlobalDatabase, Database).pipe(
    Layer.provide(
      databaseLayer('persistent').pipe(
        Layer.provide(Layer.succeed(WorkspaceRoots)({ storage })),
        Layer.provide(Layer.succeed(ToolRegistry)(toolTable([]))),
      ),
    ),
  );
