/**
 * The runtime request protocol: one Zod
 * union of the requests a surface issues to its session's runtime and the
 * outcomes the runtime answers with. In process (the TUI, headless) the
 * Effect's own result is the response and no message exists; the envelope
 * and response a bridge posts arrive with that bridge.
 *
 * Arm tags are `group.action` throughout, so two groups cannot claim one
 * tag. Every run-scoped arm names a bare `runId`: a `RunId` names one run
 * for its whole life (decision 9), so a request that waits while its run is
 * deleted can only miss, never land on a different run.
 * The union carries the arms the runtime answers today; a lane that routes
 * another retained command adds its arm with its handler.
 */
import { z } from 'zod';

import {
  APPROVAL_BYPASS_KINDS,
  APPROVAL_POLICY_LIMITS,
} from '@shared/approvalBypassKind';
import { RequestDecisionSchema, RunIdSchema } from '@shared/schemas';

const runScoped = { runId: RunIdSchema };

/**
 * Why a run stops. `user` is an explicit stop of the work (a stop button,
 * Ctrl-C on a running turn, an agent's kill): the run cancels the remote
 * background operation it is observing. `shutdown` only ends this process's
 * hold on the run (an exit, a signal, a session close), leaving that
 * operation for a resume to observe.
 */
const RunStopReasonSchema = z.enum(['user', 'shutdown']);
/** Why a run stops: a `user` stop or this process's `shutdown`. */
export type RunStopReason = z.infer<typeof RunStopReasonSchema>;

export const RuntimeRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('run.stop'),
    ...runScoped,
    detachActiveChildren: z.boolean().nullish(),
    reason: RunStopReasonSchema,
  }),
  z.object({ kind: z.literal('run.delete'), ...runScoped }),
  z.object({ kind: z.literal('run.compact'), ...runScoped }),
  /** The user's title for the run: a `run.description` row by the user,
   *  which a later model title does not replace. */
  z.object({
    kind: z.literal('run.rename'),
    ...runScoped,
    title: z.string().trim().min(1),
  }),
  /**
   * A new task holding this run's conversation up to `at`, the `seq` of a
   * settled position in its history (its latest when absent): answered with
   * the new run's id, which waits for its host to resume it.
   */
  z.object({
    kind: z.literal('run.fork'),
    ...runScoped,
    at: z.int().positive().nullish(),
  }),
  /**
   * Clear the model's view of this run at its next park; with `handoff`, the
   * cleared view starts from that text, which the run then answers.
   */
  z.object({
    kind: z.literal('run.reset'),
    ...runScoped,
    handoff: z.string().min(1).nullish(),
  }),
  /** Switch a live run to `model` from its next model boundary. */
  z.object({
    kind: z.literal('run.model'),
    ...runScoped,
    model: z.string().min(1),
  }),
  /**
   * A stopped run's directory, copied to `to` (workspace-relative) or
   * removed, under its claim by the process that holds the run's session.
   */
  z.object({
    kind: z.literal('run.files'),
    ...runScoped,
    files: z.discriminatedUnion('op', [
      z.object({ op: z.literal('copy'), to: z.string().min(1) }),
      z.object({ op: z.literal('remove') }),
    ]),
  }),
  z.object({
    kind: z.literal('followUp.send'),
    ...runScoped,
    text: z.string().min(1),
    displayText: z.string().nullish(),
    mediaFiles: z.array(z.string()).nullish(),
  }),
  /**
   * The one answer to a `request.opened` (one run model, section 3.7): the
   * decision lands as that run's `request.decided` row, which is what the
   * waiting run, the recovery bindings, and every surface read. A decision
   * for a request its run is not parked on is delivered as a follow-up.
   * `useOwnApiKey` is the host command that ends in
   * `{ action: 'retry', credentials: 'personal' }` here.
   */
  z.object({
    kind: z.literal('request.decide'),
    ...runScoped,
    requestId: z.string().min(1),
    decision: RequestDecisionSchema,
  }),
  /** A pending tool edit's preview, as the session's host staged it beside
   *  the request: answered `preview`, null when none is staged. */
  z.object({
    kind: z.literal('request.preview'),
    ...runScoped,
    requestId: z.string().min(1),
  }),
  /** The field-level mutation, not a snapshot: the authority applies it and
   *  publishes the resulting `approval.policy`. */
  z.object({
    kind: z.literal('policy.set'),
    change: z.discriminatedUnion('field', [
      z.object({
        field: z.literal('bypass'),
        ...runScoped,
        bypass: z.enum(APPROVAL_BYPASS_KINDS),
        enabled: z.boolean(),
        /** Turning a bypass on also approves the run's requests already
         *  pending under it. This one is the surface's own, decided by the
         *  `request.decide` that follows, which may carry more than a plain
         *  approval. */
        exceptRequestId: z.string().optional(),
      }),
      /** Narrow the run's limit at once (a chat's `/approval`): it only
       *  ever lowers, never raises, the run's own limit. */
      z.object({
        field: z.literal('limit'),
        ...runScoped,
        limit: z.enum(APPROVAL_POLICY_LIMITS),
      }),
    ]),
  }),
]);
export type RuntimeRequest = z.infer<typeof RuntimeRequestSchema>;

