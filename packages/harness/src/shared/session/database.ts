/**
 * The root-scoped event store contract; SQLite and its lifetime belong to
 * the controller layer. Each storage error has one outcome (README
 * "Storage failures"):
 * - `DatabaseOpenFailed`: the session does not open.
 * - `DatabaseReadFailed`: the call that read fails. A run whose own row is
 *   `DatabaseRowCorrupt` or `DatabaseRowEarlier` is unreadable, never resumed.
 * - `DatabaseWriteFailed`: nothing written; a run ends (`findStorageRefusal`).
 * - `DatabaseStoreNewer`, the cause of any of these: the store is refused whole.
 * - `DatabaseAggregateClosed`, never wrapped: a batch named a closed
 *   aggregate; nothing written.
 * - `RunChanged`, never wrapped: a run's removal named a lifetime that has
 *   since ended; nothing written.
 * A row or draft that breaks the store's own protocol is a defect, never one
 * of these.
 */
import {
  Context,
  type Effect,
  type RcMap,
  type Result,
  Schema,
  type Stream,
} from 'effect';
import { AggregateIdSchema } from '@shared/schemas';
import type {
  AggregateId,
  CommitOrdinal,
  DisplayRow,
  RunId,
  SessionRow,
  SessionRowDraft,
  UnreadableRun,
} from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { WithBlobs } from './historyTurns';
import type { RunRows } from './runRowsShape';
import type { ValueFamily } from './valueFamily';

/** Current CLI history rows, ordered oldest first. */
export const InputHistoryRecordSchema = Schema.Struct({
  at: Schema.Number,
  value: Schema.String,
});
export type InputHistoryRecord = typeof InputHistoryRecordSchema.Type;
export const INPUT_HISTORY_LIMIT = 1000;

