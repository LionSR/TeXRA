/** The root-scoped event store contract. SQLite and its resource lifetime belong to the controller layer. */
import {
  Context,
  Data,
  type Effect,
  type SubscriptionRef,
  type Result,
} from 'effect';
import { z } from 'zod';
import { AggregateIdSchema, OwnerIdSchema } from '@shared/schemas';
import type {
  AggregateId,
  JsonValue,
  CommitOrdinal,
  RunId,
  OwnerId,
  OwnerLiveness,
  SessionEvent,
  SessionEventDraft,
  InquiryThreadRecord,
  InquiryThreadId,
  UpdateCheckHost,
  UpdateCheckRecord,
  UpdateCheckChange,
} from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

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
  ownerId: OwnerIdSchema.nullable(),
  closed: z
    .union([z.literal(0), z.literal(1)])
    .transform((value) => value === 1),
  parentId: AggregateIdSchema.nullable(),
  startCommit: z.int().positive().nullable(),
});
export type AggregateState = z.infer<typeof AggregateStateSchema>;

/**
 * C5's current claim on one aggregate, with the liveness of its owner proved
 * in the same call: `self` is this process, and a null owner (with a null
 * verdict) is an unclaimed or absent aggregate. The read a resume gate and
 * the run listing ask, never the fold, whose liveness comes from a prober
 * that only watches owners of runs already resident in the view.
 */
export interface AggregateClaim {
  readonly ownerId: OwnerId | null;
  readonly liveness: OwnerLiveness | 'self' | null;
}

/**
 * Who holds a claim relative to this process: this process itself, an owner
 * that is alive or cannot be proven dead, or nobody. The one derivation every
 * ladder that reads a claim shares — the run listing, the run
 * classification, and the resume gate all answer the same question of the
 * same two fields, and a run whose owner is provably dead is free.
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

/** The database could not be opened, or its schema could not be applied. */
export class DatabaseOpenFailed extends Data.TaggedError('DatabaseOpenFailed')<{
  readonly path: string;
  readonly cause: unknown;
}> {}

/**
 * A batch was rejected. C6 is all-or-nothing: the transaction rolled back, so
 * no member and no sequence change survives, and the wake level did not move.
 */
export class DatabaseWriteFailed extends Data.TaggedError(
  'DatabaseWriteFailed',
)<{
  readonly path: string;
  readonly cause: unknown;
}> {}

/**
 * C5: a batch member targets an aggregate this process does not hold open,
 * because the claim moved, was never held, or the aggregate closed. Nothing
 * was written. The one write refusal that is a fact about ownership rather
 * than the disk, which is why `appendAll` fails with it typed instead of
 * wrapped in `DatabaseWriteFailed` (D6 b): a caller that lost its claim
 * stops, and never mistakes a disk error for a stolen claim or the reverse.
 */
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

/** A query failed or encountered an invalid persisted row. */
export class DatabaseReadFailed extends Data.TaggedError('DatabaseReadFailed')<{
  readonly path: string;
  readonly cause: unknown;
}> {
  override readonly message = toErrorMessage(this.cause);
}

/** Why a session's root could not be opened: its database would not open,
 *  or the reads the session is built from failed. */
export type SessionOpenError = DatabaseOpenFailed | DatabaseReadFailed;

/**
 * What opening a store of another event format left behind: the file, the
 * rows it held, and the format they were written under. Null when the store
 * was this build's or empty. The one fact a host presents about it; the
 * database keeps no other memory of the rows.
 */
export interface SessionStoreCleared {
  readonly path: string;
  readonly rows: number;
  readonly storedFormat: number;
}

