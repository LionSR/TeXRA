/**
 * The persistence substrate: the run history's one write path (on the
 * connection `storeConnection.ts` builds), the aggregate lifecycle, deletion and
 * collection, and the reads. One database per session root
 * (`SessionWorkspace`), never a process singleton; a project store is held
 * exclusively by the one process that opened it (`locking_mode =
 * EXCLUSIVE`); an ephemeral session runs the same schema in SQLite memory,
 * and a failed file open is an error, never the ephemeral mode. The global
 * storage root's store is `globalDatabaseLayer.ts`'s. `storeSchema.ts` owns the DDL and the open
 * sequence; `rowCodec.ts` every stored shape, by the fact kinds the process's
 * plugins contribute (this module reads no payload); `projections` the
 * projectors and their upkeep, run in this module's transactions. This
 * module owns the envelope: the publish clock, and the `seq` and `commit`
 * ordinals, none of which a caller supplies.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient';
import * as Reactivity from 'effect/reactivity/Reactivity';
import { isSqlError } from 'effect/sql/SqlError';
import {
  Clock,
  Effect,
  type FileSystem,
  Layer,
  Option,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect';
import { SessionWorkspace } from '@shared/session/sessionWorkspace';
import { ensureError } from '@utils/errors/errorMessage';
import {
  DISPLAY_ROW_TYPES,
  edgesOf,
  isDisplayRow,
  RunIdSchema,
  type RunId,
  type DisplayRow,
  type RunParent,
  type SessionRow,
  type SessionRowDraft,
  NonNegativeIntSchema,
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
  DatabaseOpenFailed,
  DatabaseAggregateClosed,
  RunChanged,
} from '@shared/session/database';
import { ToolRegistry } from '@tools/toolTable';
import { AppNamespace, storeFileName } from '@utils/system/appNamespace';
import { currentValues } from './currentValues';
import {
  LISTED_KINDS,
  PRICED_ROW_TYPES,
  projectionUpkeep,
  usageRows,
} from './projections';
import {
  EVENT_COLUMNS,
  EVENT_FROM,
  EVENT_JOINS,
  aggregateColumns,
  aggregateList,
  encodeDraft,
  pluginKind,
  prepareEventDraft,
  UPSERT_KINDS,
  type EncodedRow,
  type SqlRow,
} from './rowCodec';
import {
  AGGREGATE,
  callCard,
  CARD_ROW_TYPES,
  READ_LISTING,
  READ_RUN_RECORD,
  rowReader,
} from './rowReader';
import { isBusy, isDamaged, mapDatabaseFailure } from './storeAside';
import { storeConnection } from './storeConnection';
import {
  IN_MEMORY_STORE,
  openStore,
  PROJECT_SCHEMA,
  reclaimFreePages,
} from './storeSchema';
/** The store file `name` under `storage`, by the directory's real path.
 *  SQLite makes only the file, so `create` makes the directory first. */
export const storeFile = (
  storage: string,
  name: string,
  create: boolean,
): string => {
  if (create) mkdirSync(storage, { recursive: true });
  return join(realpathSync.native(storage), name);
};
/** A row or draft that contradicts the store's own protocol: a defect. */
const invariant = (message: string) => Effect.die(new Error(message));
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
/** Link a row to its blobs, bound as one `json_each(?)` array of
 *  `[digest, inline]` pairs. */
const INSERT_REFS = `INSERT INTO event_blob ("commit", digest, inline)
  SELECT ?, value ->> 0, value ->> 1 FROM json_each(?)`;
/** Aggregates bound as one `json_each(?)` array of `[kind, logicalId]`
 *  pairs (`aggregateList`), each found by its unique key. */
const AGGREGATE_LIST = `SELECT s.id FROM json_each(?) l
  CROSS JOIN event_sequence s
    ON s.kind = l.value ->> 0 AND s.logical_id = l.value ->> 1`;
/** Runs' existence, the list bound as `AGGREGATE_LIST` binds: a run's
 *  parent is a run. */
const READ_STATE = `
SELECT s.logical_id AS aggregateId, s.uid,
  s.closed_by IS NOT NULL AS closed, p.logical_id AS parentId,
  s.start_commit AS startCommit
FROM event_sequence s LEFT JOIN event_sequence p ON p.id = s.parent_id
WHERE s.id IN (${AGGREGATE_LIST})`;

