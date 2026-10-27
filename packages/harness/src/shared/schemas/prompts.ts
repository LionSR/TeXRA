import { Schema, Struct } from 'effect';

import { RetryErrorInfoSchema } from './errors';
import { RunSelectionSchema, RunIdSchema } from './identifiers';
import {
  ExternalInquiryTurnRecordSchema,
  InquirySessionLinksSchema,
  InquiryThreadIdSchema,
} from './inquiry';
import { LineCountSchema } from './lineChanges';
import { PlanSchema } from './plan';
import {
  BaseProposalFieldsSchema,
  TaskProposalFieldsSchema,
} from './proposalFields';
import { DeclinableUsageRouteSchema } from './usage';

/** Common permission request fields */
const PermissionBaseSchema = Schema.Struct({
  requestId: Schema.String,
  allowBypass: Schema.Boolean,
  runId: RunSelectionSchema,
});

/**
 * What a pending file-edit approval shows: the file (absolute and
 * workspace-relative), the tool that proposed the edit, and the added and
 * removed line counts of its diff. The edit approval policy opens it as a
 * `request.opened` payload; the host's diff view renders it.
 */
export const ToolEditPermissionSchema = PermissionBaseSchema.mapFields(
  Struct.assign({
    path: Schema.String,
    relativePath: Schema.String,
    sourceTool: Schema.String,
    addedLines: LineCountSchema,
    removedLines: LineCountSchema,
  }),
);
/** The decoded shape of {@link ToolEditPermissionSchema}. */
export type ToolEditPermission = typeof ToolEditPermissionSchema.Type;

/**
 * What a pending shell-command approval shows: the command and the directory
 * it would run in. The bash approval policy opens it; a host renders the
 * command for the user to allow or reject.
 */
export const BashPermissionSchema = PermissionBaseSchema.mapFields(
  Struct.assign({
    command: Schema.String,
    cwd: Schema.optional(Schema.String),
  }),
);
/** The decoded shape of {@link BashPermissionSchema}. */
export type BashPermission = typeof BashPermissionSchema.Type;

/**
 * The API-key providers a stored retry offer names. Storage owns the enum
 * (the llm catalog's `ApiKeyProviderId` must stay assignable to it, which
 * `credentialSwitch` checks where it builds an offer), so a catalog
 * change is never a silent stored format change.
 */
const ApiKeyProviderIdSchema = Schema.Literals([
  'openai',
  'anthropic',
  'google',
  'xai',
  'deepseek',
  'moonshot',
  'dashscope',
  'minimax',
  'glm',
  'meta',
  'kimiCode',
]);

/**
 * The move onto the user's own credential a failed model request offers,
 * decided once by the retry owner (`ModelInvoker`) from the recorded failure
 * and the route the failed model was bound on. Hosts render it; none of them
 * re-derives it from the error.
 */
export const CredentialSwitchSchema = Schema.Union([
  /** A subscription or coding-plan quota ran out: the run declines `route`
   *  and retries on the model's own `provider` key. `automatic` records that
   *  the invoker took the switch itself (a coding plan whose fallback key is
   *  already stored), so no one was asked. */
  Schema.Struct({
    kind: Schema.Literal('decline-route'),
    route: DeclinableUsageRouteSchema,
    provider: ApiKeyProviderIdSchema,
    automatic: Schema.Boolean,
  }),
  /** The account behind the stored `provider` key is out of credit, so only
   *  a changed key can succeed. */
  Schema.Struct({
    kind: Schema.Literal('new-key'),
    provider: ApiKeyProviderIdSchema,
  }),
]);
/** The decoded shape of {@link CredentialSwitchSchema}. */
export type CredentialSwitch = typeof CredentialSwitchSchema.Type;

/**
 * What a model-request retry prompt shows once the automatic retries are
 * spent: the operation and model that failed, the error as recorded, and the
 * credential move the retry can take, if any. The retry loop opens it from the
 * failed attempt's row; the user's `retry` or `reject` decision answers it.
 */
export const RetryPermissionSchema = Schema.Struct({
  requestId: Schema.String,
  runId: RunIdSchema,
  operation: Schema.String,
  model: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
  errorDetails: Schema.optional(
    RetryErrorInfoSchema.mapFields(Struct.map(Schema.optional)),
  ),
  /** Null or absent when the failure offers no credential move. */
  credentialSwitch: Schema.optional(Schema.NullOr(CredentialSwitchSchema)),
});
/** The decoded shape of {@link RetryPermissionSchema}. */
export type RetryPermission = typeof RetryPermissionSchema.Type;

/**
 * A delegation awaiting approval: the agent and its prompt, and, for a
 * task (`task`), the files it works over and the options its plugin
 * gives it. A chat delegation has neither.
 */
