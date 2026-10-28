/**
 * One follow-up: input put on a run's queue and read at its next turn
 * boundary. Every producer — the user's composer, a child's report, a
 * parent's or peer's message, a host notice — writes this one shape, so
 * messaging between runs and subagent reporting are the same row.
 */
import { Schema } from 'effect';

import { RunIdSchema } from './identifiers';
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
 * a child's delivery envelope is summarized for the transcript. A loop's own
 * maintenance wake is never a follow-up row.
 */
export const FollowUpContentSchema = Schema.Struct({
  text: Schema.String,
  /** What the transcript and the queued list show instead of `text`. */
  displayText: Schema.optional(Schema.NullOr(Schema.String)),
  /** Media a user follow-up attached (e.g. pasted images), by address:
   *  the row links the blobs, so they live as long as it does. */
  media: Schema.optional(Schema.Array(StoredMediaSchema)),
  from: FollowUpSenderSchema,
});
export type FollowUpContent = typeof FollowUpContentSchema.Type;

/**
 * Why a persisted run is not resumed here: `finished` (nothing left to
 * continue from), `owned_elsewhere` (another live process holds it),
 * `blocked` (an agent or plugin it needs is missing, off or not trusted
 * here), `unusable_checkpoint` (its saved state is there but cannot be
 * continued: never `finished`, which would say it ended normally),
 * `earlier_build` (an earlier build wrote its rows), or `not_resumable` (it
 * is running here, it was deleted, or its input is closed).
 */
export const ResumeRefusalSchema = Schema.Literals([
  'finished',
  'owned_elsewhere',
  'blocked',
  'unusable_checkpoint',
  'earlier_build',
  'not_resumable',
]);
/** One reason a resume is refused ({@link ResumeRefusalSchema}). */
export type ResumeRefusal = typeof ResumeRefusalSchema.Type;
