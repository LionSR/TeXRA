/**
 * The fold's transient input arms (.agents/docs/implemented/architecture/2026-09-03-prd-one-fold-three-renderers.md
 * sections 5.2 and 6): the read a durable row came from, live text chunks,
 * the local runtime snapshot, the transcript subscription set, the replay
 * and drain markers, and the store's blocked verdicts. None carries a seq.
 */
import { z } from 'zod';

import { RunIdSchema } from './identifiers';
import {
  AggregateIdSchema,
  CommitOrdinalSchema,
  DisplaySessionEventSchema,
  OwnerIdSchema,
} from './sessionEvent';

/**
 * The read that delivered a durable row (PRD 7.1): the cold listing, one
 * aggregate's history, or the tail. Only a tail row advances `cursor`.
 */
export const FoldEventSchema = z.object({
  _tag: z.literal('event'),
  read: z.enum(['listing', 'aggregate', 'all']),
  event: DisplaySessionEventSchema,
});

/**
 * A live text delta for one row, carrying its own offsets into the row's
 * in-flight text (PRD 5.2, "Live text"): the transient analogue of `seq`.
 * The fold ignores a chunk whose `to` is not past the text it holds,
 * otherwise truncates at `from` and appends, so a redelivery in any order is
 * a no-op, a `from: 0` chunk replaces the row, and two adjacent chunks merge
 * into one exactly. Never durable, never a seq.
 */
export const TextChunkSchema = z.object({
  _tag: z.literal('chunk'),
  runId: RunIdSchema,
  rowId: z.string(),
  from: z.int().nonnegative(),
  to: z.int().positive(),
  text: z.string(),
});
export type TextChunk = z.infer<typeof TextChunkSchema>;

/**
 * Process-local liveness evidence: self, explicitly proved-dead owners, and
 * unreadable runs. A current claimant absent from these verdicts is
 * unprovable and remains held until a probe establishes otherwise.
 */
export const LocalRuntimeStateSchema = z.object({
  self: z.array(OwnerIdSchema),
  dead: z.array(OwnerIdSchema),
  unreadable: z.array(z.object({ runId: RunIdSchema, detail: z.string() })),
});
export type LocalRuntimeState = z.infer<typeof LocalRuntimeStateSchema>;

/**
 * The aggregates whose transcript tier the view holds, each with the seq
 * its history is read from (PRD 5.2, "Residency"). Every value of the set
 * is a fold input: an aggregate entering it gets its `folded` entry, one
 * leaving it loses its transcript tier.
 */
export const TranscriptSubscriptionSchema = z.object({
  id: AggregateIdSchema,
  fromSeq: z.int().nonnegative(),
});
export type TranscriptSubscription = z.infer<
  typeof TranscriptSubscriptionSchema
>;

/** Current ownership and removals for exactly the scope checked by a finite read. */
export const ExistenceReconciliationSchema = z.object({
  checkedAggregateIds: z.array(AggregateIdSchema),
  removedAggregateIds: z.array(AggregateIdSchema),
  claims: z.array(
    z.object({
      aggregateId: AggregateIdSchema,
      ownerId: OwnerIdSchema.nullable(),
    }),
  ),
});
export type ExistenceReconciliation = z.infer<
  typeof ExistenceReconciliationSchema
>;

/**
 * An aggregate whose rows this build cannot read whole: a row of a newer
 * version or an unknown kind (a later build wrote it), or one that fails
 * its own version's schema. The listing delivers what decodes and this
 * verdict beside it; the fold marks the run blocked, and every run history read
 * and claim of it is refused.
 */
export const BlockedAggregateSchema = z.object({
  _tag: z.literal('blocked'),
  aggregateId: AggregateIdSchema,
  /** The incarnation the verdict is about. */
  uid: z.string(),
  reason: z.enum(['newer', 'unknown', 'corrupt']),
  type: z.string(),
  version: z.int().nonnegative(),
  /** The envelope of the row that blocked it: for a run whose `run.start`
   *  is the unreadable row, its creation, which the fold lists it at. */
  commit: CommitOrdinalSchema,
  at: z.int(),
});
export type BlockedAggregate = z.infer<typeof BlockedAggregateSchema>;

const FoldInputSchema = z.discriminatedUnion('_tag', [
  BlockedAggregateSchema,
  FoldEventSchema,
  TextChunkSchema,
  z.object({ _tag: z.literal('debug'), enabled: z.boolean() }),
  z.object({ _tag: z.literal('local'), local: LocalRuntimeStateSchema }),
  z.object({
    _tag: z.literal('subscriptions'),
    set: z.array(TranscriptSubscriptionSchema),
  }),
  /** Cold reads have completed; apply current claims without adopting a later cursor. */
  z.object({
    _tag: z.literal('replay.complete'),
    existence: ExistenceReconciliationSchema,
  }),
  /** A finite tail read has completed, including rows no longer materialized. */
  z.object({
    _tag: z.literal('drained'),
    cursor: CommitOrdinalSchema,
    existence: ExistenceReconciliationSchema,
  }),
]);
export type FoldInput = z.infer<typeof FoldInputSchema>;
