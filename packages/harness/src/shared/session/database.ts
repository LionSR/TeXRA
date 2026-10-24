/**
 * The root-scoped event store contract; SQLite and its lifetime belong to
 * the controller layer. Each storage error has one outcome (README
 * "Storage failures"):
 * - `DatabaseOpenFailed`: the session does not open.
 * - `DatabaseReadFailed`: the call that read fails. A run whose own row is
 *   `DatabaseRowCorrupt` or `DatabaseRowEarlier` is unreadable, never resumed.
 * - `DatabaseWriteFailed`: nothing written; a run ends (`findStorageRefusal`).
 * - `DatabaseStoreNewer`, the cause of any of these: the store is refused whole.
 * - `DatabaseNotOwner` and `DatabaseClaimRefused`, never wrapped:
 *   nothing written; a run that lost its own claim stops, and one another
 *   process holds is refused as held elsewhere ({@link heldElsewhereBy}).
 */
import {
  Context,
  Data,
  type Effect,
  type SubscriptionRef,
  type Result,
  type RcMap,
  type Stream,
} from 'effect';
import { isSqlError } from 'effect/sql/SqlError';
import { z } from 'zod';
import { AggregateIdSchema, OwnerIdSchema } from '@shared/schemas';
import type {
  AggregateId,
  CommitOrdinal,
  DisplaySessionEvent,
  RunId,
  OwnerId,
  OwnerLiveness,
  SessionEvent,
  SessionEventDraft,
  LocalRuntimeState,
} from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { WithBlobs } from './historyTurns';
import type { ValueFamily } from './valueFamily';

/** Current CLI history rows, ordered oldest first. */
export const InputHistoryRecordSchema = z.object({
  at: z.number(),
  value: z.string(),
});
export type InputHistoryRecord = z.infer<typeof InputHistoryRecordSchema>;
export const INPUT_HISTORY_LIMIT = 1000;

/** Only an explicit single-run deletion may replace an unprovable owner. */
export const DeletionModeSchema = z.enum(['single', 'bulk', 'automatic']);
export type DeletionMode = z.infer<typeof DeletionModeSchema>;

/** The current claim and existence, independent of historical event writers. */
export const AggregateStateSchema = z.object({
  aggregateId: AggregateIdSchema,
  /** The incarnation's durable identity, minted with its first row. */
  uid: z.uuid(),
  ownerId: OwnerIdSchema.nullable(),
  closed: z
    .union([z.literal(0), z.literal(1)])
    .transform((value) => value === 1),
  parentId: AggregateIdSchema.nullable(),
  startCommit: z.int().positive().nullable(),
});
export type AggregateState = z.infer<typeof AggregateStateSchema>;

/**
 * The current claim on one aggregate, its owner's liveness proved in the same
 * call (`self` is this process; a null owner is unclaimed or absent): what a
 * resume gate and the run listing ask, never the fold, whose prober watches
 * only owners of runs already resident in the view. */
export interface AggregateClaim {
  readonly ownerId: OwnerId | null;
  readonly liveness: OwnerLiveness | 'self' | null;
}

/**
 * Who holds a claim relative to this process: itself, an owner alive or not
 * proven dead, or nobody (a provably dead owner frees it). The one reading the
 * run listing, the run classification and the resume gate all share.
 */
type ClaimStanding =
  | { readonly kind: 'self' }
  | { readonly kind: 'held'; readonly owner: OwnerId }
  | { readonly kind: 'free' };

export function claimStanding(claim: AggregateClaim): ClaimStanding {
  if (claim.liveness === 'self') return { kind: 'self' };
  if (claim.ownerId !== null && claim.liveness !== 'dead')
    return { kind: 'held', owner: claim.ownerId };
  return { kind: 'free' };
}

/** A store failure's text: a `SqlError`'s generic message, and the SQLite
 *  error that says why (`database is locked`), its reason's cause. */
