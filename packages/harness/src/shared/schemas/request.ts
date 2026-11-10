/**
 * The one request vocabulary for everything a run asks a person: what a
 * request shows (`RequestPayload`, the payload of `request.opened`), who
 * answers it (`AnsweredBy`, beside the payload on that row) and how a
 * surface answers it (`RequestDecision`, the decision of
 * `request.decided`); pending is the fold, opened without decided. Every
 * kind of request is answered with an arm of the decision union, so the
 * frontend action vocabulary, the runtime's reading, and the recovery
 * bindings (a model retry's `failed` row) read one word. The harness's own
 * kinds declare what they take here; a plugin's request declares it on its
 * row.
 *
 * The three refusal arms are the three provenances a declined request can
 * have, each carrying the fact that names it: `reject` is a person declining
 * (with optional feedback for the agent), `deny` is a policy or a headless
 * host with no person to ask (`reason`), and `cancel` is an automatic close
 * (the run ended, the session was disposed) with its `cause`.
 */
import { Schema } from 'effect';

import {
  APPROVAL_BYPASS_KINDS,
  type ApprovalBypassKind,
} from '@shared/approvalBypassKind';
import { RunIdSchema } from './identifiers';
import { JsonValueSchema } from './jsonValue';
import {
  AgentProposalRequestSchema,
  BashRequestSchema,
  PlanApprovalRequestSchema,
  RetryRequestSchema,
  ToolEditRequestSchema,
  UserQuestionAnswersSchema,
  UserQuestionRequestSchema,
} from './requestPayloads';

export const RequestDecisionSchema = Schema.Union([
  /** A plain approval. A proposal's approve may carry what the person
   *  changed in the launch form (its agent, model, instruction, files and
   *  plugin options); a tool edit's approve carries the proposed file as the
   *  user left it in the host's diff view. */
  Schema.Struct({
    action: Schema.Literal('approve'),
    model: Schema.optional(Schema.NullOr(Schema.String)),
    agent: Schema.optional(Schema.NullOr(Schema.String)),
    instruction: Schema.optional(Schema.NullOr(Schema.String)),
    inputFiles: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    contextFiles: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    mediaFiles: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    options: Schema.optional(
      Schema.NullOr(Schema.Record(Schema.String, JsonValueSchema)),
    ),
    content: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    action: Schema.Literal('approve_and_goal'),
    autoApproveAll: Schema.optional(Schema.NullOr(Schema.Literal(true))),
  }),
  /** A user question's answers, keyed by question text. */
  Schema.Struct({
    action: Schema.Literal('submit'),
    answers: UserQuestionAnswersSchema,
  }),
  /** A written answer, with the links the person cites. */
  Schema.Struct({
    action: Schema.Literal('answer'),
    answer: Schema.String,
    sessionLinks: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  }),
  Schema.Struct({
    action: Schema.Literal('skip'),
    feedback: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  /** A retry, on the configured credentials or on the user's own key once
   *  the host has stored one (`credentials: 'personal'`). */
  Schema.Struct({
    action: Schema.Literal('retry'),
    feedback: Schema.optional(Schema.NullOr(Schema.String)),
    credentials: Schema.optional(
      Schema.NullOr(Schema.Literals(['configured', 'personal'])),
    ),
  }),
  Schema.Struct({
    action: Schema.Literal('reject'),
    feedback: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({ action: Schema.Literal('deny'), reason: Schema.String }),
  Schema.Struct({
    action: Schema.Literal('cancel'),
    cause: Schema.optional(Schema.NullOr(Schema.String)),
  }),
]);
export type RequestDecision = typeof RequestDecisionSchema.Type;

/** The arms that decline a request, whatever the provenance. */
export type RefusalDecision = Extract<
  RequestDecision,
  { action: 'reject' | 'deny' | 'cancel' }
>;

/** The actions that answer a request, as against the three refusals any
 *  request takes. */
const AnswerActionSchema = Schema.Literals([
  'approve',
  'approve_and_goal',
  'submit',
  'answer',
  'skip',
  'retry',
] as const satisfies readonly Exclude<
  RequestDecision['action'],
  RefusalDecision['action']
>[]);

/**
 * A request a plugin opens in its own vocabulary, with what it takes
 * declared by the plugin: whether the tool that opened it waits on it
 * (`blocksCaller`), and the actions it is answered with besides the three
 * refusals (`answers`). `data` is the plugin's: the harness stores it and
 * reads no more of it than the request and run it names. The plugin's
 * decision hook (`Plugin.decision`) records each answer before it commits.
 */
const PluginRequestSchema = Schema.Struct({
  kind: Schema.Literal('plugin'),
  /** The plugin that opened it, whose decision hook takes its answers. */
  plugin: Schema.String,
  blocksCaller: Schema.Boolean,
  answers: Schema.Array(AnswerActionSchema),
  data: Schema.StructWithRest(
    Schema.Struct({ requestId: Schema.String, runId: RunIdSchema }),
    [Schema.Record(Schema.String, JsonValueSchema)],
  ),
});
/** A request a plugin opens (`RequestPayload`'s plugin case). */
export type PluginRequest = typeof PluginRequestSchema.Type;

/** What a pending request shows (diff, command, question), never host
 *  handles: the payload of `request.opened`. The harness's own kinds, and
 *  a plugin's request. */
export const RequestPayloadSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('toolEdit'),
    data: ToolEditRequestSchema,
  }),
  Schema.Struct({ kind: Schema.Literal('bash'), data: BashRequestSchema }),
  Schema.Struct({ kind: Schema.Literal('retry'), data: RetryRequestSchema }),
  Schema.Struct({
    kind: Schema.Literal('proposal'),
    data: AgentProposalRequestSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('planApproval'),
    data: PlanApprovalRequestSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('userQuestion'),
    data: UserQuestionRequestSchema,
  }),
  PluginRequestSchema,
]);
/** A pending request's payload, as {@link RequestPayloadSchema} reads it. */
export type RequestPayload = typeof RequestPayloadSchema.Type;
/**
 * The one request kind vocabulary, read off the payload union. The
 * `request.opened` fact and every surface that lists pending requests key
 * off it, so a spelling that drifts fails to compile.
 */
