/**
 * The inputs a `SessionView` is built from besides the durable rows
 * themselves: the read a durable row came from, live text chunks, the local
 * runtime snapshot, the transcript subscription set, and the replay and
 * drain markers. None carries a seq.
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
 * The read that delivered a durable row: the cold listing, one
 * aggregate's history, or the tail. Only a tail row advances `cursor`.
 */
export const EventInputSchema = z.object({
  _tag: z.literal('event'),
  read: z.enum(['listing', 'aggregate', 'all']),
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
 * Why this process cannot resume a run until something it needs is back:
 * its agent is missing, or its agent's
 * plugin is off or not trusted. A fact about this build and its catalog,
 * so it lives in the projection, never in a row.
 */
export const ResumeBlockerSchema = z.object({
  kind: z.enum(['agentMissing', 'pluginOff', 'pluginUntrusted']),
  /** The agent or plugin it names. */
  name: z.string().min(1),
});
export type ResumeBlocker = z.infer<typeof ResumeBlockerSchema>;

/** Why this build cannot open a run's rows: one does not decode
 *  (`damaged`), or an earlier build wrote one it has no upcaster for. */
const RunUnreadableSchema = z.enum(['damaged', 'earlierBuild']);

/**
 * Why a run's banner speaks, as a key and the data its words need; the
 * app's `@ui/copy/runStatus` words it. In priority order: its rows cannot
 * be read here, a resume found it blocked, its process stopped before it
 * finished, another process (by pid) holds it, its end lost its result.
 */
export const RunNoticeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: RunUnreadableSchema }),
  z.object({
    kind: z.literal('resumeBlocked'),
    reason: ResumeBlockerSchema,
    /** A resume was asked for: the run continues by itself once unblocked. */
    retry: z.boolean(),
  }),
  z.object({ kind: z.literal('interrupted') }),
  z.object({ kind: z.literal('held'), pid: z.int() }),
  z.object({ kind: z.literal('lost'), message: z.string() }),
]);

/**
 * Process-local liveness evidence: self, explicitly proved-dead owners, and
 * unreadable runs. A current claimant absent from these verdicts is
 * unprovable and remains held until a probe establishes otherwise. Beside
 * it, the runs a resume found blocked: `retry` when one was asked for, so
 * the run continues once what it needs is back.
 */
export const LocalRuntimeStateSchema = z.object({
  self: z.array(OwnerIdSchema),
  dead: z.array(OwnerIdSchema),
  unreadable: z.array(
    z.object({ runId: RunIdSchema, reason: RunUnreadableSchema }),
  ),
  resumeBlocked: z.array(
    z.object({
      runId: RunIdSchema,
      reason: ResumeBlockerSchema,
      retry: z.boolean(),
    }),
  ),
});
export type LocalRuntimeState = z.infer<typeof LocalRuntimeStateSchema>;

/**
 * The aggregates whose transcripts the view holds, each with the seq its
 * history is read from. Every value of the set is a view input: an
 * aggregate entering it gets its `transcriptSeq` entry, one leaving it loses
 * its transcript.
 */
export const TranscriptSubscriptionSchema = z.object({
  id: AggregateIdSchema,
  fromSeq: z.int().nonnegative(),
});
export type TranscriptSubscription = z.infer<
  typeof TranscriptSubscriptionSchema
>;

/**
 * Current ownership for exactly the scope a finite read checked: a checked
 * aggregate with no claim entry no longer exists.
 */
export const ExistenceReconciliationSchema = z.object({
  checkedAggregateIds: z.array(AggregateIdSchema),
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

const SessionViewInputSchema = z.discriminatedUnion('_tag', [
  EventInputSchema,
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
export type SessionViewInput = z.infer<typeof SessionViewInputSchema>;
