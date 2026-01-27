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

export type { ProviderErrorPartial };
