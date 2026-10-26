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

export const ToolEditPermissionSchema = PermissionBaseSchema.mapFields(
  Struct.assign({
    path: Schema.String,
    relativePath: Schema.String,
    sourceTool: Schema.String,
    addedLines: LineCountSchema,
    removedLines: LineCountSchema,
  }),
);
export type ToolEditPermission = typeof ToolEditPermissionSchema.Type;

export const BashPermissionSchema = PermissionBaseSchema.mapFields(
  Struct.assign({
    command: Schema.String,
    cwd: Schema.optional(Schema.String),
  }),
);
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
export type CredentialSwitch = typeof CredentialSwitchSchema.Type;

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
export type AgentProposal = typeof AgentProposalSchema.Type;

export const AgentProposalPermissionSchema = AgentProposalSchema.mapFields(
  Struct.assign({
    requestId: Schema.String,
    runId: RunIdSchema,
  }),
);
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
export type ExternalInquiryPermission =
  (typeof ExternalInquiryPermissionSchema)['Type'];

// ============================================================================
// User Question
// ============================================================================

const UserQuestionOptionSchema = Schema.Struct({
  label: Schema.String.check(Schema.isMinLength(1)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});

export const UserQuestionPromptSchema = Schema.Struct({
  question: Schema.String.check(Schema.isMinLength(1)),
  header: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(12))),
  ),
  options: Schema.Array(UserQuestionOptionSchema)
    .check(Schema.isMinLength(2))
    .check(Schema.isMaxLength(4)),
  multiSelect: Schema.optional(Schema.NullOr(Schema.Boolean)),
  allowFreeText: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type UserQuestionPrompt = typeof UserQuestionPromptSchema.Type;

export const UserQuestionAnswersSchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
);
export type UserQuestionAnswers = typeof UserQuestionAnswersSchema.Type;

export const UserQuestionPermissionSchema = PermissionBaseSchema.mapFields(
  Struct.assign({
    questions: Schema.Array(UserQuestionPromptSchema)
      .check(Schema.isMinLength(1))
      .check(Schema.isMaxLength(3)),
    context: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
export type UserQuestionPermission =
  (typeof UserQuestionPermissionSchema)['Type'];

// ============================================================================
// Plan Approval
// ============================================================================

export const PlanApprovalPermissionSchema = Schema.Struct({
  requestId: Schema.String,
  runId: RunIdSchema,
  plan: PlanSchema,
});
export type PlanApprovalPermission =
  (typeof PlanApprovalPermissionSchema)['Type'];
