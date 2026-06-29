import { z } from 'zod';

import { AgentCategory } from './agent';
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
  cwd: z.string().optional(),
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

// Shared inquiry fields present in both new and follow-up permissions.
const CommonExternalInquiryFieldsSchema = z.object({
  question: z.string(),
  threadId: ExternalInquiryThreadIdSchema,
  context: z.string().nullish(),
  suggestSearch: z.boolean().nullish(),
  attachFiles: z.array(z.string()).nullish(),
});

const ExternalInquiryHydrationFieldsSchema = z.object({
  sessionLinks: ExternalInquirySessionLinksSchema.nullish(),
  draft: InquiryDraftSchema.nullish(),
  transcript: z.array(InquiryTranscriptTurnSchema).nullish(),
});

/**
 * First inquiry in a thread. Fresh dispatches have no prior transcript, draft,
 * or session links, but durable hydration may carry a saved open-turn draft.
 */
export const NewExternalInquiryPermissionSchema = PermissionBaseSchema.extend(
  CommonExternalInquiryFieldsSchema.shape,
).extend({
  mode: z.literal('new'),
  // Included so the discriminated union produces a common surface for renderers
  // that access these fields.
  ...ExternalInquiryHydrationFieldsSchema.shape,
});
export type NewExternalInquiryPermission = z.infer<
  typeof NewExternalInquiryPermissionSchema
>;

/** Follow-up inquiry — carries thread context from prior turns. */
export const FollowUpExternalInquiryPermissionSchema =
  PermissionBaseSchema.extend(CommonExternalInquiryFieldsSchema.shape).extend({
    mode: z.literal('followUp'),
    ...ExternalInquiryHydrationFieldsSchema.shape,
  });
export type FollowUpExternalInquiryPermission = z.infer<
  typeof FollowUpExternalInquiryPermissionSchema
>;

export const ExternalInquiryPermissionSchema = z.discriminatedUnion('mode', [
  NewExternalInquiryPermissionSchema,
  FollowUpExternalInquiryPermissionSchema,
]);
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

/**
 * Host-neutral core of a resolved approval decision, shared by every host
 * (CLI TUI, CLI headless, extension). Hosts that need extra host-specific
 * fields (e.g. the CLI's session bypass / credential mode) extend this rather
 * than redefining the common shape, so the accepted/feedback/answers vocabulary
 * has a single source of truth. See docs/proposals/tui-extension-sharing.md
 * (Rung 1).
 */
export const ApprovalDecisionSchema = z.object({
  accepted: z.boolean(),
  /**
   * Free-text payload carried with the decision. For rejections this is the
   * user's reject-with-feedback note; for an ExternalInquiry accept it is the
   * answer the agent gets back.
   */
  userMessage: z.string().optional(),
  /** Structured answers for an AskUserQuestion request. */
  userQuestionAnswers: UserQuestionAnswersSchema.optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

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

export const PLAN_APPROVAL_ACTIONS = [
  'approve',
  'reject',
  'approve_and_goal',
] as const;
export type PlanApprovalAction = (typeof PLAN_APPROVAL_ACTIONS)[number];

// Tool-edit and bash approval action sets live here (the schema layer) so the
// IPC schema (progressView/inbound) and the runtime approval modules
// (@tools/approval/*) share one definition. The schema layer has no @tools/
// @agent imports, so the runtime modules import these without a cycle, and the
// IPC schema never pulls runtime code into the renderer bundle.
export const TOOL_EDIT_APPROVAL_ACTIONS = [
  'approve',
  'reject',
  'openDiff',
  'showLatexdiff',
  'previewProposed',
] as const;
export type ToolEditApprovalAction =
  (typeof TOOL_EDIT_APPROVAL_ACTIONS)[number];

export const BASH_APPROVAL_ACTIONS = ['approve', 'reject'] as const;
export type BashApprovalAction = (typeof BASH_APPROVAL_ACTIONS)[number];

export const PlanApprovalPermissionSchema = z.strictObject({
  approvalId: z.string(),
  streamId: StreamTabIdSchema,
  plan: PlanSchema,
  /**
   * True when the goal experimental feature flag is enabled at request
   * time. Frontend uses this to decide whether to render the
   * "Approve & Run Autonomously" button.
   */
  goalEnabled: z.boolean().prefault(false),
});
export type PlanApprovalPermission = z.infer<
  typeof PlanApprovalPermissionSchema
>;
