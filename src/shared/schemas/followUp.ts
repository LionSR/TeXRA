/**
 * One follow-up: input put on a run's queue and read at its next turn
 * boundary. Every producer — the user's composer, a child's report, a
 * parent's or peer's message, a host notice — writes this one shape, so
 * messaging between runs and subagent reporting are the same row.
 */
import { z } from 'zod';

import { RunIdSchema } from './identifiers';

/**
 * Where one run stands relative to another in the supervision tree: who
 * launched whom, who stops whom, who reports to whom. It never limits who
 * may talk to whom; every run in a project may message every other.
 * `peer` is any run with no ancestor line to the other and no shared parent.
 */
const RunRelationSchema = z.enum([
  'parent',
  'child',
  'ancestor',
  'descendant',
  'sibling',
  'peer',
]);
export type RunRelation = z.infer<typeof RunRelationSchema>;

/**
 * Who put the input on the run. A run sender's `relation` is what the sender
 * is to the recipient, stamped by the recipient's admission from both runs'
 * lineage as the session view holds it, never taken from the sender: it is
 * the relation as admitted, and a later detach does not rewrite it.
 */
const FollowUpSenderSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user') }),
  z.strictObject({
    kind: z.literal('run'),
    runId: RunIdSchema,
    relation: RunRelationSchema,
  }),
  /** A host notice about the run's world (a watched PR's CI or review). It
   *  informs the run and never becomes its instruction. */
  z.strictObject({
    kind: z.literal('notification'),
    source: z.literal('github'),
  }),
]);
export type FollowUpSender = z.infer<typeof FollowUpSenderSchema>;

/**
 * One follow-up as it is queued, taken, and shown. `from` is the provenance
 * a consumer reads: a user's or parent's text becomes the run's instruction,
 * a child's delivery envelope is summarized for the transcript. A loop's own
 * maintenance wake is never a follow-up row.
 */
export const FollowUpContentSchema = z.object({
  text: z.string(),
  /** What the transcript and the queued list show instead of `text`. */
  displayText: z.string().nullish(),
  /** Media file paths (e.g. pasted images) attached to a user follow-up. */
  mediaFiles: z.array(z.string()).nullish(),
  from: FollowUpSenderSchema,
});
export type FollowUpContent = z.infer<typeof FollowUpContentSchema>;
