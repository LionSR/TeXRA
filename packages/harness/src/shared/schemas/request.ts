/**
 * The one request vocabulary for everything a run asks a person: what a
 * request shows (`PermissionPayload`, the payload of `request.opened`) and
 * how a surface answers it (`RequestDecision`, the decision of
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

import type { ApprovalBypassKind } from '@shared/approvalBypassKind';
import { RunIdSchema } from './identifiers';
import { JsonValueSchema } from './jsonValue';
import {
  AgentProposalPermissionSchema,
  BashPermissionSchema,
  PlanApprovalPermissionSchema,
  RetryPermissionSchema,
  ToolEditPermissionSchema,
  UserQuestionAnswersSchema,
  UserQuestionPermissionSchema,
} from './prompts';

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
/** A request a plugin opens (`PermissionPayload`'s plugin case). */
export type PluginRequest = typeof PluginRequestSchema.Type;

/** What a pending request shows (diff, command, question), never host
 *  handles: the payload of `request.opened`. The harness's own kinds, and
 *  a plugin's request. */
export const PermissionPayloadSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('toolEdit'),
    data: ToolEditPermissionSchema,
  }),
  Schema.Struct({ kind: Schema.Literal('bash'), data: BashPermissionSchema }),
  Schema.Struct({ kind: Schema.Literal('retry'), data: RetryPermissionSchema }),
  Schema.Struct({
    kind: Schema.Literal('proposal'),
    data: AgentProposalPermissionSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('planApproval'),
    data: PlanApprovalPermissionSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('userQuestion'),
    data: UserQuestionPermissionSchema,
  }),
  PluginRequestSchema,
]);
/** A pending request's payload, as {@link PermissionPayloadSchema} reads it. */
export type PermissionPayload = typeof PermissionPayloadSchema.Type;
/**
 * The one request kind vocabulary, read off the payload union. The
 * `request.opened` fact and every surface that lists pending requests key
 * off it, so a spelling that drifts fails to compile.
 */
export type ProgressPermissionKind = PermissionPayload['kind'];
/** The kinds the harness opens itself. */
type OwnKind = Exclude<PermissionPayload, PluginRequest>['kind'];

/**
 * Whether a request blocks the tool that opened it: every kind the harness
 * opens does, and a plugin's request as it declares. One that does not
 * leaves its run working; its plugin's decision hook delivers the answer to
 * whichever process holds the run by then, so it stays open across every
 * resume. The folds and the decision door all read this one predicate.
 */
export const blocksCaller = (payload: PermissionPayload): boolean =>
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
export type DecisionOf<K extends PermissionPayload['kind']> =
  | Extract<
      RequestDecision,
      {
        action: (typeof OWN_ANSWERS & {
          readonly plugin: PluginRequest['answers'];
        })[K][number];
      }
    >
  | RefusalDecision;

/** The request kinds each bypass approves; the delegated-work grant covers
 *  all three. A question, a retry, a plan approval and a plugin's request
 *  never appear here: they need an answer, or carry their own credential
 *  semantics. */
const COVERED_KINDS: Readonly<
  Record<ApprovalBypassKind, readonly PermissionPayload['kind'][]>
> = {
  bash: ['bash'],
  toolEdit: ['toolEdit'],
  superYolo: ['proposal', 'toolEdit', 'bash'],
};

/** Whether `bypass` approves requests of `kind`. */
export const bypassCovers = (
  bypass: ApprovalBypassKind,
  kind: PermissionPayload['kind'],
): boolean => COVERED_KINDS[bypass].includes(kind);

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
 * Why `payload` cannot take this answer, or null when it can: a decision it
 * does not offer, or a session grant that is not an approval its kind's
 * bypass covers.
 */
export function answerMismatch(
  payload: PermissionPayload,
  decision: RequestDecision,
  grant?: ApprovalBypassKind | null,
): string | null {
  const { action } = decision;
  const { kind } = payload;
  if (!decisionFits(payload, decision))
    return `A ${kind} request is not answered with "${action}".`;
  if (grant != null && (action !== 'approve' || !bypassCovers(grant, kind)))
    return `A ${kind} request's "${action}" cannot grant the ${grant} bypass.`;
  return null;
}