const storeFailureMessage = (cause: unknown): string =>
  isSqlError(cause) && cause.reason.cause != null
    ? `${cause.message}: ${toErrorMessage(cause.reason.cause)}`
    : toErrorMessage(cause);

/** The database could not be opened, or its schema could not be applied. */
export class DatabaseOpenFailed extends Data.TaggedError('DatabaseOpenFailed')<{
  readonly path: string;
  readonly cause: unknown;
}> {
  override readonly message = storeFailureMessage(this.cause);
}

/** A batch was rejected whole: no member, sequence or wake level moved. */
export class DatabaseWriteFailed extends Data.TaggedError(
  'DatabaseWriteFailed',
)<{
  readonly path: string;
  readonly cause: unknown;
}> {
  override readonly message = storeFailureMessage(this.cause);
}

/** A batch member targets an aggregate this process does not hold open;
 *  nothing was written. Ownership, not the disk, so it is never wrapped in
 *  `DatabaseWriteFailed`. */
export class DatabaseNotOwner extends Data.TaggedError('DatabaseNotOwner')<{
  readonly aggregateId: AggregateId;
  /** The holder and closure at refusal time, read in the refusing transaction. */
  readonly ownerId: OwnerId | null;
  readonly closed: boolean;
}> {
  override readonly message = `${this.aggregateId} is ${this.closed ? 'closed' : `held by ${this.ownerId ?? 'no process'}, not this one`}; nothing was written.`;
}

/** A claim the deletion policy refuses: its owner is alive, or unproven dead. */
export class DatabaseClaimRefused extends Data.TaggedError(
  'DatabaseClaimRefused',
)<{
  readonly ownerId: OwnerId;
  readonly verdict: 'alive' | 'unprovable';
}> {
  override readonly message = `Another process (${this.ownerId}) ${this.verdict === 'alive' ? 'holds this run.' : 'may hold this run: it could not be proven to have exited.'}`;
}

/** A claiming transaction's refusals: the claim's, a writer's, or the write. */
export type DatabaseClaimError =
  DatabaseNotOwner | DatabaseClaimRefused | DatabaseWriteFailed;

/** The owner a claim refusal or a `DatabaseNotOwner` of an open aggregate
 *  names (not proven alive); null for a closed or ownerless one. */
export const heldElsewhereBy = (error: unknown): OwnerId | null => {
  if (error instanceof DatabaseClaimRefused) return error.ownerId;
  return error instanceof DatabaseNotOwner && !error.closed
    ? error.ownerId
    : null;
};

/** A query failed or encountered an invalid persisted row. */
export class DatabaseReadFailed extends Data.TaggedError('DatabaseReadFailed')<{
  readonly path: string;
  readonly cause: unknown;
}> {
  override readonly message = storeFailureMessage(this.cause);
}

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
export class DatabaseStoreNewer extends Data.TaggedError('DatabaseStoreNewer')<{
  readonly type: string;
  readonly version: number;
}> {
  override readonly message = `The session store holds ${this.type} rows at version ${this.version}, which this build does not read: a newer build wrote them, or a pre-release of a different format. Update to a newer build, or move the store aside to start a fresh one. Nothing in the store was changed.`;
}

/** A stored row that does not decode as its kind's shape. */
export class DatabaseRowCorrupt extends Data.TaggedError('DatabaseRowCorrupt')<{
  readonly commit: number;
  readonly type: string;
  readonly detail: string;
}> {
  override readonly message = `The session store's ${this.type} row at commit ${this.commit} does not decode (${this.detail}).`;
}

/** A row an earlier build wrote below the version this one reads: its run cannot open. */
export class DatabaseRowEarlier extends Data.TaggedError('DatabaseRowEarlier')<{
  readonly commit: number;
  readonly type: string;
}> {
  override readonly message = `The session store's ${this.type} row at commit ${this.commit} was written by an earlier build; it can't be opened by this one.`;
}

/**
 * A root's current values (`current_value`): one row per family and key,
 * replaced in place, outside the event history, so an event-format bump
 * leaves them. Every write is one `BEGIN IMMEDIATE` with no aggregate claim;
 * a value decodes with its family's schema where it is read, and a row that
 * no longer decodes fails that read.
 */