export const AgentProposalSchema = BaseProposalFieldsSchema.mapFields(
  Struct.assign(TaskProposalFieldsSchema.fields),
).mapFields(
  Struct.assign({
    /** Runs the agent's task over the files, not a conversation. */
    task: Schema.Boolean,
    rootUserInstruction: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
/**
 * The decoded shape of {@link AgentProposalSchema}: a delegation as the
 * approving surface and the launch read it.
 */
export type AgentProposal = typeof AgentProposalSchema.Type;

/**
 * An {@link AgentProposalSchema} as a pending request: the proposal with the
 * request id and the run that asked. The delegation tools open it; the
 * approval panel lets the user edit the launch before approving.
 */
export const AgentProposalPermissionSchema = AgentProposalSchema.mapFields(
  Struct.assign({
    requestId: Schema.String,
    runId: RunIdSchema,
  }),
);
/** The decoded shape of {@link AgentProposalPermissionSchema}. */
export type AgentProposalPermission =
  (typeof AgentProposalPermissionSchema)['Type'];

// ============================================================================
// External Inquiry — see also `./inquiry.ts` for thread / session-link / action schemas
// ============================================================================

// Inquiry fields carried by every inquiry permission.
const CommonExternalInquiryFieldsSchema = Schema.Struct({
  question: Schema.String,
  threadId: InquiryThreadIdSchema,
  context: Schema.optional(Schema.NullOr(Schema.String)),
  suggestSearch: Schema.optional(Schema.NullOr(Schema.Boolean)),
  attachFiles: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});

const ExternalInquiryHydrationFieldsSchema = Schema.Struct({
  sessionLinks: Schema.optional(Schema.NullOr(InquirySessionLinksSchema)),
  transcript: Schema.optional(
    Schema.NullOr(Schema.Array(ExternalInquiryTurnRecordSchema)),
  ),
});

/**
 * One shape for every inquiry turn. First and follow-up dispatches carry the
 * identical field set — the panel tells them apart from `transcript` — so
 * there is no discriminator to narrow on. Hydration fields are always
 * present (nullish on a fresh thread that has nothing to hydrate).
 */
export const ExternalInquiryPermissionSchema = PermissionBaseSchema.mapFields(
  Struct.assign(CommonExternalInquiryFieldsSchema.fields),
).mapFields(Struct.assign(ExternalInquiryHydrationFieldsSchema.fields));
/** The decoded shape of {@link ExternalInquiryPermissionSchema}. */
export type ExternalInquiryPermission =
  (typeof ExternalInquiryPermissionSchema)['Type'];

// ============================================================================
// User Question
// ============================================================================

const UserQuestionOptionSchema = Schema.Struct({
  label: Schema.NonEmptyString,
  description: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * One question the agent asks the user: its text, a short header, two to four
 * options with descriptions, and whether several options or free text may be
 * chosen. The user-question tool's input and the question panel share it.
 */
export const UserQuestionPromptSchema = Schema.Struct({
  question: Schema.NonEmptyString,
  header: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(12))),
  ),
  options: Schema.Array(UserQuestionOptionSchema)
    .check(Schema.isMinLength(2))
    .check(Schema.isMaxLength(4)),
  multiSelect: Schema.optional(Schema.NullOr(Schema.Boolean)),
  allowFreeText: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
/** The decoded shape of {@link UserQuestionPromptSchema}. */
export type UserQuestionPrompt = typeof UserQuestionPromptSchema.Type;

/**
 * The user's answers to a question request, keyed by question text: one chosen
 * label or free-text answer, or the chosen labels of a multi-select question.
 * A `submit` decision carries them back to the tool.
 */
export const UserQuestionAnswersSchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
);
/** The decoded shape of {@link UserQuestionAnswersSchema}. */
export type UserQuestionAnswers = typeof UserQuestionAnswersSchema.Type;

/**
 * What a pending user-question request shows: one to three
 * {@link UserQuestionPromptSchema} questions and the context the agent gave
 * for asking. The user-question tool opens it; a `submit` decision answers it.
 */
export const UserQuestionPermissionSchema = PermissionBaseSchema.mapFields(
  Struct.assign({
    questions: Schema.Array(UserQuestionPromptSchema)
      .check(Schema.isMinLength(1))
      .check(Schema.isMaxLength(3)),
    context: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
/** The decoded shape of {@link UserQuestionPermissionSchema}. */
export type UserQuestionPermission =
  (typeof UserQuestionPermissionSchema)['Type'];

// ============================================================================
// Plan Approval
// ============================================================================

/**
 * What a pending plan approval shows: the plan document the agent wrote. The
 * plan tool opens it; the user approves it, approves it as an autonomous goal,
 * or rejects it with feedback.
 */
export const PlanApprovalPermissionSchema = Schema.Struct({
  requestId: Schema.String,
  runId: RunIdSchema,
  plan: PlanSchema,
});
/** The decoded shape of {@link PlanApprovalPermissionSchema}. */
export type PlanApprovalPermission =
  (typeof PlanApprovalPermissionSchema)['Type'];
