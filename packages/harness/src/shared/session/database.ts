/** The root-scoped event store contract. SQLite and its resource lifetime belong to the controller layer. */
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
import type { ValueFamily } from './valueFamily';

/** Current CLI history rows, ordered oldest first. */
export const InputHistoryRecordSchema = z.object({
  at: z.number(),
  value: z.string(),
});
export type InputHistoryRecord = z.infer<typeof InputHistoryRecordSchema>;
export const INPUT_HISTORY_LIMIT = 1000;
export const INPUT_HISTORY_LINE_LIMIT = 4000;

/** Only an explicit single-run deletion may replace an unprovable owner. */
export const DeletionModeSchema = z.enum(['single', 'bulk', 'automatic']);
export type DeletionMode = z.infer<typeof DeletionModeSchema>;

/** C7's current claim and existence, independent of historical event writers. */
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
 * C5's current claim on one aggregate, its owner's liveness proved in the same
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

/**
 * A store failure's text. A `SqlError`'s own message is the driver's generic
 * `Failed to execute statement`; the SQLite error that says why (`column
 * index out of range`, `database is locked`) is its reason's cause, so the
 * message carries both.
 */
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

/**
 * A batch was rejected. C6 is all-or-nothing: the transaction rolled back, so
 * no member and no sequence change survives, and the wake level did not move.
 */
export class DatabaseWriteFailed extends Data.TaggedError(
  'DatabaseWriteFailed',
)<{
  readonly path: string;
  readonly cause: unknown;
}> {
  override readonly message = storeFailureMessage(this.cause);
}

/**
 * C5: a batch member targets an aggregate this process does not hold open (the
 * claim moved, was never held, or the aggregate closed); nothing was written.
 * A fact about ownership, not the disk, so `appendAll` fails with it typed,
 * not wrapped in `DatabaseWriteFailed` (D6 b): a caller that lost its claim
 * stops, never mistaking a disk error for a stolen claim or the reverse. */
export class DatabaseNotOwner extends Data.TaggedError('DatabaseNotOwner')<{
  readonly aggregateId: AggregateId;
  /** The holder and closure at refusal time, read in the refusing transaction. */
  readonly ownerId: OwnerId | null;
  readonly closed: boolean;
}> {}

/** A claim cannot be acquired under the requested deletion policy. */
export class DatabaseClaimRefused extends Data.TaggedError(
  'DatabaseClaimRefused',
)<{
  readonly ownerId: OwnerId;
  readonly verdict: 'alive' | 'unprovable';
}> {}

/**
 * The owner a refusal names as holding an aggregate (not proven alive: a
 * verdict may be `unprovable`), from a claim verdict (a write failure's cause)
 * or a `DatabaseNotOwner` of an open aggregate; null otherwise, since a closed
 * aggregate is finished and an ownerless one is free. */