/** The stored rows one display page covers. */
const DISPLAY_PAGE_ROWS = 2000;
/** The kinds a run's record reads, as the JSON list its read binds. */
const RECORD_TYPES = JSON.stringify(RECORD_ROW_TYPES);
/** A run's aggregate `logical_id` column as the `RunId` it is. */
const runIdOf = Schema.decodeUnknownSync(RunIdSchema);
/** The `event` table's autoincrement sequence: a non-negative integer. */
const EventSeqSchema = NonNegativeIntSchema;
/** Where a display page after a commit ends: at the last of the stored rows
 *  it covers. A page may end at any row, as each display row is shown from
 *  one stored row. No row: the page runs to the end. Counted in rows, so a
 *  stretch of collected commits bounds nothing. */
const DISPLAY_PAGE_END = `SELECT "commit" AS through FROM event
  WHERE "commit" > ? ORDER BY "commit" LIMIT 1 OFFSET ${DISPLAY_PAGE_ROWS - 1}`;

/** What a display read shows of one decoded row: a display row itself or a
 *  call row's tool card, then the `usage` row of a priced one; nothing else
 *  of a private row. A committed batch's display rows and every cold read
 *  are this function over their rows. */
const shown = (row: SessionRow): readonly DisplayRow[] => [
  ...(isDisplayRow(row) ? [row] : callCard(row)),
  ...usageRows(row),
];
/** The kinds a display read selects, as the JSON list it binds: the display
 *  rows, and the rows {@link shown} shows something of. */
const DISPLAY_READ_TYPES = JSON.stringify([
  ...DISPLAY_ROW_TYPES,
  ...CARD_ROW_TYPES,
  ...PRICED_ROW_TYPES,
]);
/** The kinds a view reads of every aggregate, as the JSON list its read
 *  binds: the listed kinds, and the priced rows whose `usage` row is one. */
const TAIL_READ_TYPES = JSON.stringify([...LISTED_KINDS, ...PRICED_ROW_TYPES]);
/**
 * The one display union: the `event` rows of the types bound first and an
 * optional further arm, narrowed by `where` over the union's columns
 * (`"commit"`, `kind`, `logicalId`, `seq`), which SQLite pushes into each
 * arm, so a range binds once.
 */
const displayUnion = (where: string, order: string, extra?: string) =>
  `SELECT * FROM (
    SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM}
      WHERE e.type IN (SELECT value FROM json_each(?))
    ${extra === undefined ? '' : `UNION ALL ${extra}`}
  ) WHERE ${where} ORDER BY ${order}`;

/** How a store is opened: a project store, created if absent
 *  (`persistent`) or only opened (`existing`), is held exclusively by this
 *  process for the connection's life; `ephemeral` runs in memory. */
type StoreMode = 'persistent' | 'existing' | 'ephemeral';

/** Why a project store did not open: another process holds it. */
export const STORE_HELD_MESSAGE =
  'Another process already has this project open; close it there first.';

export const databaseLayer = (
  mode: StoreMode,
): Layer.Layer<
  Database,
  DatabaseOpenFailed,
  SessionWorkspace | FileSystem.FileSystem | ToolRegistry | AppNamespace