export interface CurrentValues {
  readonly get: <T, D extends boolean>(
    family: ValueFamily<T, D>,
    key: string,
  ) => Effect.Effect<T | undefined, DatabaseReadFailed>;
  /**
   * Change one value from the one read under the write lock: `change`
   * answers with its result and the next value, with its result alone to
   * write nothing, or refuses and nothing is written. Only a deletable
   * family's change may answer `undefined`, which deletes the row.
   */
  readonly modify: <T, D extends boolean, A, E = never>(
    family: ValueFamily<T, D>,
    key: string,
    change: (
      current: T | undefined,
    ) => Result.Result<
      readonly [A] | readonly [A, D extends true ? T | undefined : T],
      E
    >,
  ) => Effect.Effect<A, E | DatabaseWriteFailed>;
  /** Every row of a family, latest write first. */
  readonly list: <T, D extends boolean>(
    family: ValueFamily<T, D>,
  ) => Effect.Effect<
    readonly { readonly key: string; readonly value: T }[],
    DatabaseReadFailed
  >;
  /**
   * Emits as subscribed, then after each commit, by this process or
   * another, that changed one of `keys`' values: the root's wake level
   * narrowed inside the store to those rows. A read that fails is logged and
   * retried, so no change is missed.
   */
  readonly changes: (
    family: Pick<ValueFamily<unknown, boolean>, 'name'>,
    keys: readonly string[],
  ) => Stream.Stream<void>;
}

/** A root's session is already open over the other store (persistent or
 *  in memory), which it keeps: an open asking for the other is refused. */
export class SessionOptionsConflict extends Data.TaggedError(
  'SessionOptionsConflict',
)<{
  readonly storage: string;
  readonly message: string;
}> {}

/** Why a session's root could not be opened: its database or its reads
 *  failed, or it is open over the other store. */
export type SessionOpenError =
  DatabaseOpenFailed | DatabaseReadFailed | SessionOptionsConflict;