/** One unified-diff hunk: the line ranges it spans on each side, and its
 *  lines, each marked ` `, `-` or `+` (`\` notes a missing final newline). */
const DiffHunkSchema = z
  .object({
    oldStart: z.int(),
    oldLines: z.int(),
    newStart: z.int(),
    newLines: z.int(),
    lines: z.array(z.string()).readonly(),
  })
  .readonly();

/** What a pending tool edit would change: the original and proposed
 *  content a host shows beside the request's path and line counts, and
 *  the diff between them, computed once where the request is built: its
 *  hunks and the 0-based line of the proposed text a diff view reveals
 *  first (null when nothing changed). */
export const ToolEditContentSchema = z.object({
  originalContent: z.string(),
  proposedContent: z.string(),
  hunks: z.array(DiffHunkSchema).readonly(),
  firstChangedLine: z.int().nonnegative().nullable(),
});
/** A pending tool edit's staged content (`request.preview`). */
export type ToolEditContent = z.infer<typeof ToolEditContentSchema>;

/**
 * Hunks as unified-diff text lines, each preceded by its header. One header
 * policy: a `,1` range is omitted, the form `diff -u` and `git diff` emit.
 */
export function formatHunkLines(hunks: ToolEditContent['hunks']): string[] {
  const range = (start: number, lines: number) =>
    lines === 1 ? String(start) : `${start},${lines}`;
  return hunks.flatMap((hunk) => [
    `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`,
    ...hunk.lines,
  ]);
}

/** What a `run.files` did: `done` (with the copy's folder), no directory
 *  to act on, or the failure that stopped it. */
const RunFilesResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('done'), to: z.string().optional() }),
  z.object({ status: z.literal('noFiles') }),
  z.object({ status: z.literal('error'), error: z.string() }),
]);
/** What a `run.files` request did. */
export type RunFilesResult = z.infer<typeof RunFilesResultSchema>;

/** What the runtime answers with: a typed value the host renders. */
export const OutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('done') }),
  z.object({
    kind: z.literal('followUp'),
    status: z.enum(['sent', 'queued']),
    /** A queued input whose recovery wake did not reach the run. */
    wake: z.literal('failed').nullish(),
  }),
  z.object({ kind: z.literal('forked'), runId: RunIdSchema }),
  z.object({
    kind: z.literal('preview'),
    preview: ToolEditContentSchema.nullable(),
  }),
  z.object({ kind: z.literal('runFiles'), result: RunFilesResultSchema }),
]);
export type Outcome = z.infer<typeof OutcomeSchema>;