export type RequestKind = RequestPayload['kind'];
/** The kinds the harness opens itself. */
type OwnKind = Exclude<RequestPayload, PluginRequest>['kind'];

/**
 * Whether a request blocks the tool that opened it: every kind the harness
 * opens does, and a plugin's request as it declares. One that does not
 * leaves its run working; its plugin's decision hook delivers the answer to
 * whichever process holds the run by then, so it stays open across every
 * resume. The folds and the decision door all read this one predicate.
 */
export const blocksCaller = (payload: RequestPayload): boolean =>
  payload.kind !== 'plugin' || payload.blocksCaller;

/** The actions each of the harness's own kinds takes besides the three
 *  refusals. */
const OWN_ANSWERS = {
  toolEdit: ['approve'],
  bash: ['approve'],
  proposal: ['approve'],
  planApproval: ['approve', 'approve_and_goal'],
  retry: ['retry'],
  userQuestion: ['submit', 'skip'],
} as const satisfies Record<OwnKind, PluginRequest['answers']>;

/** What names the answers a request takes: one of the harness's own kinds,
 *  or a plugin's request with the answers it declared. */
type AnswerSource =
  | { readonly kind: OwnKind }
  | Pick<PluginRequest, 'kind' | 'answers'>;

/** The decisions a request of kind `K` takes: its own actions and the three
 *  refusals. A plugin's request declares its actions on its row, so its
 *  type admits any decision. */
export type DecisionOf<K extends RequestPayload['kind']> =
  | Extract<
      RequestDecision,
      {
        action: (typeof OWN_ANSWERS & {
          readonly plugin: PluginRequest['answers'];
        })[K][number];
      }
    >
  | RefusalDecision;

/**
 * Who answers a request: a person, or the run grant that answers it
 * unasked, as it opens or, turned on while it waits, in the transaction
 * that records the grant. Decided once as the request opens
 * (`openRequest`), from the operation it asks about and what the call's
 * hooks said, and stored on its `request.opened`: a request a hook asked
 * about, a question, a retry and a plugin's request are a person's.
 */
export const AnsweredBySchema = Schema.Union([
  Schema.Literal('person'),
  Schema.Literals(APPROVAL_BYPASS_KINDS),
]);
/** Who answers a request ({@link AnsweredBySchema}). */
export type AnsweredBy = typeof AnsweredBySchema.Type;

/** The grants that stand for each grant: its own, and the delegated-work
 *  grant, which stands for every one. */
const STANDS_FOR: Readonly<
  Record<ApprovalBypassKind, readonly ApprovalBypassKind[]>
> = {
  bash: ['bash', 'superYolo'],
  toolEdit: ['toolEdit', 'superYolo'],
  superYolo: ['superYolo'],
};

/** Whether a grant `held` answers a request `answeredBy` names: one that
 *  stands for its grant. None answers a person's. */
export const grantAnswering = (
  held: (bypass: ApprovalBypassKind) => boolean,
  answeredBy: AnsweredBy,
): boolean => answeredBy !== 'person' && STANDS_FOR[answeredBy].some(held);

/** The run grant a request offers to turn on ("approve all in this
 *  task"): the one that answers it, none for a person's. The one reading
 *  every surface renders the offer from. */
export const offeredGrant = (request: {
  readonly answeredBy: AnsweredBy;
}): ApprovalBypassKind | null =>
  request.answeredBy === 'person' ? null : request.answeredBy;

/** Whether `decision` is one `request` takes ({@link DecisionOf}). */
export function decisionFits<P extends AnswerSource>(
  request: P,
  decision: RequestDecision,
): decision is DecisionOf<P['kind']> {
  const answers: readonly RequestDecision['action'][] =
    request.kind === 'plugin' ? request.answers : OWN_ANSWERS[request.kind];
  return (
    decision.action === 'reject' ||
    decision.action === 'deny' ||
    decision.action === 'cancel' ||
    answers.includes(decision.action)
  );
}

/**
 * Why `request` cannot take this answer, or null when it can: a decision
 * it does not offer, or a run grant that is not an approval under a grant
 * that answers it ({@link grantAnswering}).
 */
export function answerMismatch(
  request: {
    readonly payload: RequestPayload;
    readonly answeredBy: AnsweredBy;
  },
  decision: RequestDecision,
  grant?: ApprovalBypassKind | null,
): string | null {
  const { action } = decision;
  const { payload, answeredBy } = request;
  const { kind } = payload;
  if (!decisionFits(payload, decision))
    return `A ${kind} request is not answered with "${action}".`;
  if (
    grant != null &&
    (action !== 'approve' ||
      !grantAnswering((held) => held === grant, answeredBy))
  )
    return `A ${kind} request's "${action}" cannot grant the ${grant} bypass.`;
  return null;
}