/** A read of committed events. */
export type EventsRead = Effect.Effect<
  readonly SessionEvent[],
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
     * follow batch order and the writer is this process. A target this
     * process does not hold open refuses the batch as `DatabaseNotOwner`;
     * any other rollback is `DatabaseWriteFailed`.
     */
    readonly appendAll: (
      drafts: readonly WithBlobs<SessionEventDraft>[],
    ) => Effect.Effect<
      readonly SessionEvent[],
      DatabaseNotOwner | DatabaseWriteFailed
    >;
    /** Run `body` as one write transaction behind the store gate, whole or
     *  not at all; readers wake after. It holds the write lock, so `body` is
     *  database-only and may run again whole (a busy lock; claim owners
     *  proven off the lock); `afterCommit` actions run after. */
    readonly job: <A, E>(
      body: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | DatabaseWriteFailed>;
    /** Replaying wake counter. Local commits and foreign data-version changes
     *  advance it; it is never interpreted as an event ordinal. */
    readonly level: SubscriptionRef.SubscriptionRef<number>;
    /** SQLite's committed high-water mark, which need not equal the wake level. */
    readonly currentCommit: Effect.Effect<CommitOrdinal, DatabaseReadFailed>;
    /** Last committed ordinal observed by this connection, for synchronous drain anchors. */
    readonly observedCommit: SubscriptionRef.SubscriptionRef<CommitOrdinal>;
    /** The display rows from `fromCommit`, filtered in SQL (a tail never
     *  decodes private records to drop them), a page at a time; each page is
     *  its own snapshot, so a tombstone a page saw is delivered regardless. */
    readonly readDisplay: (
      fromCommit: CommitOrdinal,
    ) => Stream.Stream<DisplaySessionEvent, DatabaseReadFailed>;
    readonly readListing: () => EventsRead;
    /** The strings under `digests`: media bytes a history names by address. */
    readonly readBlobs: (
      digests: readonly string[],
    ) => Effect.Effect<ReadonlyMap<string, string>, DatabaseReadFailed>;
    /** The latest listing row of each type on one open run: its private
     *  records beside its creation, status and tombstone. */
    readonly readRunRecords: (id: AggregateId) => EventsRead;
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
    /** One aggregate's rows from `fromSeq`, or only those of `types`
     *  through the `(aggregate, type, seq)` index, in seq order. */
    readonly readAggregate: (
      id: AggregateId,
      fromSeq: number,
      types?: readonly SessionEvent['type'][],
    ) => Effect.Effect<readonly SessionEvent[], DatabaseReadFailed>;
    /** One aggregate's display rows in seq order, with the `usage` rows its
     *  priced responses project: what a renderer replays. */
    readonly readDisplayAggregate: (
      id: AggregateId,
      fromSeq: number,
    ) => Effect.Effect<readonly DisplaySessionEvent[], DatabaseReadFailed>;
    /** Who holds one aggregate right now, its owner's liveness proved in
     *  this call: the one ownership read fresh by construction, so a cold
     *  run's long-dead owner is never reported held. An absent or tombstoned
     *  aggregate is unclaimed: a closed row keeps who closed it, with nothing
     *  left to hold. */
    readonly claimOwner: (
      id: AggregateId,
    ) => Effect.Effect<AggregateClaim, DatabaseReadFailed>;
    /** Atomically acquire existing, open aggregates whose prior owners are
     *  proven dead (off the lock, {@link job}), in the caller's transaction
     *  when it has one. */
    readonly acquireClaims: (
      ids: readonly AggregateId[],
    ) => Effect.Effect<
      readonly AggregateId[],
      DatabaseReadFailed | DatabaseClaimError
    >;
    /** Prove the tree's owners off the publisher, then answer its job
     *  (`SessionEvents.removeRun`): reread, claim, append the tombstone. */
    readonly prepareRunRemoval: (
      id: AggregateId,
      mode: DeletionMode,
      expectedStartCommit: CommitOrdinal,
    ) => Effect.Effect<
      Effect.Effect<readonly SessionEvent[], DatabaseClaimError>,
      DatabaseReadFailed | DatabaseWriteFailed
    >;
    /** The tombstones not collected yet, and one's collection: `cleanup`
     *  removes its run directories, then its closed aggregate, dependents, rows
     *  and orphaned blobs go; a failed cleanup keeps it for the next pass. */
    readonly deletions: {
      readonly pending: () => EventsRead;
      readonly collect: (
        tombstone: Extract<SessionEvent, { type: 'run.removed' }>,
        cleanup: (runIds: readonly RunId[]) => Effect.Effect<void, Error>,
      ) => Effect.Effect<void, Error>;
    };
    /** Clear only this process's claims, in one transaction. */
    readonly releaseClaims: (
      ids: readonly AggregateId[],
    ) => Effect.Effect<void, DatabaseWriteFailed>;
    /** The event prefix, current claims and damaged runs from one read. */
    readonly readInputBatch: (
      ids: readonly AggregateId[],
      fromCommit: CommitOrdinal,
      checkedIds?: readonly AggregateId[],
    ) => Effect.Effect<
      {
        readonly cursor: CommitOrdinal;
        readonly events: readonly SessionEvent[];
        readonly checkedAggregateIds: readonly AggregateId[];
        readonly state: readonly AggregateState[];
        readonly damaged: LocalRuntimeState['unreadable'];
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
  Pick<Context.Service.Shape<typeof Database>, 'values' | 'inputHistory'>
>()('@texra-ai/harness/session/GlobalDatabase') {}

/** Persistent project connections, retained by project and session scopes
 *  until the last borrower releases one (never an ephemeral in-memory one). */
export class ProjectDatabases extends Context.Service<
  ProjectDatabases,
  RcMap.RcMap<string, Database['Service'], DatabaseOpenFailed>
>()('@texra-ai/harness/session/ProjectDatabases') {}
