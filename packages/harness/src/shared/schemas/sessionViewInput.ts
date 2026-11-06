/**
 * The inputs a `SessionView` is built from besides the durable rows
 * themselves: the read a durable row came from, live text chunks, the local
 * runtime snapshot, the transcript subscription set, and the replay and
 * drain markers. None carries a seq.
 */
import { Schema } from 'effect';

import { RunIdSchema } from './identifiers';
import { AggregateIdSchema } from './identifiers';
import { CommitOrdinalSchema, DisplaySessionEventSchema } from './sessionEvent';

/**
 * The read that delivered a durable row: the cold listing, one
 * aggregate's history, or the tail. Only a tail row advances `cursor`.
 */
export const EventInputSchema = Schema.TaggedStruct('event', {
  read: Schema.Literals(['listing', 'aggregate', 'all']),
  event: DisplaySessionEventSchema,
});

/**
 * A live text delta for one row, carrying its own offsets into the row's
 * in-flight text: the transient analogue of `seq`.
 * The view ignores a chunk whose `to` is not past the text it holds,
 * otherwise truncates at `from` and appends, so a redelivery in any order is
 * a no-op, a `from: 0` chunk replaces the row, and two adjacent chunks merge
 * into one exactly. Never durable, never a seq.
 */
export const TextChunkSchema = Schema.TaggedStruct('chunk', {
  runId: RunIdSchema,
  rowId: Schema.String,
  from: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  to: Schema.Int.check(Schema.isGreaterThan(0)),
  text: Schema.String,
});
export type TextChunk = typeof TextChunkSchema.Type;

/** Why this build cannot open a run's rows: one does not decode
 *  (`damaged`), or an earlier build wrote one at a lower version, the
 *  resume refusal of the same name. */
const RunUnreadableSchema = Schema.Literals(['damaged', 'earlierBuild']);

/**
 * Why a run's banner speaks, as a key and the data its words need; the
 * app's `@ui/copy/runStatus` words it. In priority order: its rows cannot
 * be read here, its process stopped before it finished, its end lost its
 * result.
 */
export const RunNoticeSchema = Schema.Union([
  Schema.Struct({ kind: RunUnreadableSchema }),
  Schema.Struct({ kind: Schema.Literal('interrupted') }),
  Schema.Struct({ kind: Schema.Literal('lost'), message: Schema.String }),
]);

/** A run this build cannot open, and why. */
export const UnreadableRunSchema = Schema.Struct({
  runId: RunIdSchema,
  reason: RunUnreadableSchema,
});
export type UnreadableRun = typeof UnreadableRunSchema.Type;

/**
 * What this process knows that the rows cannot say: the runs a launch here
 * holds (`runsHere`), written by the session's run registry. A run that
 * has not ended and is not among them is interrupted.
 */
export const LocalRuntimeStateSchema = Schema.Struct({
  runsHere: Schema.Array(RunIdSchema),
});
export type LocalRuntimeState = typeof LocalRuntimeStateSchema.Type;

/**
 * The aggregates whose transcripts the view holds, each with the seq its
 * history is read from. Every value of the set is a view input: an
 * aggregate entering it gets its `transcriptSeq` entry, one leaving it loses
 * its transcript.
 */
export const TranscriptSubscriptionSchema = Schema.Struct({
  id: AggregateIdSchema,
  fromSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type TranscriptSubscription =
  (typeof TranscriptSubscriptionSchema)['Type'];

/**
 * Existence for exactly the scope a finite read checked: a checked
 * aggregate absent from `present` no longer exists. `unreadable` names the
 * runs the same read found this build cannot open.
 */
export const ExistenceReconciliationSchema = Schema.Struct({
  checkedAggregateIds: Schema.Array(AggregateIdSchema),
  present: Schema.Array(AggregateIdSchema),
  unreadable: Schema.Array(UnreadableRunSchema),
});
export type ExistenceReconciliation =
  (typeof ExistenceReconciliationSchema)['Type'];

const SessionViewInputSchema = Schema.Union([
  EventInputSchema,
  TextChunkSchema,
  Schema.TaggedStruct('debug', { enabled: Schema.Boolean }),
  Schema.TaggedStruct('local', {
    local: LocalRuntimeStateSchema,
  }),
  Schema.TaggedStruct('subscriptions', {
    set: Schema.Array(TranscriptSubscriptionSchema),
  }),
  /** Cold reads have completed; reconcile existence without adopting a later cursor. */
  Schema.TaggedStruct('replay.complete', {
    existence: ExistenceReconciliationSchema,
  }),
  /** A finite tail read has completed, including rows no longer materialized. */
  Schema.TaggedStruct('drained', {
    cursor: CommitOrdinalSchema,
    existence: ExistenceReconciliationSchema,
  }),
]);
export type SessionViewInput = typeof SessionViewInputSchema.Type;
