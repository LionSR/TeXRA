/**
 * Shared event bus types (avoids circular dependency with progressView).
 */
import { z } from 'zod';
import { StreamTabIdSchema } from '@agent/types/IdentifierTypes';
import { AgentCategory } from '@agent/core/AgentDataclass';
import {
  BaseProposalFieldsSchema,
  WorkflowSpecificFieldsSchema,
} from '@agent/core/AgentConfig';
import {
  ProviderErrorPartialSchema,
  type ProviderErrorPartial,
} from '@common/errors/schemas';

/** Tool edit approval request prompt */
export const ToolEditApprovalPromptSchema = z.strictObject({
  requestId: z.string(),
  path: z.string(),
  relativePath: z.string(),
  sourceTool: z.string(),
  allowBypass: z.boolean(),
  streamId: z.union([StreamTabIdSchema, z.literal('')]),
  addedLines: z.int().nonnegative(),
  removedLines: z.int().nonnegative(),
  isLatex: z.boolean(),
});
export type ToolEditApprovalPrompt = z.infer<
  typeof ToolEditApprovalPromptSchema
>;

/** Bash approval request prompt */
export const BashApprovalPromptSchema = z.strictObject({
  requestId: z.string(),
  command: z.string(),
  allowBypass: z.boolean(),
  streamId: z.union([StreamTabIdSchema, z.literal('')]),
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

/** Agent proposal actions */
export const AgentProposalActionSchema = z.enum(['approve', 'reject', 'setup']);
export type AgentProposalAction = z.infer<typeof AgentProposalActionSchema>;

/** Message schema for agent proposal action from UI */
export const AgentProposalActionMessageSchema = z.object({
  proposalId: z.string(),
  action: AgentProposalActionSchema,
  feedback: z.string().optional(),
});
export type AgentProposalActionMessage = z.infer<
  typeof AgentProposalActionMessageSchema
>;

/**
 * Workflow agent proposal - includes file fields for document processing.
 * Workflow agents receive files directly and process them.
 */
export const WorkflowAgentProposalSchema = BaseProposalFieldsSchema.extend({
  agentCategory: z.literal(AgentCategory.Workflow),
  ...WorkflowSpecificFieldsSchema.shape,
});
export type WorkflowAgentProposal = z.infer<typeof WorkflowAgentProposalSchema>;

/**
 * Tool-use agent proposal - no file fields.
 * Tool-use agents access files through their own tools (read_file, etc.).
 * File paths are mentioned in the instruction text.
 */
export const ToolUseAgentProposalSchema = BaseProposalFieldsSchema.extend({
  agentCategory: z.literal(AgentCategory.ToolUse),
});
export type ToolUseAgentProposal = z.infer<typeof ToolUseAgentProposalSchema>;

/**
 * Discriminated union for agent proposals.
 * TypeScript will narrow the type based on agentCategory.
 */
export const AgentProposalSchema = z.discriminatedUnion('agentCategory', [
  WorkflowAgentProposalSchema,
  ToolUseAgentProposalSchema,
]);
export type AgentProposal = z.infer<typeof AgentProposalSchema>;

/** Base prompt fields for UI display */
const ProposalPromptBaseSchema = z.object({
  proposalId: z.string(),
  streamId: StreamTabIdSchema,
});

/** Workflow agent proposal prompt for UI display */
export const WorkflowAgentProposalPromptSchema =
  ProposalPromptBaseSchema.extend(WorkflowAgentProposalSchema.shape);
export type WorkflowAgentProposalPrompt = z.infer<
  typeof WorkflowAgentProposalPromptSchema
>;

/** Tool-use agent proposal prompt for UI display */
export const ToolUseAgentProposalPromptSchema = ProposalPromptBaseSchema.extend(
  ToolUseAgentProposalSchema.shape,
);
export type ToolUseAgentProposalPrompt = z.infer<
  typeof ToolUseAgentProposalPromptSchema
>;

/** Discriminated union for agent proposal prompts */
export const AgentProposalPromptSchema = z.discriminatedUnion('agentCategory', [
  WorkflowAgentProposalPromptSchema,
  ToolUseAgentProposalPromptSchema,
]);
export type AgentProposalPrompt = z.infer<typeof AgentProposalPromptSchema>;
