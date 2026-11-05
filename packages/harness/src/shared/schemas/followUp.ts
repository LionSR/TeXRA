/**
 * One follow-up: input put on a run's queue and read at its next turn
 * boundary. Every producer — the user's composer, a child's report, a
 * parent's or peer's message, a host notice — writes this one shape, so
 * messaging between runs and subagent reporting are the same row.
 */
import { Schema } from 'effect';

import { OwnerIdSchema, RunIdSchema } from './identifiers';
import { StoredMediaSchema } from './storedTurn';

/**
 * Where one run stands relative to another in the supervision tree: who
 * launched whom, who stops whom, who reports to whom. It never limits who
 * may talk to whom; every run in a project may message every other.
 * `peer` is any run with no ancestor line to the other and no shared parent.
 */
const RunRelationSchema = Schema.Literals([
  'parent',
  'child',
  'ancestor',
  'descendant',
  'sibling',
  'peer',
]);
export type RunRelation = typeof RunRelationSchema.Type;

/**
 * Who put the input on the run. A run sender's `relation` is what the sender
 * is to the recipient, stamped by the recipient's admission from both runs'
 * lineage as the session view holds it, never taken from the sender: it is
 * the relation as admitted, and a later detach does not rewrite it.
 */
const FollowUpSenderSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('user') }),
  Schema.Struct({
    kind: Schema.Literal('run'),
    runId: RunIdSchema,
    relation: RunRelationSchema,
  }),
  /** A host notice about the run's world (a watched PR's CI or review). It
   *  informs the run and never becomes its instruction. */
  Schema.Struct({
    kind: Schema.Literal('notification'),
    source: Schema.Literal('github'),
  }),
]);
export type FollowUpSender = typeof FollowUpSenderSchema.Type;

/**
 * One follow-up as it is queued, taken, and shown. `from` is the provenance
 * a consumer reads: a user's or parent's text becomes the run's instruction,
 * a delivery or notice envelope is summarized for the transcript. A loop's own
 * maintenance wake is never a follow-up row.
 */
const FollowUpContentSchema = Schema.Struct({
  text: Schema.String,
  /** What the transcript and the queued list show instead of `text`. */
  displayText: Schema.optional(Schema.NullOr(Schema.String)),
  /** Media a user follow-up attached (e.g. pasted images), by address:
   *  the row links the blobs, so they live as long as it does. */
  media: Schema.optional(Schema.Array(StoredMediaSchema)),
  from: FollowUpSenderSchema,
});
export type FollowUpContent = typeof FollowUpContentSchema.Type;

/** What a follow-up asks of its run, as its `followup.queued` row stores
 *  it: a caller's retry under the same id must ask the same. */
export const FollowUpRequestSchema = Schema.Struct({
  content: FollowUpContentSchema,
  /** When the row may be read; the rules are `readableMessages`. */
  holdUntil: Schema.optional(
    Schema.Literals(['instruction', 'turn', 'generation']),
  ),
  /** A request of the run's own, consumed by the batch that applies it. */
  control: Schema.optional(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal('compact') }),
      Schema.Struct({
        kind: Schema.Literal('model'),
        model: Schema.String.check(Schema.isMinLength(1)),
      }),
    ]),
  ),
});

/**
 * Why a follow-up left the queue, stated by the writer of its
 * `followup.consumed` row: it became part of the user message of turn
 * `turn`; a child's prompt or delivery was answered by the report or tool
 * result committed beside it; a control (`/compact`, `/model`) was applied
 * by the edit or `run.config` beside it; or it was dropped unread and
 * unapplied: a notice of a child that had ended (`stale`), a control that
 * changed nothing (`noop`), the run's end (`ended`) or its input's close
 * (`closed`). `followUpReceipt` reads these.
 */
export const FollowUpDispositionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('turn'),
    turn: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  Schema.Struct({ kind: Schema.Literal('answered') }),
  Schema.Struct({ kind: Schema.Literal('applied') }),
  Schema.Struct({
    kind: Schema.Literal('dropped'),
    reason: Schema.Literals(['stale', 'noop', 'ended', 'closed']),
  }),
]);
/** A `followup.consumed` row's `disposition`. */
export type FollowUpDisposition = typeof FollowUpDispositionSchema.Type;

const TurnSchema = Schema.Int.check(Schema.isGreaterThan(0));

/**
 * Where one input to a run stands, as the run's rows say it: `accepted`
 * while queued; `incorporated` into the message of turn `turn` while that
 * turn runs; `answered`, where `answer` is the `seq` of the run's row that
 * answered it (the turn's end, which every input of one turn shares; for a
 * child's prompt, a `/compact` or a `/model`, the rows that answered it
 * commit beside its consumption, at that seq); or `unanswered`, why nothing
 * will: the turn failed, the run ended before the turn did (`error`: the
 * end's), or the input left the queue unread (a dropped disposition's
 * reason). An input that joins a turn keeps that turn's number.
 */
export const FollowUpReceiptSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal('accepted') }),
  Schema.Struct({ state: Schema.Literal('incorporated'), turn: TurnSchema }),
  Schema.Struct({
    state: Schema.Literal('answered'),
    turn: Schema.optional(TurnSchema),
    answer: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  Schema.Struct({
    state: Schema.Literal('unanswered'),
    turn: Schema.optional(TurnSchema),
    reason: Schema.Literals([
      'failed',
      'cancelled',
      'completed',
      'stale',
      'noop',
      'ended',
      'closed',
    ]),
    error: Schema.optional(Schema.String),
  }),
]);
/** Where one input to a run stands ({@link FollowUpReceiptSchema}). */
export type FollowUpReceipt = typeof FollowUpReceiptSchema.Type;

/** A run this process cannot continue until its agent, or its agent's
 *  plugin, is back: a fact about this build's catalog, never a row's. */
export const ResumeBlockedSchema = Schema.Struct({
  kind: Schema.Literal('blocked'),
  blocker: Schema.Literals(['agentMissing', 'pluginOff', 'pluginUntrusted']),
  /** The agent or plugin it names. */
  name: Schema.String.check(Schema.isMinLength(1)),
});
/** What a blocked resume waits for ({@link ResumeBlockedSchema}). */
export type ResumeBlocked = typeof ResumeBlockedSchema.Type;

/**
 * Why a persisted run is not continued here: the one answer a resume, a
 * message to a run with no loop here, a run's records and its view give.
 * `finished` (nothing left to continue from), `ownedElsewhere` (a live
 * owner, or one not provably dead, holds its claim), `blocked`
 * ({@link ResumeBlockedSchema}), `unusableCheckpoint` (its saved state is
 * there but cannot be continued: never `finished`, which would say it ended
 * normally), `earlierBuild` (an earlier build wrote its rows),
 * `pluginUnavailable` (it holds a fact of `plugin`, which this process does
 * not load, `cause` the fact's reason: it continues once a process loads
 * it), or `notResumable` (it is
 * running here, it was deleted, or its input is closed).
 */
export const ResumeRefusalSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('finished') }),
  Schema.Struct({
    kind: Schema.Literal('ownedElsewhere'),
    owner: OwnerIdSchema,
  }),
  ResumeBlockedSchema,
  Schema.Struct({ kind: Schema.Literal('unusableCheckpoint') }),
  Schema.Struct({ kind: Schema.Literal('earlierBuild'), cause: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal('pluginUnavailable'),
    plugin: Schema.String,
    cause: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal('notResumable') }),
]);
/** One reason a resume is refused ({@link ResumeRefusalSchema}). */
export type ResumeRefusal = typeof ResumeRefusalSchema.Type;
