/**
 * The inputs a `SessionView` is built from besides the durable rows
 * themselves: the read a durable row came from, live text chunks, the local
 * runtime snapshot, the transcript subscription set, and the replay and
 * drain markers. None carries a seq.
 */
import { Schema } from 'effect';

import { RunIdSchema } from './identifiers';
import { AggregateIdSchema, OwnerIdSchema } from './aggregateId';
import { CommitOrdinalSchema, DisplaySessionEventSchema } from './sessionEvent';

/**
 * The read that delivered a durable row: the cold listing, one
 * aggregate's history, or the tail. Only a tail row advances `cursor`.
 */
export const EventInputSchema = Schema.Struct({
  _tag: Schema.Literal('event'),
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
export const TextChunkSchema = Schema.Struct({
  _tag: Schema.Literal('chunk'),
  runId: RunIdSchema,
  rowId: Schema.String,
  from: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  to: Schema.Int.check(Schema.isGreaterThan(0)),
  text: Schema.String,
});
export type TextChunk = typeof TextChunkSchema.Type;

/**
 * Why this process cannot resume a run until something it needs is back:
 * its agent is missing, or its agent's
 * plugin is off or not trusted. A fact about this build and its catalog,
 * so it lives in the projection, never in a row.
 */
export const ResumeBlockerSchema = Schema.Struct({
  kind: Schema.Literals(['agentMissing', 'pluginOff', 'pluginUntrusted']),
  /** The agent or plugin it names. */
  name: Schema.String.check(Schema.isMinLength(1)),
});
export type ResumeBlocker = typeof ResumeBlockerSchema.Type;

/** Why this build cannot open a run's rows: one does not decode
 *  (`damaged`), or an earlier build wrote one it has no upcaster for. */
const RunUnreadableSchema = Schema.Literals(['damaged', 'earlierBuild']);

/**
 * Why a run's banner speaks, as a key and the data its words need; the
 * app's `@ui/copy/runStatus` words it. In priority order: its rows cannot
 * be read here, a resume found it blocked, its process stopped before it
 * finished, another process (by pid) holds it, its end lost its result.
 */
export const RunNoticeSchema = Schema.Union([
  Schema.Struct({ kind: RunUnreadableSchema }),
  Schema.Struct({
    kind: Schema.Literal('resumeBlocked'),
    reason: ResumeBlockerSchema,
    /** A resume was asked for: the run continues by itself once unblocked. */
    retry: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal('interrupted') }),
  Schema.Struct({ kind: Schema.Literal('held'), pid: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal('lost'), message: Schema.String }),
]);

/**
 * Process-local liveness evidence: self, explicitly proved-dead owners, and
 * unreadable runs. A current claimant absent from these verdicts is
 * unprovable and remains held until a probe establishes otherwise. Beside
 * it, the runs a resume found blocked: `retry` when one was asked for, so
 * the run continues once what it needs is back.
 */
export const LocalRuntimeStateSchema = Schema.Struct({
  self: Schema.Array(OwnerIdSchema),
  dead: Schema.Array(OwnerIdSchema),
  unreadable: Schema.Array(
    Schema.Struct({ runId: RunIdSchema, reason: RunUnreadableSchema }),
  ),
  resumeBlocked: Schema.Array(
    Schema.Struct({
      runId: RunIdSchema,
      reason: ResumeBlockerSchema,
      retry: Schema.Boolean,
    }),
  ),
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
 * Current ownership for exactly the scope a finite read checked: a checked
 * aggregate with no claim entry no longer exists.
 */
export const ExistenceReconciliationSchema = Schema.Struct({
  checkedAggregateIds: Schema.Array(AggregateIdSchema),
  claims: Schema.Array(
    Schema.Struct({
      aggregateId: AggregateIdSchema,
      ownerId: Schema.NullOr(OwnerIdSchema),
    }),
  ),
});
export type ExistenceReconciliation =
  (typeof ExistenceReconciliationSchema)['Type'];

const SessionViewInputSchema = Schema.Union([
  EventInputSchema,
  TextChunkSchema,
  Schema.Struct({ _tag: Schema.Literal('debug'), enabled: Schema.Boolean }),
  Schema.Struct({
    _tag: Schema.Literal('local'),
    local: LocalRuntimeStateSchema,
  }),
  Schema.Struct({
    _tag: Schema.Literal('subscriptions'),
    set: Schema.Array(TranscriptSubscriptionSchema),
  }),
  /** Cold reads have completed; apply current claims without adopting a later cursor. */
  Schema.Struct({
    _tag: Schema.Literal('replay.complete'),
    existence: ExistenceReconciliationSchema,
  }),
  /** A finite tail read has completed, including rows no longer materialized. */
  Schema.Struct({
    _tag: Schema.Literal('drained'),
    cursor: CommitOrdinalSchema,
    existence: ExistenceReconciliationSchema,
  }),
]);
export type SessionViewInput = typeof SessionViewInputSchema.Type;