export const heldElsewhereBy = (error: unknown): OwnerId | null => {
  const refusal = error instanceof DatabaseWriteFailed ? error.cause : error;
  if (refusal instanceof DatabaseClaimRefused) return refusal.ownerId;
  return refusal instanceof DatabaseNotOwner && !refusal.closed
    ? refusal.ownerId
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

/**
 * The store gate's refusal (`storeGate`): the store holds a kind or version
 * this build does not read (a newer TeXRA, or a pre-release of another
 * format, wrote it). The store is refused whole, never read in part or
 * written beside; it rides as the cause of the open, read or write failure.
 */
export class DatabaseStoreNewer extends Data.TaggedError('DatabaseStoreNewer')<{
  readonly type: string;
  readonly version: number;
}> {
  override readonly message = `The session store holds ${this.type} rows at version ${this.version}, which this build does not read: a newer TeXRA wrote them, or a pre-release of a different format. Update TeXRA, or move the store aside to start a fresh one. Nothing in the store was changed.`;
}

/** A stored row that does not decode as its kind's shape: its read fails,
 *  naming the row, as the cause of the `DatabaseReadFailed`. */
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
  override readonly message = `The session store's ${this.type} row at commit ${this.commit} was written by an earlier build of TeXRA; it can't be opened by this one.`;
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

/** Why a session's root could not be opened: its database would not open,
 *  or the reads the session is built from failed. */
export type SessionOpenError = DatabaseOpenFailed | DatabaseReadFailed;

export class Database extends Context.Service<
  Database,
  {
    /** Set when this open moved a pre-1.0 or damaged store aside. */
    readonly movedAside: SessionStoreMovedAside | null;
    /**
     * C6: append an ordered batch, possibly across several aggregates, whole
     * or not at all, in the caller's {@link job} or a transaction of its
     * own. `seq` and `commit` are assigned in batch order and the writer is
     * this process (C5, never a caller's). A target this process does not
     * hold open refuses the batch as `DatabaseNotOwner`; every other
     * rollback is `DatabaseWriteFailed`.
     */
    readonly appendAll: (
      drafts: readonly SessionEventDraft[],
    ) => Effect.Effect<
      readonly SessionEvent[],
      DatabaseNotOwner | DatabaseWriteFailed
    >;
    /** Run `body` as one write transaction behind the store gate: what it
     *  writes commits together or not at all, readers wake after. It holds
     *  the write lock, so `body` is database-only, forks nothing that
     *  outlives it, and may run again whole (a busy lock; claim owners
     *  proven off the lock). Its failures leave typed. */
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
    /** Finite event prefix, inclusive at its captured upper bound. */
    readonly readAll: (
      fromCommit: CommitOrdinal,
      throughCommit?: CommitOrdinal,
    ) => Effect.Effect<readonly SessionEvent[], DatabaseReadFailed>;
    /** {@link readAll} filtered to display types in SQL: a tail never decodes
     *  a run's private records only to drop them. Read a page at a time, so
     *  a long history is never held whole; each page is its own snapshot,
     *  so a tombstone one page saw is still delivered when its run is
     *  collected before the page that holds it. */
    readonly readDisplay: (
      fromCommit: CommitOrdinal,
    ) => Stream.Stream<DisplaySessionEvent, DatabaseReadFailed>;
    readonly readListing: () => Effect.Effect<
      readonly SessionEvent[],
      DatabaseReadFailed
    >;
    /** The latest listing row of each type on one open run: its private
     *  records beside its creation, status and tombstone. */
    readonly readRunRecords: (
      id: AggregateId,
    ) => Effect.Effect<readonly SessionEvent[], DatabaseReadFailed>;
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
    /** C5: who holds one aggregate right now, with its owner's liveness
     *  proved in this call. The one ownership read that is fresh by
     *  construction, so a cold run's long-dead owner is never reported held.
     *  An absent or tombstoned aggregate is unclaimed: a closed row keeps the
     *  owner that closed it, and there is nothing left for it to hold. */
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
      DatabaseNotOwner | DatabaseReadFailed | DatabaseWriteFailed
    >;
    /** C9, as one publisher job (`SessionEvents.removeRun`): claim the
     *  owning tree once its owners are proven reclaimable, append the
     *  tombstone, close every dependent; `expectedStartCommit` is the
     *  lifetime the caller admitted. */
    readonly appendRunRemoval: (
      id: AggregateId,
      mode: DeletionMode,
      expectedStartCommit: CommitOrdinal,
    ) => Effect.Effect<readonly SessionEvent[], DatabaseWriteFailed>;
    /** C9: the `run.removed` tombstones cleanup has not collected. */
    readonly readPendingDeletions: () => Effect.Effect<
      readonly SessionEvent[],
      DatabaseReadFailed
    >;
    /** C9: `cleanup` removes a tombstone's run directories, then its closed
     *  aggregate, dependents, rows and orphaned blobs go. Every step may run
     *  twice; a failed cleanup keeps the tombstone for the next pass. */
    readonly collectDeletion: (
      tombstone: Extract<SessionEvent, { type: 'run.removed' }>,
      cleanup: (runIds: readonly RunId[]) => Effect.Effect<void, Error>,
    ) => Effect.Effect<void, Error>;
    /** Clear only this process's claims, in one transaction. */
    readonly releaseClaims: (
      ids: readonly AggregateId[],
    ) => Effect.Effect<void, DatabaseWriteFailed>;
    /** C7's event prefix, current claims and damaged runs from one read. */
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
>()('@texra/session/Database') {}

/**
 * The process's one handle on the global storage root, built beside
 * `GlobalStorageFs` by the entry that installs the process runtime and held
 * for that runtime's life. Every application record of that root — the
 * settings, the repository settings, the inquiry threads, the update check,
 * the CLI's input history, the desktop's remembered projects — reads and
 * writes through it, so the root's `data_version` poll is forked once per
 * process instead of once per operation, and the connection is neither
 * opened nor torn down on a single-row read. The per-workspace
 * {@link Database} of a session's root is unchanged and unrelated.
 *
 * The shape is that handle's current values and input history, and nothing
 * else: the global root holds no session and no event rows, so its event
 * reads, claims and moved-aside report have no reader here. What does follow this root is a
 * reader of named settings (the tool switches, the plugin install record),
 * which `values.changes` serves already narrowed to them.
 */
export class GlobalDatabase extends Context.Service<
  GlobalDatabase,
  Pick<Context.Service.Shape<typeof Database>, 'values' | 'inputHistory'>
>()('@texra/session/GlobalDatabase') {}

/** Persistent project connections, retained by project and session scopes.
 *  The last borrower releases the connection; an ephemeral transcript never
 *  substitutes its in-memory database for this persistent application state. */
export class ProjectDatabases extends Context.Service<
  ProjectDatabases,
  RcMap.RcMap<string, Database['Service'], DatabaseOpenFailed>
>()('@texra/session/ProjectDatabases') {}
