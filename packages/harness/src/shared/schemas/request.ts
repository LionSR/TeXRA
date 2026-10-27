/**
 * The one decision vocabulary for everything a run asks a person (one run
 * model, section 3.7). A run opens a request with `request.opened` and a
 * surface answers it with `request.decided { requestId, decision }`; pending
 * is the fold, opened without decided. Every kind of request
 * (`PermissionPayload['kind']`) is answered with an arm of this union, so the
 * frontend action vocabulary, the runtime's reading, and the recovery
 * bindings (a model retry's `failed` row) read one word.
 *
 * The three refusal arms are the three provenances a declined request can
 * have, each carrying the fact that names it: `reject` is a person declining
 * (with optional feedback for the agent), `deny` is a policy or a headless
 * host with no person to ask (`reason`), and `cancel` is an automatic close
 * (the run ended, the session was disposed) with its `cause`.
 */
import { Schema } from 'effect';

import { JsonValueSchema } from './jsonValue';
import { UserQuestionAnswersSchema } from './prompts';

/**
 * The answer to a request a run opened, one arm per way of answering: approve
 * (a proposal's edited launch or an edited file may ride along), approve as an
 * autonomous goal, submit a question's answers, answer an inquiry, skip,
 * retry, or the three refusals (`reject` by a person, `deny` by policy,
 * `cancel` by an automatic close). A surface writes it as the
 * `request.decided` row; the tool that opened the request reads it.
 */
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
  /** An inquiry's answer, pasted back from the external model. */
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
/** The decoded shape of {@link RequestDecisionSchema}. */
export type RequestDecision = typeof RequestDecisionSchema.Type;

/** The arms that decline a request, whatever the provenance. */
export type RefusalDecision = Extract<
  RequestDecision,
  { action: 'reject' | 'deny' | 'cancel' }
>;
