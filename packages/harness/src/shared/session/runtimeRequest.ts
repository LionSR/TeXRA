/**
 * The runtime request protocol: one
 * union of the requests a surface issues to its session's runtime and the
 * outcomes the runtime answers with. In process (the TUI, headless) the
 * Effect's own result is the response and no message exists; the envelope
 * and response a bridge posts arrive with that bridge.
 *
 * Arm tags are `group.action` throughout, so two groups cannot claim one
 * tag. Every run-scoped arm names a bare `runId`: a `RunId` names one run
 * for its whole life, so a request that waits while its run is
 * deleted can only miss, never land on a different run.
 * The union carries the arms the runtime answers today; a lane that routes
 * another retained command adds its arm with its handler. A start is not a
 * request: it is `StartRequestSchema`, beside it.
 */
import { Schema, Struct } from 'effect';

import {
  APPROVAL_BYPASS_KINDS,
  APPROVAL_POLICY_LIMITS,
} from '@shared/approvalBypassKind';
import { ApprovalPolicySchema } from '@shared/approvalPolicy';
import {
  AgentConfigSchema,
  FollowUpReceiptSchema,
  InlinePersonaSchema,
  RequestDecisionSchema,
  RunIdSchema,
  StoredMediaSchema,
  RunStopReasonSchema,
  ToolEditContentSchema,
} from '@shared/schemas';

const runScoped = { runId: RunIdSchema };

/** Every request a surface issues to its session's runtime, one arm per
 *  `group.action` tag. */
