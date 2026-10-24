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
import { Schema } from 'effect';

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
const RunStopReasonSchema = Schema.Literals(['user', 'shutdown']);
/** Why a run stops: a `user` stop or this process's `shutdown`. */
export type RunStopReason = typeof RunStopReasonSchema.Type;

export const RuntimeRequestSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('run.stop'),
    ...runScoped,
    detachActiveChildren: Schema.optional(Schema.NullOr(Schema.Boolean)),
    reason: RunStopReasonSchema,
  }),
  Schema.Struct({ kind: Schema.Literal('run.delete'), ...runScoped }),
  Schema.Struct({ kind: Schema.Literal('run.compact'), ...runScoped }),
  /** The user's title for the run: a `run.description` row by the user,
   *  which a later model title does not replace. */
  Schema.Struct({
    kind: Schema.Literal('run.rename'),
    ...runScoped,
    title: Schema.Trim.check(Schema.isMinLength(1)),
  }),
  /**
   * A new task holding this run's conversation up to `at`, the `seq` of a
   * settled position in its history (its latest when absent): answered with
   * the new run's id, which waits for its host to resume it.
   */
  Schema.Struct({
    kind: Schema.Literal('run.fork'),
    ...runScoped,
    at: Schema.optional(
      Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
    ),
  }),
  /** Switch a live run to `model` from its next model boundary. */
  Schema.Struct({
    kind: Schema.Literal('run.model'),
    ...runScoped,
    model: Schema.String.check(Schema.isMinLength(1)),
  }),
  /**
   * A stopped run's directory, copied to `to` (workspace-relative) or
   * removed, under its claim by the process that holds the run's session.
   */
  Schema.Struct({
    kind: Schema.Literal('run.files'),
    ...runScoped,
    files: Schema.Union([
      Schema.Struct({
        op: Schema.Literal('copy'),
        to: Schema.String.check(Schema.isMinLength(1)),
      }),
      Schema.Struct({ op: Schema.Literal('remove') }),
    ]),
  }),
  Schema.Struct({
    kind: Schema.Literal('followUp.send'),
    ...runScoped,
    text: Schema.String.check(Schema.isMinLength(1)),
    displayText: Schema.optional(Schema.NullOr(Schema.String)),
    mediaFiles: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  }),
  /**
   * The one answer to a `request.opened` (one run model, section 3.7): the
   * decision lands as that run's `request.decided` row, which is what the
   * waiting run, the recovery bindings, and every surface read. A decision
   * for a request its run is not parked on is delivered as a follow-up.
   * `useOwnApiKey` is the host command that ends in
   * `{ action: 'retry', credentials: 'personal' }` here.
   */
  Schema.Struct({
    kind: Schema.Literal('request.decide'),
    ...runScoped,
    requestId: Schema.String.check(Schema.isMinLength(1)),
    decision: RequestDecisionSchema,
  }),
  /** A pending tool edit's preview, as the session's host staged it beside
   *  the request: answered `preview`, null when none is staged. */
  Schema.Struct({
    kind: Schema.Literal('request.preview'),
    ...runScoped,
    requestId: Schema.String.check(Schema.isMinLength(1)),
  }),
  /** The field-level mutation, not a snapshot: the authority applies it and
   *  publishes the resulting `approval.policy`. */
  Schema.Struct({
    kind: Schema.Literal('policy.set'),
    change: Schema.Union([
      Schema.Struct({
        field: Schema.Literal('bypass'),
        ...runScoped,
        bypass: Schema.Enum(APPROVAL_BYPASS_KINDS),
        enabled: Schema.Boolean,
        /** Turning a bypass on also approves the run's requests already
         *  pending under it. This one is the surface's own, decided by the
         *  `request.decide` that follows, which may carry more than a plain
         *  approval. */
        exceptRequestId: Schema.optional(Schema.String),
      }),
      /** Narrow the run's limit at once (a chat's `/approval`): it only
       *  ever lowers, never raises, the run's own limit. */
      Schema.Struct({
        field: Schema.Literal('limit'),
        ...runScoped,
        limit: Schema.Enum(APPROVAL_POLICY_LIMITS),
      }),
    ]),
  }),
]);
export type RuntimeRequest = typeof RuntimeRequestSchema.Type;

/** One unified-diff hunk: the line ranges it spans on each side, and its
 *  lines, each marked ` `, `-` or `+` (`\` notes a missing final newline). */
const DiffHunkSchema = Schema.Struct({
  oldStart: Schema.Int,
  oldLines: Schema.Int,
  newStart: Schema.Int,
  newLines: Schema.Int,
  lines: Schema.Array(Schema.String),
});

/** What a pending tool edit would change: the original and proposed
 *  content a host shows beside the request's path and line counts, and
 *  the diff between them, computed once where the request is built: its
 *  hunks and the 0-based line of the proposed text a diff view reveals
 *  first (null when nothing changed). */
export const ToolEditContentSchema = Schema.Struct({
  originalContent: Schema.String,
  proposedContent: Schema.String,
  hunks: Schema.Array(DiffHunkSchema),
  firstChangedLine: Schema.NullOr(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
});
/** A pending tool edit's staged content (`request.preview`). */
export type ToolEditContent = typeof ToolEditContentSchema.Type;

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
const RunFilesResultSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('done'),
    to: Schema.optional(Schema.String),
  }),
  Schema.Struct({ status: Schema.Literal('noFiles') }),
  Schema.Struct({ status: Schema.Literal('error'), error: Schema.String }),
]);
/** What a `run.files` request did. */
export type RunFilesResult = typeof RunFilesResultSchema.Type;

/** What the runtime answers with: a typed value the host renders. */
export const OutcomeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('done') }),
  Schema.Struct({
    kind: Schema.Literal('followUp'),
    status: Schema.Literals(['sent', 'queued']),
    /** A queued input whose recovery wake did not reach the run. */
    wake: Schema.optional(Schema.NullOr(Schema.Literal('failed'))),
  }),
  Schema.Struct({ kind: Schema.Literal('forked'), runId: RunIdSchema }),
  Schema.Struct({
    kind: Schema.Literal('preview'),
    preview: Schema.NullOr(ToolEditContentSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal('runFiles'),
    result: RunFilesResultSchema,
  }),
]);
export type Outcome = typeof OutcomeSchema.Type;