> =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const roots = yield* SessionWorkspace;
      const name = storeFileName(yield* AppNamespace);
      const path =
        mode === 'ephemeral' ? IN_MEMORY_STORE : join(roots.storage, name);
      const openFailed = (cause: unknown): DatabaseOpenFailed =>
        new DatabaseOpenFailed({ path, cause });
      const create = mode !== 'existing';
      // The store's directory is made unless the store must exist already.
      const filename =
        mode === 'ephemeral'
          ? IN_MEMORY_STORE
          : yield* Effect.try({
              try: () => storeFile(roots.storage, name, create),
              catch: (cause) => openFailed(ensureError(cause)),
            });
      // A project store has one holder, this process, so the driver opens
      // it with no busy wait: a lock another process holds refuses the open
      // instead of waiting out the driver's timeout. The exclusive lock
      // below waits at most the 25 ms slice `prepareStore` leaves set.
      const { sql, movedAside } = yield* openStore(
        SqliteClient.make({
          filename: create
            ? filename
            : `file:${filename.replaceAll(/[%?#]/g, encodeURIComponent)}?mode=rw`,
          disableWAL: mode === 'ephemeral',
          busyTimeout: 0,
        }),
        path,
        filename,
        PROJECT_SCHEMA,
      ).pipe(
        Effect.catchIf(isBusy, () =>
          Effect.fail(openFailed(new Error(STORE_HELD_MESSAGE))),
        ),
        mapDatabaseFailure(openFailed),
      );
      if (mode !== 'ephemeral')
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
      /** Moved by every value write: what `values.changes` wakes on. */
      const valuesWritten = yield* SubscriptionRef.make(0);
      const highWater = "SELECT seq FROM sqlite_sequence WHERE name = 'event'";
      const commitFromRows = ([row]: readonly SqlRow[]) =>
        row === undefined
          ? 0
          : Schema.decodeUnknownSync(EventSeqSchema)(row.seq);
      const { factKinds } = yield* ToolRegistry;
      const store = storeConnection(sql, path, { shared: false, factKinds });
      const {
        exec,
        execOne,
        own,
        transaction,
        transact,
        query,
        snapshot,
        writeFailed,
      } = store;
      const reader = rowReader(store, factKinds);
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
      // The store gate, run once: this process is the store's one writer,
      // so what the store holds cannot change under it.
      yield* store.gate.pipe(mapDatabaseFailure(openFailed));
      // An aggregate and its open descendants. A descendant an earlier
      // deletion closed belongs to that deletion's marker alone, which
      // names its files and collects it.
      const dependents = `WITH RECURSIVE dependents(id) AS (
        SELECT id FROM event_sequence WHERE kind = ? AND logical_id = ?
        UNION ALL
        SELECT child.id FROM event_sequence child
        JOIN dependents parent ON child.parent_id = parent.id
        WHERE child.closed_by IS NULL
      )`;
      const deletionRuns = `${dependents}
        SELECT logical_id AS runId FROM event_sequence
        WHERE id IN (SELECT id FROM dependents) AND kind = 'run'
        ORDER BY runId
      `;
      // Taken out from under the closing tree first, so the tree's
      // collection does not cascade into an earlier marker's aggregate.
      const detachClosed = `${dependents}
        UPDATE event_sequence SET parent_id = NULL
        WHERE closed_by IS NOT NULL AND parent_id IN (SELECT id FROM dependents)
      `;
      const closeDependents = `${dependents}
        UPDATE event_sequence SET closed_by = ?
        WHERE id IN (SELECT id FROM dependents)
      `;
      // The rows a display read selects, in a commit range.
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
      // The rows a display read selects of one aggregate.
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
      const reparent = `UPDATE event_sequence SET parent_id = ${AGGREGATE}
        WHERE id = ? AND closed_by IS NULL`;
      // A closed aggregate's sequence row, collected with its dependents
      // and rows by the foreign keys' cascade, and the blobs no other row
      // links by the schema's `event_blob_collect`.
      const closedBy = `SELECT id FROM event_sequence
        WHERE kind = ? AND logical_id = ? AND closed_by = ?`;
      const collectClosed = `DELETE FROM event_sequence
        WHERE kind = ? AND logical_id = ? AND closed_by = ?`;
      const readState = (ids: readonly RunId[]) =>
        Effect.map(exec(READ_STATE, [aggregateList(ids)]), (rows) =>
          rows.map((row) =>
            Schema.decodeUnknownSync(AggregateStateSchema)(row),
          ),
        );
      /** A row whose aggregate is closed rejects this writer; one whose
       *  aggregate was never created is the caller's defect. */
      const refuseWriter = Effect.fn('refuseWriter')(function* (
        id: RunId,
        absent: string,
      ) {
        const held = (yield* readState([id]))[0];
        if (held === undefined) return yield* invariant(`${absent}: ${id}`);
        return yield* new DatabaseAggregateClosed({ aggregateId: id });
      });
      const upkeep = projectionUpkeep(store, reader.read);
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
        yield* exec(UPSERT_KINDS, [JSON.stringify([...kinds])]);
        yield* upkeep.follow(committed);
        return committed;
      });
      const appendRow = Effect.fn('appendRow')(function* (
        draft: SessionRowDraft,
        row: EncodedRow,
        at: number,
      ) {
        const edges = edgesOf(draft);
        const columns = aggregateColumns(draft.aggregateId);
        const next = yield* execOne(NEXT_SEQ, [...columns, randomUUID()]);
        const seq = next?.seq;
        const aggregate = next?.id;
        if (typeof seq !== 'number' || typeof aggregate !== 'number') {
          return yield* refuseWriter(
            draft.aggregateId,
            'Sequence refused for an absent aggregate',
          );
        }
        // The seq-1 rule: a run aggregate begins with exactly
        // one `run.start`, and nothing else ever lands at seq 1.
        if ((seq === 1) !== (draft.type === 'run.start')) {
          return yield* invariant(
            `A run must begin with exactly one run.start: ${draft.aggregateId}`,
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
            id: edges.parent,
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
        for (const { digest, value } of encoded.blobs)
          yield* exec(INSERT_BLOB, [digest, value]);
        // References are linked, not written: the foreign key refuses a
        // blob that is gone.
        const links = [
          ...encoded.blobs.map(({ digest, inline }) => [
            digest,
            inline ? 1 : 0,
          ]),
          ...encoded.references.map((digest) => [digest, 0]),
        ];
        if (links.length > 0)
          yield* exec(INSERT_REFS, [commit, JSON.stringify(links)]);
        if (seq === 1) {
          yield* exec(
            'UPDATE event_sequence SET start_commit = ? WHERE id = ?',
            [commit, aggregate],
          );
        }
        // A child run hangs under its parent run, so the parent's deletion
        // closes and collects it.
        if (edges.parent !== null)
          yield* exec(reparent, [...aggregateColumns(edges.parent), aggregate]);
        if (edges.closes) {
          yield* exec(detachClosed, columns);
          yield* exec(closeDependents, [...columns, commit]);
        }
        return {
          ...committedDraft,
          seq,
          commit,
          at,
        };
      });
      // Every projection is caught up here, before the first read: from then
      // on this process is the store's one writer, and each append keeps
      // them current (`follow`).
      yield* transaction(
        Effect.flatMap(currentCommit, upkeep.catchUp),
        openFailed,
      ).pipe(Effect.repeat({ until: (done) => done }));
      return {
        movedAside,
        currentCommit: query(currentCommit),
        displayRows: (rows) => rows.flatMap(shown),
        readDisplay: (fromCommit) => {
          // Pages are separate snapshots: a deletion marker seen stays in view.
          const removals = new Map<number, SessionRow>();
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
                    removals.set(row.commit, row);
                const read = new Set(rows.map((row) => row.commit));
                const kept = [...removals.values()].filter(
                  ({ commit }) =>
                    commit > from && commit <= through && !read.has(commit),
                );
                return [
                  [...rows, ...kept]
                    .toSorted((x, y) => x.commit - y.commit)
                    .flatMap(shown),
                  through < top ? Option.some(through) : Option.none(),
                ] as const;
              }),
            ),
          );
        },
        readListing: () =>
          query(
            Effect.map(decodedRows(READ_LISTING, []), (rows) =>
              rows.filter(isDisplayRow),
            ),
          ),
        readBlobs: (digests) => query(reader.blobs(digests)),
        readRunRecord: (id) =>
          query(
            Effect.map(
              decodedRows(
                READ_RUN_RECORD,
                [...aggregateColumns(id), RECORD_TYPES],
                true,
              ),
              // A run whose start has not committed has no record.
              (rows) => {
                const record = rows.reduce(recordAfter, NO_RUN_ROWS);
                return record.start === null ? null : record;
              },
            ),
          ),
        values: currentValues(store, valuesWritten),
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
                TAIL_READ_TYPES,
                aggregateList(ids),
                TAIL_READ_TYPES,
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
            Effect.gen(function* () {
              const [target] = yield* readState([id]);
              if (target === undefined || target.closed)
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
          collect: Effect.fn('collect')(function* (removal, cleanup) {
            const columns = aggregateColumns(removal.aggregateId);
            // Already collected: the open's pass and the collector can both
            // hold a marker.
            if (
              (yield* query(
                execOne(closedBy, [...columns, removal.commit]),
              )) === undefined
            )
              return;
            // Filesystem promises cannot be undone by fiber interruption.
            yield* cleanup(removal.runIds).pipe(Effect.uninterruptible);
            yield* transact(exec(collectClosed, [...columns, removal.commit]));
            yield* reclaimFreePages(sql, path);
          }),
        },
        job: (body) =>
          own(Effect.provideService(body, InPublisherJob, true)).pipe(
            // SQLite's own failures, a failed cleanup the client raises as a
            // defect included, are the write's; the body's leave typed.
            Effect.catchIf(isSqlError, (e) => Effect.fail(writeFailed(e))),
            Effect.catchDefect((d) =>
              isSqlError(d) ? Effect.fail(writeFailed(d)) : Effect.die(d),
            ),
          ),
        appendAll: Effect.fn('Database.appendAll')(function* (input) {
          if (input.length === 0) return [];
          // Encode before BEGIN IMMEDIATE; the batch shares one clock. Drafts
          // are typed and plugin facts were checked at their call
          // (`checkOwnFacts`), so a draft that fails here is a defect.
          const prepared = input.map(prepareEventDraft);
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
