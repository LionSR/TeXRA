// Third-party imports
import { z } from 'zod';

// Local imports
import { AGENT_CATEGORY } from './agent';
import {
  ProviderErrorPartialSchema,
  type ProviderErrorPartial,
} from './errors';
import { StreamTabIdSchema } from './identifiers';
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

export const ToolEditApprovalPromptSchema = z.strictObject({
  requestId: z.string(),
  path: z.string(),
  relativePath: z.string(),
  sourceTool: z.string(),
  allowBypass: z.boolean(),
  streamId: OptionalStreamIdSchema,
  addedLines: z.int().nonnegative(),
  removedLines: z.int().nonnegative(),
  isLatex: z.boolean(),
});
export type ToolEditApprovalPrompt = z.infer<
  typeof ToolEditApprovalPromptSchema
>;

export const BashApprovalPromptSchema = z.strictObject({
  requestId: z.string(),
  command: z.string(),
  allowBypass: z.boolean(),
  streamId: OptionalStreamIdSchema,
});
export type BashApprovalPrompt = z.infer<typeof BashApprovalPromptSchema>;

export const RetryRequestPromptSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  operation: z.string(),
  model: z.string().optional(),
  errorMessage: z.string().optional(),
  errorDetails: ProviderErrorPartialSchema.optional(),
});
export type RetryRequestPrompt = z.infer<typeof RetryRequestPromptSchema>;

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
export const WorkflowAgentProposalSchema = BaseProposalFieldsSchema.extend({
  agentCategory: z.literal(AGENT_CATEGORY.WORKFLOW),
  ...WorkflowSpecificFieldsSchema.shape,
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

const ProposalPromptBaseSchema = z.object({
  proposalId: z.string(),
  streamId: StreamTabIdSchema,
});

export const WorkflowAgentProposalPromptSchema =
  ProposalPromptBaseSchema.extend(WorkflowAgentProposalSchema.shape);
export type WorkflowAgentProposalPrompt = z.infer<
  typeof WorkflowAgentProposalPromptSchema
>;

export const ToolUseAgentProposalPromptSchema = ProposalPromptBaseSchema.extend(
  ToolUseAgentProposalSchema.shape,
);
export type ToolUseAgentProposalPrompt = z.infer<
  typeof ToolUseAgentProposalPromptSchema
>;

export const AgentProposalPromptSchema = z.discriminatedUnion('agentCategory', [
  WorkflowAgentProposalPromptSchema,
  ToolUseAgentProposalPromptSchema,
]);
export type AgentProposalPrompt = z.infer<typeof AgentProposalPromptSchema>;

export type { ProviderErrorPartial };