export const RuntimeRequestSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('run.stop'),
    ...runScoped,
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
  /** A message to the run, under the caller's `id` (minted when absent): a
   *  retry under it answers with the first send's receipt, even once the run
   *  takes no more input; another message under it is a {@link Conflict}. */
  Schema.Struct({
    kind: Schema.Literal('followUp.send'),
    ...runScoped,
    id: Schema.optional(
      Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
    ),
    text: Schema.String.check(Schema.isMinLength(1)),
    displayText: Schema.optional(Schema.NullOr(Schema.String)),
    /** What the message attaches: a file (a pasted image's), read and
     *  stored once here, or media the store already holds (a fork's). */
    media: Schema.optional(
      Schema.NullOr(
        Schema.Array(Schema.Union([Schema.String, StoredMediaSchema])),
      ),
    ),
    /** `turn`: the run reads the message when its current turn ends, not
     *  at the turn's next model request. Absent: at the next request. */
    holdUntil: Schema.optional(Schema.NullOr(Schema.Literal('turn'))),
  }),
  /** The receipt of the message sent under `id`; with `wait`, once it is
   *  answered or unanswered. */
  Schema.Struct({
    kind: Schema.Literal('followUp.receipt'),
    ...runScoped,
    id: Schema.String.check(Schema.isMinLength(1)),
    wait: Schema.optional(Schema.NullOr(Schema.Boolean)),
  }),
  /**
   * The one answer to a `request.opened` (one run model, section 3.7): the
   * decision lands as that run's `request.decided` row, which is what the
   * waiting run, the recovery bindings, and every surface read. A decision
   * for a request its run is not blocked on is delivered as a follow-up.
   * `useOwnApiKey` is the host command that ends in
   * `{ action: 'retry', credentials: 'personal' }` here. `grant` approves
   * for the session: the run's bypass of that kind turns on with the
   * decision, recorded as its `approval.policy` row, never in the decision.
   */
  Schema.Struct({
    kind: Schema.Literal('request.decide'),
    ...runScoped,
    requestId: Schema.String.check(Schema.isMinLength(1)),
    decision: RequestDecisionSchema,
    grant: Schema.optional(
      Schema.NullOr(Schema.Literals(APPROVAL_BYPASS_KINDS)),
    ),
  }),
  /** A pending tool edit's content, stored with its request: answered
   *  `preview`, null once the request is no longer pending. */
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
        bypass: Schema.Literals(APPROVAL_BYPASS_KINDS),
        /** Turning a bypass on also approves the run's requests already
         *  pending under it. */
        enabled: Schema.Boolean,
      }),
      /** Narrow the run's limit at once (a chat's `/approval`): it only
       *  ever lowers, never raises, the run's own limit. */
      Schema.Struct({
        field: Schema.Literal('limit'),
        ...runScoped,
        limit: Schema.Literals(APPROVAL_POLICY_LIMITS),
      }),
    ]),
  }),
]);
/** One request a surface issues to its session's runtime. */
export type RuntimeRequest = typeof RuntimeRequestSchema.Type;

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
  /** A message accepted, now or by an earlier send under its `id`. */
  Schema.Struct({
    kind: Schema.Literal('followUp'),
    id: Schema.String,
    status: Schema.Literals(['sent', 'queued']),
    /** A queued input whose recovery wake did not reach the run. */
    wake: Schema.optional(Schema.NullOr(Schema.Literal('failed'))),
    receipt: FollowUpReceiptSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('receipt'),
    receipt: FollowUpReceiptSchema,
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
/** What the runtime answers a request with. */
export type Outcome = typeof OutcomeSchema.Type;

/** The requests answered with something other than `done`, by kind. */
const OUTCOME_KIND = {
  'run.fork': 'forked',
  'run.files': 'runFiles',
  'followUp.send': 'followUp',
  'followUp.receipt': 'receipt',
  'request.preview': 'preview',
} as const satisfies Partial<Record<RuntimeRequest['kind'], Outcome['kind']>>;

/** What a request of kind `K` is answered with: `done` unless it is one of
 *  the kinds above. */
export type OutcomeOf<K extends RuntimeRequest['kind']> = Extract<
  Outcome,
  {
    kind: K extends keyof typeof OUTCOME_KIND
      ? (typeof OUTCOME_KIND)[K]
      : 'done';
  }
>;

/** Whether `outcome` answers a request of `kind`: how a client reads an
 *  answer that crossed a process boundary. */
export const isOutcomeOf = <K extends RuntimeRequest['kind']>(
  kind: K,
  outcome: Outcome,
): outcome is OutcomeOf<K> => {
  const kinds: Partial<Record<RuntimeRequest['kind'], Outcome['kind']>> =
    OUTCOME_KIND;
  return outcome.kind === (kinds[kind] ?? 'done');
};

// How a runtime request fails. Yieldable `Schema.TaggedError`s in the
// runtime, carried over the RPC edge as themselves (`RequestErrorSchema`);
// `Invalid` is the arm a bridge that parses requests answers with. A request
// naming a stream the runtime no longer has is `Unavailable`, never a
// defect: with two surfaces on one session, one can act from a view that has
// not yet folded the other's `run.removed`, and a defect would bypass the
// response path and leave the sender's latch pending forever.

/** Another live owner holds the run this request would act on. */
export class NotOwner extends Schema.TaggedError<NotOwner>()('NotOwner', {
  runId: RunIdSchema,
}) {}

/** The stream, request, or run the request names is gone or not in a state
 *  that can take it. */
export class Unavailable extends Schema.TaggedError<Unavailable>()(
  'Unavailable',
  { runId: RunIdSchema, reason: Schema.String },
) {}

/** A `followUp.send` under an `id` the run holds another message under. */
export class Conflict extends Schema.TaggedError<Conflict>()('Conflict', {
  runId: RunIdSchema,
  id: Schema.String,
}) {
  override get message(): string {
    return `A different message was already sent under id ${this.id}.`;
  }
}

/** Nothing is left to tell the user: they cancelled the operation, or the
 *  host has already told them why it did not go through. No refusal notice
 *  is needed. */
export class Cancelled extends Schema.TaggedError<Cancelled>()(
  'Cancelled',
  {},
) {}

/** The runtime refused the request for a worded reason, which is also its
 *  `message`, so a caller that only formats errors still shows why. */
export class Rejected extends Schema.TaggedError<Rejected>()('Rejected', {
  reason: Schema.String,
  docsPage: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return this.reason;
  }
}

/** A handler died. The cause is in the host log under `ref` (the request
 *  id); the surface hears that the request failed, never the text. */
export class Internal extends Schema.TaggedError<Internal>()('Internal', {
  ref: Schema.String,
}) {}

/** The request could not be parsed: a bridge's answer, never the runtime's. */
export class Invalid extends Schema.TaggedError<Invalid>()('Invalid', {
  reason: Schema.String,
}) {}

/** The wire form of a request's failure: the classes themselves. */
export const RequestErrorSchema = Schema.Union([
  NotOwner,
  Unavailable,
  Cancelled,
  Rejected,
  Conflict,
  Invalid,
  Internal,
]);
/** How a runtime request fails: one of the tagged errors above. */
export type RequestError = typeof RequestErrorSchema.Type;

/**
 * How a host's request handler fails: with a tagged error, always. Four tags are the refusals the bridge folds
 * onto the wire ({@link RequestRefusal}); every other tag is a defect it
 * logs and answers `Internal` — but it is a *named* defect, so the log says
 * which capability produced it. The bound is structural because the tags a
 * host raises are its own (its lifted capabilities, its preview host, its
 * housekeeping); what every host owes this channel is that each of them is
 * a tag, so a bare `new Error(...)` can no longer reach the fold.
 */
export interface HostRequestFailure extends Error {
  readonly _tag: string;
}

/**
 * A request's refusal, as opposed to its defect: the four a handler may
 * answer the surface with. The bridge folds these onto the wire; every other
 * tag is `Internal`.
 */
export type RequestRefusal = Cancelled | Unavailable | Rejected | Conflict;

/** Whether a failure is one of the four the bridge answers on the wire. */
export function isRequestRefusal(error: unknown): error is RequestRefusal {
  return (
    error instanceof Cancelled ||
    error instanceof Unavailable ||
    error instanceof Rejected ||
    error instanceof Conflict
  );
}

/** What a start takes besides its agent, whichever way the agent is given.
 *  Each is read once, as the run opens: its effect lands in the opening's
 *  rows, or the loop reads it and a resume passes it again (`interactive`).
 *  An option a resumed run must keep goes on `AgentConfigSchema` instead. */
export const StartOptionsSchema = Schema.Struct({
  /** The run's id. Absent, one is generated. */
  runId: Schema.optional(RunIdSchema),
  /** The earlier run this one continues in a chat: the new run starts with
   *  the approvals the person granted there. */
  continues: Schema.optional(RunIdSchema),
  /** Run on the configured helper model instead of the selected one. */
  helperModel: Schema.optional(Schema.Boolean),
  /** A stricter approval policy for this run (it only narrows the
   *  project's), and whether the work it delegates starts approved. */
  approval: Schema.optional(
    Schema.Struct({
      policy: Schema.optional(ApprovalPolicySchema),
      delegated: Schema.optional(Schema.Boolean),
    }),
  ),
  /** Keep the run open for follow-up messages after each answer, as a chat
   *  window does. Absent, the run ends after its first answer. */
  interactive: Schema.optional(Schema.Boolean),
});

/**
 * A start as data: all of `StartInput` but the run's own tools. Either an
 * agent (a name from the agent directories, or a persona written inline,
 * which the run stores so a resume needs no file) and the instruction to
 * give it, or `config`, a complete configuration an application host has
 * already resolved. A host sends it to a service as it is.
 */
export const StartRequestSchema = Schema.Union([
  StartOptionsSchema.mapFields(
    Struct.assign({
      // The persona as an embedder writes it; the start decodes it.
      agent: Schema.Union([
        Schema.String,
        Schema.toEncoded(InlinePersonaSchema),
      ]),
      instruction: Schema.String,
      model: Schema.optional(Schema.String),
    }),
  ),
  StartOptionsSchema.mapFields(Struct.assign({ config: AgentConfigSchema })),
]);