export class Database extends Context.Service<
  Database,
  {
    /** Set when this open cleared a store of another event format. */
    readonly cleared: SessionStoreCleared | null;
    /**
     * C6: append an ordered batch, possibly across several aggregates, in one
     * `BEGIN IMMEDIATE` under the process's single permit. Each target's
     * `seq` and the database-wide `commit` are assigned in batch order, the
     * writer is this process (C5, derived here, never supplied by a caller),
     * and a failure of any member rolls back every member and every sequence
     * change. Returns the complete committed batch, which is what the fold
     * reads before exposing the state it produced. A target this process
     * does not hold open refuses the batch as `DatabaseNotOwner`; every
     * other rollback is `DatabaseWriteFailed`.
     */
    readonly appendAll: (
      drafts: readonly SessionEventDraft[],
    ) => Effect.Effect<
      readonly SessionEvent[],
      DatabaseNotOwner | DatabaseWriteFailed
    >;
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
    readonly readListing: () => Effect.Effect<
      readonly SessionEvent[],
      DatabaseReadFailed
    >;
    /** The latest listing row of each type on one open run: its private
     *  records beside its creation, status and tombstone. */
    readonly readRunRecords: (
      id: AggregateId,
    ) => Effect.Effect<readonly SessionEvent[], DatabaseReadFailed>;
    /** The latest `flow.snapshot` on one open run, through the
     *  `(aggregate_id, type, seq)` index: the run ledger's existence and
     *  coordinates read, never a fold. A closed (tombstoned) run reads as
     *  absent, as `readRunRecords` does. */
    readonly readRunSnapshot: (
      id: AggregateId,
    ) => Effect.Effect<
      Extract<SessionEvent, { type: 'flow.snapshot' }> | null,
      DatabaseReadFailed
    >;
    /** Direct child creation edges and their labels from one captured prefix. */
    readonly readRunChildren: (
      id: AggregateId,
    ) => Effect.Effect<readonly SessionEvent[], DatabaseReadFailed>;
    /** Bounded current CLI input rows, ordered oldest first. */
    readonly readInputHistory: () => Effect.Effect<
      readonly InputHistoryRecord[],
      DatabaseReadFailed
    >;
    readonly appendInputHistory: (
      record: InputHistoryRecord,
    ) => Effect.Effect<void, DatabaseWriteFailed>;
    /** Latest desktop profile record, selected directly by its aggregate index. */
    readonly readDesktopProjects: (
      id: AggregateId,
    ) => Effect.Effect<SessionEvent | undefined, DatabaseReadFailed>;
    /**
     * Every application-state key's latest value in this root, as one map:
     * the whole store's open-time snapshot in one query, keyed by the state
     * key its aggregate is named for. A key whose latest row is the delete is
     * absent from the map.
     */
    readonly readAppState: () => Effect.Effect<
      ReadonlyMap<string, JsonValue>,
      DatabaseReadFailed
    >;
    readonly readUpdateCheck: (
      host: UpdateCheckHost,
    ) => Effect.Effect<UpdateCheckRecord | null, DatabaseReadFailed>;
    readonly recordUpdateCheck: (
      host: UpdateCheckHost,
      change: UpdateCheckChange,
    ) => Effect.Effect<void, DatabaseWriteFailed>;
    /** Canonical global inquiry content, never a project display projection. */
    readonly readInquiryRecord: (
      id: InquiryThreadId,
    ) => Effect.Effect<InquiryThreadRecord | null, DatabaseReadFailed>;
    readonly listInquiryRecords: () => Effect.Effect<
      readonly InquiryThreadRecord[],
      DatabaseReadFailed
    >;
    /** Validate and change a global thread while its SQL write transaction is held. */
    readonly updateInquiryRecord: <A extends InquiryThreadRecord | null>(
      id: InquiryThreadId,
      change: (current: InquiryThreadRecord | null) => Result.Result<A, Error>,
    ) => Effect.Effect<Result.Result<A, Error>, DatabaseWriteFailed>;
    readonly readAggregate: (
      id: AggregateId,
      fromSeq: number,
    ) => Effect.Effect<readonly SessionEvent[], DatabaseReadFailed>;
    /** C5: who holds one aggregate right now, with its owner's liveness
     *  proved in this call. The one ownership read that is fresh by
     *  construction, so a cold run's long-dead owner is never reported held.
     *  An absent or tombstoned aggregate is unclaimed: a closed row keeps the
     *  owner that closed it, and there is nothing left for it to hold. */
    readonly claimOwner: (
      id: AggregateId,
    ) => Effect.Effect<AggregateClaim, DatabaseReadFailed>;
    /** Atomically acquire existing, open aggregates after proving prior owners dead. */
    readonly acquireClaims: (
      ids: readonly AggregateId[],
    ) => Effect.Effect<
      readonly AggregateId[],
      DatabaseReadFailed | DatabaseWriteFailed
    >;
    /** C9: recheck the owning tree, acquire its claims, append the tombstone
     *  and close all dependents in one transaction after liveness proofs.
     *  The recorded start identifies the lifetime admitted by the caller. */
    readonly removeRun: (
      id: AggregateId,
      mode: DeletionMode,
      expectedStartCommit: CommitOrdinal,
    ) => Effect.Effect<
      readonly SessionEvent[],
      DatabaseReadFailed | DatabaseWriteFailed
    >;
    /** C9: claim a closed root, clean its recorded runs, then cascade
     *  only if the same tombstone and claim still hold. Cleanup failure keeps
     *  the deletion record. The callback runs outside the SQLite transaction. */
    readonly collectDeletion: (
      id: AggregateId,
      tombstoneCommit: CommitOrdinal,
      cleanup: (runIds: readonly RunId[]) => Effect.Effect<void, Error>,
    ) => Effect.Effect<void, Error>;
    /** Clear only this process's claims, in one transaction. */
    readonly releaseClaims: (
      ids: readonly AggregateId[],
    ) => Effect.Effect<void, DatabaseWriteFailed>;
    /** C7's event prefix and current claims from the same read transaction. */
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
 * inquiry threads, the update check, the CLI's input history, the desktop's
 * remembered projects — reads and writes through it, so the root's
 * `data_version` poll is forked once per process instead of once per
 * operation, and the connection is neither opened nor torn down on a
 * single-row read. The per-workspace {@link Database} of a session's root is
 * unchanged and unrelated.
 *
 * The shape is that handle's application-record surface and nothing else:
 * the global root holds no session, so its reactive members (`level`,
 * `observedCommit`, `cleared`) and the run-ledger reads over them have no
 * reader here, and a tag that offered them would invite one.
 */
export class GlobalDatabase extends Context.Service<
  GlobalDatabase,
  Pick<
    Context.Service.Shape<typeof Database>,
    | 'appendAll'
    | 'readInputHistory'
    | 'appendInputHistory'
    | 'readDesktopProjects'
    | 'readUpdateCheck'
    | 'recordUpdateCheck'
    | 'readInquiryRecord'
    | 'listInquiryRecords'
    | 'updateInquiryRecord'
  >
>()('@texra/session/GlobalDatabase') {}
