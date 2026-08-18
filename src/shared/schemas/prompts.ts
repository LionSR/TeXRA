import { z } from 'zod';

import { AgentCategory } from './agent';
import { ProviderErrorPartialSchema } from './errors';
import { StreamTabIdSchema } from './identifiers';
import {
  InquiryDraftSchema,
  InquiryTranscriptTurnSchema,
  InquirySessionLinksSchema,
  InquiryThreadIdSchema,
} from './inquiry';
import { LineCountSchema } from './lineChanges';
import { PlanSchema } from './plan';
import {
  BaseProposalFieldsSchema,
  WorkflowSpecificFieldsSchema,
} from './proposalFields';
import { WorkflowCallIdentitySchema } from './workflowCallProgress';

/** Optional stream ID - allows empty string when stream context is unavailable */
const OptionalStreamIdSchema = z.union([StreamTabIdSchema, z.literal('')]);

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
  streamId: StreamTabIdSchema,
  operation: z.string(),
  model: z.string().optional(),
  errorMessage: z.string().optional(),
  errorDetails: ProviderErrorPartialSchema.optional(),
  /** True when the failed handler was dispatched onto the Kimi Code coding
   * endpoint, captured before the retry panel opened. */
  kimiCodeRoutedOnFailure: z.boolean().optional(),
});
export type RetryPermission = z.infer<typeof RetryPermissionSchema>;

const WorkflowScriptProposalDetailsSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  scriptPath: z.string().min(1),
  phases: z.array(z.strictObject({ title: z.string().min(1) })),
  tasks: z.array(WorkflowCallIdentitySchema),
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
  streamId: StreamTabIdSchema,
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

// Shared inquiry fields present in both new and follow-up permissions.
const CommonExternalInquiryFieldsSchema = z.object({
  question: z.string(),
  threadId: InquiryThreadIdSchema,
  context: z.string().nullish(),
  suggestSearch: z.boolean().nullish(),
  attachFiles: z.array(z.string()).nullish(),
});

const ExternalInquiryHydrationFieldsSchema = z.object({
  sessionLinks: InquirySessionLinksSchema.nullish(),
  draft: InquiryDraftSchema.nullish(),
  transcript: z.array(InquiryTranscriptTurnSchema).nullish(),
});

// Both inquiry modes share the same fields and differ only in the `mode`
// discriminator. Hydration fields live on both so the discriminated union
// exposes a common surface for renderers that read them regardless of mode.
const ExternalInquiryPermissionBaseSchema = PermissionBaseSchema.extend(
  CommonExternalInquiryFieldsSchema.shape,
).extend(ExternalInquiryHydrationFieldsSchema.shape);

/**
 * First inquiry in a thread. Fresh dispatches have no prior transcript, draft,
 * or session links, but durable hydration may carry a saved open-turn draft.
 */
const NewExternalInquiryPermissionSchema =
  ExternalInquiryPermissionBaseSchema.extend({ mode: z.literal('new') });

/** Follow-up inquiry — carries thread context from prior turns. */
const FollowUpExternalInquiryPermissionSchema =
  ExternalInquiryPermissionBaseSchema.extend({ mode: z.literal('followUp') });

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

/**
 * Host-neutral core of a resolved approval decision, shared by every host
 * (CLI TUI, CLI headless, extension). Hosts that need extra host-specific
 * fields (e.g. the CLI's session bypass / credential mode) extend this rather
 * than redefining the common shape, so the accepted/feedback/answers vocabulary
 * has a single source of truth. See docs/proposals/2026-05-31-tui-extension-sharing.md
 * (Rung 1).
 */
export type ApprovalDecision = {
  accepted: boolean;
  /**
   * Free-text payload carried with the decision. For rejections this is the
   * user's reject-with-feedback note; for an ExternalInquiry accept it is the
   * answer the agent gets back.
   */
  userMessage?: string | undefined;
  /** Structured answers for an AskUserQuestion request. */
  userQuestionAnswers?: UserQuestionAnswers | undefined;
};

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

export type PlanApprovalAction = 'approve' | 'reject' | 'approve_and_goal';

export type ToolEditApprovalAction =
  'approve' | 'reject' | 'openDiff' | 'showLatexdiff' | 'previewProposed';

export const PlanApprovalPermissionSchema = z.strictObject({
  requestId: z.string(),
  streamId: StreamTabIdSchema,
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
