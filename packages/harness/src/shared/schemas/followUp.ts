/**
 * One follow-up: input put on a run's queue and read at its next turn
 * boundary. Every producer — the user's composer, a child's report, a
 * parent's or peer's message, a host notice — writes this one row, so
 * messaging between runs and subagent reporting are the same row: a
 * message's text, or a child's report as its typed delivery.
 */
import { Schema, Struct } from 'effect';

import { DELIVERY_FAMILY_PATTERN } from '@shared/deliveryTags';
import { RunIdSchema } from './identifiers';
import { RunOutcomeSchema } from './run';
import { ScriptDeliverySummarySchema } from './scriptDelivery';
import { StoredMediaSchema } from './storedTurn';
import { TokenUsageStatsSchema } from './usage';

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
    /** What sent it, as the sender names itself (`github`); nothing
     *  branches on it. */
    source: Schema.String,
  }),
]);
export type FollowUpSender = typeof FollowUpSenderSchema.Type;

/**
 * A child run's report to its parent: its family and run, then the facts its
 * driver chose, each optional. `formatDelivery` renders them, in this order,
 * as the XML envelope its parent's model reads: `<family>-result`, or
 * `<family>-error` for one that carries `message`. Every surface shows the
 * same facts summarized (`followUpDisplay`), never the XML.
 */
const ChildRunDeliverySchema = Schema.Struct({
  /** The envelope's family (`subagent`, a plugin's `codex`). */
  family: Schema.String.check(
    Schema.isPattern(new RegExp(`^${DELIVERY_FAMILY_PATTERN}$`)),
  ),
  runId: Schema.String,
  /** The prompt the child took, echoed (cut short) as an attribute. */
  prompt: Schema.optional(Schema.String),
  /** The attributes after `id` and `prompt`, in order (`agent`, `status`,
   *  `command`, `thread-id`, …); one whose value is null is left out. */
  attributes: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        value: Schema.NullOr(
          Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]),
        ),
      }),
    ),
  ),
  /** How a background command exited: its code, a conventional one when it
   *  timed out or had none of its own (`noExitCode`). */
  exit: Schema.optional(
    Schema.Struct({
      code: Schema.Int,
      timedOut: Schema.Boolean,
      noExitCode: Schema.Boolean,
    }),
  ),
  /** How long the child ran, as it reads (`1.2s`). */
  wallTime: Schema.optional(Schema.String),
  /** A turn's or a script's answer, inline; an empty one reads
   *  `(no response)`. */
  response: Schema.optional(Schema.String),
  usage: Schema.optional(
    Schema.NullOr(
      TokenUsageStatsSchema.mapFields(
        Struct.pick(['inputTokens', 'outputTokens']),
      ),
    ),
  ),
  /** A background script's summary: its calls, what they wrote and cost. */
  summary: Schema.optional(ScriptDeliverySummarySchema),
  /** Body lines its driver rendered, carried as given: facts only the
   *  model reads (a command's output, a recipe's documents). */
  lines: Schema.optional(Schema.Array(Schema.String)),
  /** A native run's output: its reply, as a block (none when empty), and the
   *  files its calls touched. */
  output: Schema.optional(
    Schema.Struct({
      response: Schema.String,
      files: Schema.Array(Schema.String),
    }),
  ),
  /** Failure text; its presence is what makes the delivery an error report. */
  message: Schema.optional(Schema.String),
});
/** A child run's report to its parent ({@link ChildRunDeliverySchema}). */
export type ChildRunDelivery = typeof ChildRunDeliverySchema.Type;

/** A message: a user's or a run's text, or a host's notice. */
const FollowUpMessageSchema = Schema.Struct({
  text: Schema.String,
  /** What the transcript and the queued list show instead of `text`. */
  displayText: Schema.optional(Schema.NullOr(Schema.String)),
  /** Media a user follow-up attached (e.g. pasted images), by address:
   *  the row links the blobs, so they live as long as it does. */
  media: Schema.optional(Schema.Array(StoredMediaSchema)),
  from: FollowUpSenderSchema,
});
/** A follow-up that is a message, not a child's delivery. */
export type FollowUpMessage = typeof FollowUpMessageSchema.Type;

/**
 * One follow-up as it is queued, taken, and shown: a message, or a child's
 * delivery to its parent, whose facts are rendered once, as the envelope its
 * parent's model reads, where the row becomes the run's message. `from` is
 * the provenance a consumer reads: a user's or parent's text becomes the
 * run's instruction. A loop's own maintenance wake is never a follow-up row.
 */
const FollowUpContentSchema = Schema.Union([
  FollowUpMessageSchema,
  Schema.Struct({
    delivery: ChildRunDeliverySchema,
    from: FollowUpSenderSchema,
  }),
]);
export type FollowUpContent = typeof FollowUpContentSchema.Type;

/** What a follow-up asks of its run, as its `followup.queued` row stores
 *  it: a caller's retry under the same id must ask the same. */
export const FollowUpRequestSchema = Schema.Struct({
  content: FollowUpContentSchema,
  /** When the row may be read; the rules are `readableMessages`. */
  holdUntil: Schema.optional(Schema.Literals(['instruction', 'turn'])),
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
 * unapplied: a control that changed nothing (`noop`), the run's end
 * (`ended`) or its input's close (`closed`). `followUpReceipt` reads these.
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
    reason: Schema.Literals(['noop', 'ended', 'closed']),
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
    /** How the run ended, when its end is why; else the input was a no-op,
     *  or the run ended or closed its input before answering it. */
    reason: Schema.Union([
      RunOutcomeSchema,
      Schema.Literals(['noop', 'ended', 'closed']),
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
 * `finished` (nothing left to continue from), `blocked`
 * ({@link ResumeBlockedSchema}), `unusableCheckpoint` (its saved state is
 * there but cannot be continued: never `finished`, which would say it ended
 * normally), `earlierBuild` (an earlier build wrote its rows),
 * `pluginUnavailable` (it holds a fact of `plugin`, which this process does
 * not load, `cause` the fact's reason: it continues once a process loads
 * it), or `notResumable` (it was deleted, or its input is closed).
 */
export const ResumeRefusalSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('finished') }),
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
