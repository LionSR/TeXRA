import { z } from 'zod';

import { AgentCategory } from './agent';
import { ProviderErrorPartialSchema } from './errors';
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
import { WorkflowDeclaredPlanSchema } from './workflowCallProgress';

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

export const RetryPermissionSchema = z.strictObject({
  requestId: z.string(),
  runId: RunIdSchema,
  operation: z.string(),
  model: z.string().optional(),
  errorMessage: z.string().optional(),
  errorDetails: ProviderErrorPartialSchema.optional(),
});
export type RetryPermission = z.infer<typeof RetryPermissionSchema>;

const WorkflowScriptProposalDetailsSchema = WorkflowDeclaredPlanSchema.extend({
  name: z.string().min(1),
  description: z.string().min(1),
  scriptPath: z.string().min(1),
});

/** Workflow agent proposal - includes file fields for document processing */
export const WorkflowAgentProposalSchema = BaseProposalFieldsSchema.extend(
  WorkflowSpecificFieldsSchema.shape,
).extend({
  agentCategory: z.literal(AgentCategory.Workflow),
  workflowScript: WorkflowScriptProposalDetailsSchema.optional(),
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

export type ToolEditApprovalAction =
  'approve' | 'reject' | 'openDiff' | 'showLatexdiff' | 'previewProposed';

export const PlanApprovalPermissionSchema = z.strictObject({
  requestId: z.string(),
  runId: RunIdSchema,
  plan: PlanSchema,
  /**
   * True when the goal experimental feature flag is enabled at request
   * time. Frontend uses this to decide whether to render the
   * "Run as Goal" button.
   */
  goalEnabled: z.boolean().prefault(false),
});
export type PlanApprovalPermission = z.infer<
  typeof PlanApprovalPermissionSchema
>;
