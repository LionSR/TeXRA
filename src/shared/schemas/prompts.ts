import { z } from 'zod';

import { AGENT_CATEGORY } from './agent';
import { ProviderErrorPartialSchema } from './errors';
import { StreamTabIdSchema } from './identifiers';
import { PlanSchema } from './plan';
import {
  BaseProposalFieldsSchema,
  WorkflowSpecificFieldsSchema,
} from './proposalFields';

/** Optional stream ID - allows empty string when stream context is unavailable */
export const OptionalStreamIdSchema = z.union([
  StreamTabIdSchema,
  z.literal(''),
]);
export type OptionalStreamId = z.infer<typeof OptionalStreamIdSchema>;

/** Common permission request fields */
const PermissionBaseSchema = z.strictObject({
  requestId: z.string(),
  allowBypass: z.boolean(),
  streamId: OptionalStreamIdSchema,
});

export const ToolEditPermissionSchema = PermissionBaseSchema.extend({
  path: z.string(),
  relativePath: z.string(),
  sourceTool: z.string(),
  addedLines: z.int().nonnegative(),
  removedLines: z.int().nonnegative(),
  isLatex: z.boolean(),
  originalContent: z.string().optional(),
  proposedContent: z.string().optional(),
});
export type ToolEditPermission = z.infer<typeof ToolEditPermissionSchema>;

export const BashPermissionSchema = PermissionBaseSchema.extend({
  command: z.string(),
});
export type BashPermission = z.infer<typeof BashPermissionSchema>;

export const RetryPermissionSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  operation: z.string(),
  model: z.string().optional(),
  errorMessage: z.string().optional(),
  errorDetails: ProviderErrorPartialSchema.optional(),
});
export type RetryPermission = z.infer<typeof RetryPermissionSchema>;

export const AgentProposalActionSchema = z.enum(['approve', 'reject', 'setup']);
export type AgentProposalAction = z.infer<typeof AgentProposalActionSchema>;

export const AgentProposalActionMessageSchema = z.object({
  proposalId: z.string(),
  action: AgentProposalActionSchema,
  feedback: z.string().optional(),
});
export type AgentProposalActionMessage = z.infer<
  typeof AgentProposalActionMessageSchema
>;

/** Workflow agent proposal - includes file fields for document processing */
export const WorkflowAgentProposalSchema = BaseProposalFieldsSchema.merge(
  WorkflowSpecificFieldsSchema,
).extend({
  agentCategory: z.literal(AGENT_CATEGORY.WORKFLOW),
});
export type WorkflowAgentProposal = z.infer<typeof WorkflowAgentProposalSchema>;

/** Tool-use agent proposal - agents access files through their own tools */
export const ToolUseAgentProposalSchema = BaseProposalFieldsSchema.extend({
  agentCategory: z.literal(AGENT_CATEGORY.TOOL_USE),
});
export type ToolUseAgentProposal = z.infer<typeof ToolUseAgentProposalSchema>;

export const AgentProposalSchema = z.discriminatedUnion('agentCategory', [
  WorkflowAgentProposalSchema,
  ToolUseAgentProposalSchema,
]);
export type AgentProposal = z.infer<typeof AgentProposalSchema>;

const ProposalPermissionBaseSchema = z.object({
  proposalId: z.string(),
  streamId: StreamTabIdSchema,
});

export const WorkflowAgentProposalPermissionSchema =
  ProposalPermissionBaseSchema.extend(WorkflowAgentProposalSchema.shape);
export type WorkflowAgentProposalPermission = z.infer<
  typeof WorkflowAgentProposalPermissionSchema
>;

export const ToolUseAgentProposalPermissionSchema =
  ProposalPermissionBaseSchema.extend(ToolUseAgentProposalSchema.shape);
export type ToolUseAgentProposalPermission = z.infer<
  typeof ToolUseAgentProposalPermissionSchema
>;

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

import {
  InquiryDraftSchema,
  InquiryTranscriptTurnSchema,
  ExternalInquirySessionLinksSchema,
  ExternalInquiryThreadIdSchema,
} from './inquiry';

export const ExternalInquiryPermissionSchema = PermissionBaseSchema.extend({
  question: z.string(),
  threadId: ExternalInquiryThreadIdSchema.nullish(),
  context: z.string().nullish(),
  suggestSearch: z.boolean().nullish(),
  attachFiles: z.array(z.string()).nullish(),
  sessionLinks: ExternalInquirySessionLinksSchema.nullish(),
  draft: InquiryDraftSchema.nullish(),
  transcript: z.array(InquiryTranscriptTurnSchema).nullish(),
});
export type ExternalInquiryPermission = z.infer<
  typeof ExternalInquiryPermissionSchema
>;

// ============================================================================
// User Question
// ============================================================================

export const USER_QUESTION_ACTIONS = ['submit', 'reject'] as const;
export type UserQuestionAction = (typeof USER_QUESTION_ACTIONS)[number];

export const UserQuestionOptionSchema = z.strictObject({
  label: z.string().min(1),
  description: z.string().nullish(),
});
export type UserQuestionOption = z.infer<typeof UserQuestionOptionSchema>;

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

export const PLAN_APPROVAL_ACTIONS = ['approve', 'reject'] as const;
export type PlanApprovalAction = (typeof PLAN_APPROVAL_ACTIONS)[number];

export const PlanApprovalPermissionSchema = z.strictObject({
  approvalId: z.string(),
  streamId: StreamTabIdSchema,
  plan: PlanSchema,
});
export type PlanApprovalPermission = z.infer<
  typeof PlanApprovalPermissionSchema
>;
