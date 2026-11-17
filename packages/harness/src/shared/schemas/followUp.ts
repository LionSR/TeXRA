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
import { ProcessExitSchema } from './runRecords';
import { ScriptDeliverySummarySchema } from './scriptDelivery';
import { StoredMediaSchema } from './storedTurn';
import { TokenUsageStatsSchema } from './usage';

/**
 * Who put the input on the run. A run names only itself: where it stands
 * relative to the recipient changes nothing about how its message is read.
 */
const FollowUpSenderSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('user') }),
  Schema.Struct({
    kind: Schema.Literal('run'),
    runId: RunIdSchema,
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
  /** How a background command exited. */
  exit: Schema.optional(ProcessExitSchema),
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
   *  model reads (a command's output, a program's documents). */
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
 *  it. */
export const FollowUpRequestSchema = Schema.Struct({
  content: FollowUpContentSchema,
  /** When the row may be read; the rules are `readableMessages`. */
  holdUntil: Schema.optional(Schema.Literal('turn')),
  /** A request of the run's own, consumed by the batch that applies it. */
  control: Schema.optional(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal('compact') }),
      Schema.Struct({
        kind: Schema.Literal('model'),
        model: Schema.NonEmptyString,
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
 * (`ended`) or its input's close (`closed`).
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

/** A run this process cannot continue until its agent, or its agent's
 *  plugin, is back: a fact about this build's catalog, never a row's. The
 *  agent is missing, its plugin is off, or its enabled plugin does not load
 *  (`reason`: unreadable, shipping code, or changed since it was trusted). */
export const ResumeBlockedSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('blocked'),
    blocker: Schema.Literals(['agentMissing', 'pluginOff']),
    /** The agent or plugin it names. */
    name: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal('blocked'),
    blocker: Schema.Literal('pluginWithheld'),
    /** The plugin it names. */
    name: Schema.NonEmptyString,
    /** Why the plugin's load holds it back, as the load words it. */
    reason: Schema.String,
  }),
]);

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

/**
 * The one wording of a refused resume or message, shared by every host and
 * tool output: a resume's refusal ({@link ResumeRefusal}), or `readFailed`,
 * a message whose run's rows could not be read just now (a failing store),
 * which says nothing about the run itself.
 */
export function describeRefusal(
  reason: ResumeRefusal | { readonly kind: 'readFailed' },
): string {
  switch (reason.kind) {
    case 'finished':
      return 'This run has finished. Start a new agent task to continue.';
    case 'unusableCheckpoint':
      return "This run's saved state could not be loaded, so it cannot be continued. Delete it from history and start a new agent task.";
    case 'earlierBuild':
      return 'This run was written by an earlier build, and this build cannot continue it.';
    case 'pluginUnavailable':
      return `This run needs the ${reason.plugin} plugin, which is not loaded here (${reason.cause}). It can continue once the plugin loads.`;
    case 'readFailed':
      return "This run couldn't be read right now. Try again in a moment.";
    case 'notResumable':
      return 'This run cannot accept messages right now. Resume it, or start a new agent task.';
    case 'blocked':
      switch (reason.blocker) {
        case 'agentMissing':
          return `This task's agent, ${reason.name}, is not installed. It can continue once the agent is back.`;
        case 'pluginOff':
          return `This task's agent comes from the ${reason.name} plugin, which is off. It can continue once the plugin is on.`;
        case 'pluginWithheld':
          return `This task's agent comes from the ${reason.name} plugin. ${reason.reason} It can continue once the plugin loads.`;
      }
  }
}
