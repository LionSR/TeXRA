import { z } from 'zod';

import { AgentCategory } from './agent';
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
  WorkflowSpecificFieldsSchema,
} from './proposalFields';
import { DeclinableUsageRouteSchema } from './usage';

/** Common permission request fields */
const PermissionBaseSchema = z.strictObject({
  requestId: z.string(),
  allowBypass: z.boolean(),
  runId: RunSelectionSchema,
});

export const ToolEditPermissionSchema = PermissionBaseSchema.extend({
  path: z.string(),
  relativePath: z.string(),
  sourceTool: z.string(),
  addedLines: LineCountSchema,
  removedLines: LineCountSchema,
  isLatex: z.boolean(),
});
export type ToolEditPermission = z.infer<typeof ToolEditPermissionSchema>;

export const BashPermissionSchema = PermissionBaseSchema.extend({
  command: z.string(),
  cwd: z.string().optional(),
});
export type BashPermission = z.infer<typeof BashPermissionSchema>;

/**
 * The API-key providers a stored retry offer names. Storage owns the enum
 * (the llm catalog's `ApiKeyProviderId` must stay assignable to it, which
 * `routeCredentialSwitch` checks where it builds an offer), so a catalog
 * change is never a silent stored format change.
 */
const ApiKeyProviderIdSchema = z.enum([
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
  'openRouter',
  'kimiCode',
]);

/**
 * The move onto the user's own credential a failed model request offers,
 * decided once by the retry owner (`ModelInvoker`) from the recorded failure
 * and the route the failed model was bound on. Hosts render it; none of them
 * re-derives it from the error.
 */
export const CredentialSwitchSchema = z.discriminatedUnion('kind', [
  /** A subscription or coding-plan quota ran out: the run declines `route`
   *  and retries on the model's own `provider` key. `automatic` records that
   *  the invoker took the switch itself (a coding plan whose fallback key is
   *  already stored), so no one was asked. */
  z.strictObject({
    kind: z.literal('decline-route'),
    route: DeclinableUsageRouteSchema,
    provider: ApiKeyProviderIdSchema,
    automatic: z.boolean(),
  }),
  /** The account behind the stored `provider` key is out of credit, so only
   *  a changed key can succeed. */
  z.strictObject({
    kind: z.literal('new-key'),
    provider: ApiKeyProviderIdSchema,
  }),
  /** The Copilot quota ran out: a replacement run on the matching direct
   *  model, whose provider is resolved when that run launches. */
  z.strictObject({ kind: z.literal('copilot-fallback') }),
]);
export type CredentialSwitch = z.infer<typeof CredentialSwitchSchema>;

export const RetryPermissionSchema = z.strictObject({
  requestId: z.string(),
  runId: RunIdSchema,
  operation: z.string(),
  model: z.string().optional(),
  errorMessage: z.string().optional(),
  errorDetails: RetryErrorInfoSchema.partial().optional(),
  /** Null or absent when the failure offers no credential move. */
  credentialSwitch: CredentialSwitchSchema.nullish(),
});
export type RetryPermission = z.infer<typeof RetryPermissionSchema>;

/**
 * A call whose outcome is unknown: it may have run before the run was
 * interrupted, and no result was recorded. Decided `retry` (run it again)
 * or `skip` (its outcome stays unknown). `childRunId` is the run an `agent`
 * call's earlier attempt left, when the question is about one.
 */
export const ToolOutcomePermissionSchema = z.strictObject({
  requestId: z.string(),
  runId: RunIdSchema,
  toolName: z.string(),
  /** What the call was: its tool and input, or the agent and why. */
  title: z.string(),
  childRunId: RunIdSchema.nullable(),
});
export type ToolOutcomePermission = z.infer<typeof ToolOutcomePermissionSchema>;

/** Workflow agent proposal - includes file fields for document processing */
export const WorkflowAgentProposalSchema = BaseProposalFieldsSchema.extend(
  WorkflowSpecificFieldsSchema.shape,
).extend({
  agentCategory: z.literal(AgentCategory.Workflow),
});
export type WorkflowAgentProposal = z.infer<typeof WorkflowAgentProposalSchema>;