/** The current existence of an aggregate, independent of its rows' writers. */
export const AggregateStateSchema = Schema.Struct({
  aggregateId: AggregateIdSchema,
  /** The incarnation's durable identity, minted with its first row. */
  uid: Schema.String.check(Schema.isUUID()),
  closed: Schema.BooleanFromBit,
  parentId: Schema.NullOr(AggregateIdSchema),
  startCommit: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type AggregateState = typeof AggregateStateSchema.Type;

/** A store failure's fields, and its text: a `SqlError`'s message and the
 *  SQLite error that says why (`database is locked`), its reason's cause,
 *  which `toErrorMessage` reads. */
const storeFailure = { path: Schema.String, cause: Schema.Defect() };
const storeFailureMessage = (cause: unknown): string => toErrorMessage(cause);

/** The database could not be opened, or its schema could not be applied. */
export class DatabaseOpenFailed extends Schema.TaggedError<DatabaseOpenFailed>()(
  'DatabaseOpenFailed',
  storeFailure,
) {
  override readonly message = storeFailureMessage(this.cause);
}

/** A batch was rejected whole: no member or sequence moved. */
export class DatabaseWriteFailed extends Schema.TaggedError<DatabaseWriteFailed>()(
  'DatabaseWriteFailed',
  storeFailure,
) {
  override readonly message = storeFailureMessage(this.cause);
}

/** A batch member targets an aggregate that is closed (deleted) or was
 *  never created; nothing was written. The store's protocol, not the disk,
 *  so it is never wrapped in `DatabaseWriteFailed`. */
export class DatabaseAggregateClosed extends Schema.TaggedError<DatabaseAggregateClosed>()(
  'DatabaseAggregateClosed',
  { aggregateId: AggregateIdSchema },
) {
  override readonly message = `${this.aggregateId} is closed; nothing was written.`;
}

/** A run's removal found a later lifetime of the run than the one its
 *  request read (it ended and started again since); nothing was written. */
export class RunChanged extends Schema.TaggedError<RunChanged>()('RunChanged', {
  aggregateId: AggregateIdSchema,
}) {
  override readonly message = `${this.aggregateId} changed since its removal was asked for; nothing was written.`;
}

/** A query failed or encountered an invalid persisted row. */
export class DatabaseReadFailed extends Schema.TaggedError<DatabaseReadFailed>()(
  'DatabaseReadFailed',
  storeFailure,
) {
  override readonly message = storeFailureMessage(this.cause);
}

/** The strings a blob read returns, by digest: total over the digests it
 *  was asked for, and a defect for any other. */
export type StoredBlobs = (digest: string) => string;

/**
 * What opening a store moved aside, whole (never read again): a store written
 * before 1.0, or a file SQLite reports damaged or not a database. Null when
 * nothing was moved. The one fact a host presents about it. */
export interface SessionStoreMovedAside {
  readonly path: string;
  readonly aside: string;
  readonly reason: 'pre-1.0' | 'corrupt';
}

/** The store gate's refusal (`storeGate`): the store holds a kind or version
 *  this build does not read, so it is refused whole. */
export class DatabaseStoreNewer extends Schema.TaggedError<DatabaseStoreNewer>()(
  'DatabaseStoreNewer',
  { type: Schema.String, version: Schema.Number },
) {
  override readonly message = `The session store holds ${this.type} rows at version ${this.version}, which this build does not read: a newer build wrote them, or a pre-release of a different format. Update to a newer build, or move the store aside to start a fresh one. Nothing in the store was changed.`;
}

/** A stored row that does not decode as its kind's shape. */
export class DatabaseRowCorrupt extends Schema.TaggedError<DatabaseRowCorrupt>()(
  'DatabaseRowCorrupt',
  { commit: Schema.Number, type: Schema.String, detail: Schema.String },
) {
  override readonly message = `The session store's ${this.type} row at commit ${this.commit} does not decode (${this.detail}).`;
}

/** A row an earlier build wrote below the version this one reads: its run cannot open. */
export class DatabaseRowEarlier extends Schema.TaggedError<DatabaseRowEarlier>()(
  'DatabaseRowEarlier',
  { commit: Schema.Number, type: Schema.String },
) {
  override readonly message = `The session store's ${this.type} row at commit ${this.commit} was written by an earlier build; it can't be opened by this one.`;
}

/**
 * A root's current values (`current_value`): one row per family and key,
 * replaced in place, outside the event history, so an event-format bump
 * leaves them. Every write is one `BEGIN IMMEDIATE`;
 * a value decodes with its family's schema where it is read, and a row that
 * no longer decodes fails that read.
 */
export interface CurrentValues {
  readonly get: <T>(
    family: ValueFamily<T>,
    key: string,
  ) => Effect.Effect<T | undefined, DatabaseReadFailed>;
  /**
   * Change one value from the one read under the write lock: `change`
   * answers with its result and the next value, with its result alone to
   * write nothing, or refuses and nothing is written. A next value of
   * `undefined` deletes the row.
   */
  readonly modify: <T, A, E = never>(
    family: ValueFamily<T>,
    key: string,
    change: (
      current: T | undefined,
    ) => Result.Result<readonly [A] | readonly [A, T | undefined], E>,
  ) => Effect.Effect<A, E | DatabaseWriteFailed>;
  /** Every row of a family, latest write first. */
  readonly list: <T>(
    family: ValueFamily<T>,
  ) => Effect.Effect<
    readonly { readonly key: string; readonly value: T }[],
    DatabaseReadFailed
  >;
  /**
   * Emits as subscribed, then after each value write, by this process or
   * (on the global store) another, that changed one of `keys`' values. A
   * read that fails is logged and retried, so no change is missed.
   */
  readonly changes: (
    family: Pick<ValueFamily<unknown>, 'name'>,
    keys: readonly string[],
  ) => Stream.Stream<void>;
}

/** A root's session is already open over the other store (persistent or
 *  in memory), which it keeps: an open asking for the other is refused. */
export class SessionOptionsConflict extends Schema.TaggedError<SessionOptionsConflict>()(
  'SessionOptionsConflict',
  { storage: Schema.String, message: Schema.String },
) {}

/** Why a session's root could not be opened: its database or its reads
 *  failed, or it is open over the other store. */
export type SessionOpenError =
  | DatabaseOpenFailed
  | DatabaseReadFailed
  | SessionOptionsConflict;

/** A read of committed events. */
export type EventsRead = Effect.Effect<
  readonly SessionRow[],
  DatabaseReadFailed
>;

export class Database extends Context.Service<
  Database,
  {
    /** Set when this open moved a pre-1.0 or damaged store aside. */
    readonly movedAside: SessionStoreMovedAside | null;
    /**
     * Append an ordered batch across aggregates, whole or not at all, in
     * the caller's {@link job} or its own transaction; `seq` and `commit`
     * follow batch order and the writer is this process. A closed target
     * refuses the batch as `DatabaseAggregateClosed`; any other rollback is
     * `DatabaseWriteFailed`.
     */
    readonly appendAll: (
      drafts: readonly WithBlobs<SessionRowDraft>[],
    ) => Effect.Effect<
      readonly SessionRow[],
      DatabaseAggregateClosed | DatabaseWriteFailed
    >;
    /** Run `body` as one write transaction, whole or not at all. It holds
     *  the write lock, so `body` is database-only. */
    readonly job: <A, E>(
      body: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | DatabaseWriteFailed>;
    /** SQLite's committed high-water mark. */
    readonly currentCommit: Effect.Effect<CommitOrdinal, DatabaseReadFailed>;
    /** The display rows a committed batch shows, as a display read of the
     *  same commits returns them (its display rows, each call row as its
     *  tool card, each priced row's `usage` row), from the rows in memory. */
    readonly displayRows: (
      rows: readonly SessionRow[],
    ) => readonly DisplayRow[];
    /** The display rows from `fromCommit`, selected in SQL (a tail decodes
     *  no private row but the call rows it shows as tool cards), a page at a
     *  time; each page is its own snapshot, so a deletion marker a page saw
     *  is delivered regardless. */
    readonly readDisplay: (
      fromCommit: CommitOrdinal,
    ) => Stream.Stream<DisplayRow, DatabaseReadFailed>;
    readonly readListing: () => EventsRead;
    /** The strings under `digests`: media bytes a history names by address. */
    readonly readBlobs: (
      digests: readonly string[],
    ) => Effect.Effect<StoredBlobs, DatabaseReadFailed>;
    /** One open run's record (`recordAfter` over the newest row of each
     *  record kind, which the listing indexes), null for a run never
     *  started or removed. A row of them that does not decode fails it. */
    readonly readRunRecord: (
      id: AggregateId,
    ) => Effect.Effect<RunRows | null, DatabaseReadFailed>;
    readonly inputHistory: GlobalDatabase['Service']['inputHistory'];
    readonly values: GlobalDatabase['Service']['values'];
    /** One aggregate's rows of `types` from `fromSeq` (through `toSeq`, a
     *  fork's cut), read through the `(aggregate, type, seq)` index in seq
     *  order. A row past `toSeq` is never read. */
    readonly readAggregate: (
      id: AggregateId,
      fromSeq: number,
      types: readonly SessionRow['type'][],
      toSeq?: number,
    ) => Effect.Effect<readonly SessionRow[], DatabaseReadFailed>;
    /** One aggregate's display rows in seq order, with the tool cards its
     *  call rows show and the `usage` rows its priced responses project:
     *  what a renderer replays. */
    readonly readDisplayAggregate: (
      id: AggregateId,
      fromSeq: number,
    ) => Effect.Effect<readonly DisplayRow[], DatabaseReadFailed>;
    /** The job that removes a run tree (`SessionEvents.removeRun`): reread
     *  it, refuse one already closed (`DatabaseAggregateClosed`) or started
     *  again since `expectedStartCommit` (`RunChanged`), append the deletion
     *  marker. */
    readonly runRemoval: (
      id: AggregateId,
      expectedStartCommit: CommitOrdinal,
    ) => Effect.Effect<
      readonly SessionRow[],
      DatabaseAggregateClosed | RunChanged | DatabaseWriteFailed
    >;
    /** The deletion markers not collected yet, and one's collection: `cleanup`
     *  removes its run directories, then its closed aggregate, dependents, rows
     *  and orphaned blobs go; a failed cleanup keeps it for the next pass. */
    readonly deletions: {
      readonly pending: () => EventsRead;
      readonly collect: (
        tombstone: Extract<SessionRow, { type: 'run.removed' }>,
        cleanup: (runIds: readonly RunId[]) => Effect.Effect<void, Error>,
      ) => Effect.Effect<void, Error>;
    };
    /** From one snapshot: the display rows above `fromCommit` through
     *  `throughCommit` a session's view reads (every listing kind, and what
     *  every row of the aggregates `ids` shows), the existence of
     *  `checkedIds`, and the runs this build cannot open. */
    readonly readInputBatch: (
      ids: readonly AggregateId[],
      fromCommit: CommitOrdinal,
      throughCommit: CommitOrdinal,
      checkedIds: readonly AggregateId[],
    ) => Effect.Effect<
      {
        readonly events: readonly DisplayRow[];
        readonly state: readonly AggregateState[];
        readonly damaged: readonly UnreadableRun[];
      },
      DatabaseReadFailed
    >;
    readonly aggregateState: (
      ids: readonly AggregateId[],
    ) => Effect.Effect<readonly AggregateState[], DatabaseReadFailed>;
  }
>()('@texra-ai/harness/session/Database') {}

/** The process's one handle on the global storage root, held for the process
 *  runtime's life: every application record of that root (settings, inquiry
 *  threads, the update check, input history, remembered projects) goes through
 *  it, so its `data_version` poll is forked once and no single-row read opens
 *  a connection. Current values and input history only: no event rows. */
export class GlobalDatabase extends Context.Service<
  GlobalDatabase,
  {
    /** The bounded CLI input rows, oldest first, and a new last one. */
    readonly inputHistory: {
      readonly read: Effect.Effect<
        readonly InputHistoryRecord[],
        DatabaseReadFailed
      >;
      readonly append: (
        record: InputHistoryRecord,
      ) => Effect.Effect<void, DatabaseWriteFailed>;
    };
    /** The root's current values: application state, not history. */
    readonly values: CurrentValues;
  }
>()('@texra-ai/harness/session/GlobalDatabase') {}

/** Persistent project connections, retained by project and session scopes
 *  until the last borrower releases one (never an ephemeral in-memory one). */
export class ProjectDatabases extends Context.Service<
  ProjectDatabases,
  RcMap.RcMap<string, Database['Service'], DatabaseOpenFailed>
>()('@texra-ai/harness/session/ProjectDatabases') {}
