/**
 * The one request vocabulary for everything a run asks a person: what a
 * request shows (`RequestPayload`, the payload of `request.opened`), who
 * answers it (`AnsweredBy`, beside the payload on that row) and how a
 * surface answers it (`RequestDecision`, the decision of
 * `request.decided`); pending is the fold, opened without decided. Every
 * kind of request is answered with an arm of the decision union, so the
 * frontend action vocabulary, the runtime's reading, and the recovery
 * bindings (a model retry's `failed` row) read one word. The kinds are a
 * closed set the harness declares, each with the answers it takes
 * ({@link REQUEST_ANSWERS}); every request blocks the call or turn that
 * opened it, and one decision answers it and lets that one waiting call go
 * on.
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
import {
  AgentProposalRequestSchema,
  BashRequestSchema,
  PlanApprovalRequestSchema,
  PluginTrustRequestSchema,
  RetryRequestSchema,
  ToolEditRequestSchema,
  UserQuestionAnswersSchema,
  UserQuestionRequestSchema,
} from './requestPayloads';

/** What a person changed in a proposal's launch form before approving it:
 *  its agent and model when they are not the proposal's, its instruction
 *  and file lists as the form holds them. */
const ProposalEditSchema = Schema.Struct({
  kind: Schema.Literal('proposal'),
  model: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  instruction: Schema.optional(Schema.String),
  inputFiles: Schema.optional(Schema.Array(Schema.String)),
  contextFiles: Schema.optional(Schema.Array(Schema.String)),
  mediaFiles: Schema.optional(Schema.Array(Schema.String)),
});
/** A proposal approval's changes ({@link ProposalEditSchema}). */
export type ProposalEdit = typeof ProposalEditSchema.Type;

/** What an approval changed in what it approves, named by the request kind
 *  it belongs to: a proposal's launch form, or a tool edit's proposed file
 *  as the user left it in the host's diff view. */
const ApprovalEditSchema = Schema.Union([
  ProposalEditSchema,
  Schema.Struct({ kind: Schema.Literal('toolEdit'), content: Schema.String }),
]);

export const RequestDecisionSchema = Schema.Union([
  /** An approval, with what the person changed when its kind takes an
   *  edit ({@link ApprovalEditSchema}). */
  Schema.Struct({
    action: Schema.Literal('approve'),
    edit: Schema.optional(ApprovalEditSchema),
  }),
  Schema.Struct({
    action: Schema.Literal('approve_and_goal'),
    autoApproveAll: Schema.optional(Schema.Literal(true)),
  }),
  /** A user question's answers, keyed by question text. */
  Schema.Struct({
    action: Schema.Literal('submit'),
    answers: UserQuestionAnswersSchema,
  }),
  Schema.Struct({
    action: Schema.Literal('skip'),
    feedback: Schema.optional(Schema.String),
  }),
  /** A retry, on the configured credentials or on the user's own key once
   *  the host has stored one (`credentials: 'personal'`). */
  Schema.Struct({
    action: Schema.Literal('retry'),
    feedback: Schema.optional(Schema.String),
    credentials: Schema.optional(Schema.Literals(['configured', 'personal'])),
  }),
  Schema.Struct({
    action: Schema.Literal('reject'),
    feedback: Schema.optional(Schema.String),
  }),
  Schema.Struct({ action: Schema.Literal('deny'), reason: Schema.String }),
  Schema.Struct({
    action: Schema.Literal('cancel'),
    cause: Schema.optional(Schema.String),
  }),
]);
export type RequestDecision = typeof RequestDecisionSchema.Type;

/** The arms that decline a request, whatever the provenance. */
export type RefusalDecision = Extract<
  RequestDecision,
  { action: 'reject' | 'deny' | 'cancel' }
>;

/** What a pending request shows (diff, command, question), never host
 *  handles: the payload of `request.opened`. */
export const RequestPayloadSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('toolEdit'),
    data: ToolEditRequestSchema,
  }),
  Schema.Struct({ kind: Schema.Literal('bash'), data: BashRequestSchema }),
  Schema.Struct({
    kind: Schema.Literal('pluginTrust'),
    data: PluginTrustRequestSchema,
  }),
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
]);
/** A pending request's payload, as {@link RequestPayloadSchema} reads it. */
export type RequestPayload = typeof RequestPayloadSchema.Type;
/**
 * The one request kind vocabulary, read off the payload union. The
 * `request.opened` fact and every surface that lists pending requests key
 * off it, so a spelling that drifts fails to compile.
 */
export type RequestKind = RequestPayload['kind'];
/** The actions that answer a request, as against the three refusals any
 *  request takes. */
type AnswerAction = Exclude<
  RequestDecision['action'],
  RefusalDecision['action']
>;

/** The actions each kind takes besides the three refusals. */
const REQUEST_ANSWERS = {
  toolEdit: ['approve'],
  bash: ['approve'],
  pluginTrust: ['approve'],
  proposal: ['approve'],
  planApproval: ['approve', 'approve_and_goal'],
  retry: ['retry'],
  userQuestion: ['submit', 'skip'],
} as const satisfies Record<RequestKind, readonly AnswerAction[]>;

/** The decisions a request of kind `K` takes: its own actions and the three
 *  refusals, an approval carrying only its own kind's edit. */
export type DecisionOf<K extends RequestKind> =
  | Exclude<
      Extract<RequestDecision, { action: (typeof REQUEST_ANSWERS)[K][number] }>,
      { action: 'approve' }
    >
  | ('approve' extends (typeof REQUEST_ANSWERS)[K][number]
      ? {
          readonly action: 'approve';
          readonly edit?: Extract<
            NonNullable<
              Extract<RequestDecision, { action: 'approve' }>['edit']
            >,
            { kind: K }
          >;
        }
      : never)
  | RefusalDecision;

/**
 * Who answers a request: a person, or the run grant that answers it
 * unasked, as it opens or, turned on while it waits, in the transaction
 * that records the grant. Decided once as the request opens
 * (`openRequest`), from the operation it asks about and what the call's
 * hooks said, and stored on its `request.opened`: a request a hook asked
 * about, a question and a retry are a person's.
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

/** Whether `decision` is one `request` takes ({@link DecisionOf}): one of
 *  its actions, an approval's edit being its own kind's. */
export function decisionFits<P extends { readonly kind: RequestKind }>(
  request: P,
  decision: RequestDecision,
): decision is DecisionOf<P['kind']> {
  const answers: readonly RequestDecision['action'][] =
    REQUEST_ANSWERS[request.kind];
  if (decision.action === 'approve' && decision.edit !== undefined)
    return decision.edit.kind === request.kind;
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
  const edit = decision.action === 'approve' ? decision.edit : undefined;
  if (!decisionFits(payload, decision))
    return edit !== undefined
      ? `A ${kind} request's approval cannot carry a ${edit.kind} edit.`
      : `A ${kind} request is not answered with "${action}".`;
  if (
    grant != null &&
    (action !== 'approve' ||
      !grantAnswering((held) => held === grant, answeredBy))
  )
    return `A ${kind} request's "${action}" cannot grant the ${grant} bypass.`;
  return null;
}