/** Tool-use agent proposal - agents access files through their own tools */
export const ToolUseAgentProposalSchema = BaseProposalFieldsSchema.extend({
  agentCategory: z.literal(AgentCategory.ToolUse),
  rootUserInstruction: z.string().nullish(),
});
export type ToolUseAgentProposal = z.infer<typeof ToolUseAgentProposalSchema>;

export const AgentProposalSchema = z.discriminatedUnion('agentCategory', [
  WorkflowAgentProposalSchema,
  ToolUseAgentProposalSchema,
]);
export type AgentProposal = z.infer<typeof AgentProposalSchema>;

const ProposalPermissionBaseSchema = z.object({
  requestId: z.string(),
  runId: RunIdSchema,
});

const WorkflowAgentProposalPermissionSchema =
  ProposalPermissionBaseSchema.extend(WorkflowAgentProposalSchema.shape);
export type WorkflowAgentProposalPermission = z.infer<
  typeof WorkflowAgentProposalPermissionSchema
>;

const ToolUseAgentProposalPermissionSchema =
  ProposalPermissionBaseSchema.extend(ToolUseAgentProposalSchema.shape);

export const AgentProposalPermissionSchema = z.discriminatedUnion(
  'agentCategory',
  [WorkflowAgentProposalPermissionSchema, ToolUseAgentProposalPermissionSchema],
);
export type AgentProposalPermission = z.infer<
  typeof AgentProposalPermissionSchema
>;

// ============================================================================
// External Inquiry — see also `./inquiry.ts` for thread / session-link / action schemas
// ============================================================================

// Inquiry fields carried by every inquiry permission.
const CommonExternalInquiryFieldsSchema = z.object({
  question: z.string(),
  threadId: InquiryThreadIdSchema,
  context: z.string().nullish(),
  suggestSearch: z.boolean().nullish(),
  attachFiles: z.array(z.string()).nullish(),
});

const ExternalInquiryHydrationFieldsSchema = z.object({
  sessionLinks: InquirySessionLinksSchema.nullish(),
  transcript: z.array(ExternalInquiryTurnRecordSchema).nullish(),
});

/**
 * One shape for every inquiry turn. First and follow-up dispatches carry the
 * identical field set — the panel tells them apart from `transcript` — so
 * there is no discriminator to narrow on. Hydration fields are always
 * present (nullish on a fresh thread that has nothing to hydrate).
 */
export const ExternalInquiryPermissionSchema = PermissionBaseSchema.extend(
  CommonExternalInquiryFieldsSchema.shape,
).extend(ExternalInquiryHydrationFieldsSchema.shape);
export type ExternalInquiryPermission = z.infer<
  typeof ExternalInquiryPermissionSchema
>;

// ============================================================================
// User Question
// ============================================================================

const UserQuestionOptionSchema = z.strictObject({
  label: z.string().min(1),
  description: z.string().nullish(),
});

export const UserQuestionPromptSchema = z.strictObject({
  question: z.string().min(1),
  header: z.string().max(12).nullish(),
  options: z.array(UserQuestionOptionSchema).min(2).max(4),
  multiSelect: z.boolean().nullish(),
  allowFreeText: z.boolean().nullish(),
});
export type UserQuestionPrompt = z.infer<typeof UserQuestionPromptSchema>;

export const UserQuestionAnswersSchema = z.record(
  z.string(),
  z.union([z.string(), z.array(z.string())]),
);
export type UserQuestionAnswers = z.infer<typeof UserQuestionAnswersSchema>;

export const UserQuestionPermissionSchema = PermissionBaseSchema.extend({
  questions: z.array(UserQuestionPromptSchema).min(1).max(3),
  context: z.string().nullish(),
});
export type UserQuestionPermission = z.infer<
  typeof UserQuestionPermissionSchema
>;

// ============================================================================
// Plan Approval
// ============================================================================

export const PlanApprovalPermissionSchema = z.strictObject({
  requestId: z.string(),
  runId: RunIdSchema,
  plan: PlanSchema,
});
export type PlanApprovalPermission = z.infer<
  typeof PlanApprovalPermissionSchema
>;
