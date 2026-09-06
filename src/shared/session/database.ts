/** The root-scoped event store contract. SQLite and its resource lifetime belong to the controller layer. */
import { Context, Data, type Effect, type SubscriptionRef } from 'effect';
import { z } from 'zod';
import { AggregateIdSchema, OwnerIdSchema } from '@shared/schemas';
import type {
  AggregateId,
  CommitOrdinal,
  SessionEvent,
  SessionEventDraft,
} from '@shared/schemas';

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

/** A query failed or encountered an invalid persisted row. */
export class DatabaseReadFailed extends Data.TaggedError('DatabaseReadFailed')<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export class Database extends Context.Service<
  Database,
  {
    /**
     * C6: append an ordered batch, possibly across several aggregates, in one
     * `BEGIN IMMEDIATE` under the process's single permit. Each target's
     * `seq` and the database-wide `commit` are assigned in batch order, the
     * writer is this process (C5, derived here, never supplied by a caller),
     * and a failure of any member rolls back every member and every sequence
     * change. Returns the complete committed batch, which is what the fold
     * reads before exposing the state it produced.
     */
    readonly appendAll: (
      drafts: readonly SessionEventDraft[],
    ) => Effect.Effect<readonly SessionEvent[], DatabaseWriteFailed>;
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
    readonly readAggregate: (
      id: AggregateId,
      fromSeq: number,
    ) => Effect.Effect<readonly SessionEvent[], DatabaseReadFailed>;
    readonly aggregatesAfterCommit: (
      ids: readonly AggregateId[],
      afterCommit: CommitOrdinal,
      throughCommit?: CommitOrdinal,
    ) => Effect.Effect<readonly SessionEvent[], DatabaseReadFailed>;
    /** Atomically acquire existing, open aggregates after proving prior owners dead. */
    readonly acquireClaims: (
      ids: readonly AggregateId[],
    ) => Effect.Effect<void, DatabaseReadFailed | DatabaseWriteFailed>;
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
