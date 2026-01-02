// Third-party imports
import { z } from 'zod';

// Local imports
import { AgentConfigSchema } from '@agent/core/AgentConfig';
// Internal imports
import { AgentCategory } from '@agent/core/AgentDataclass';
import { AgentSessionDescriptorSchema } from '@agent/core/AgentSessionSchema';

// Type imports
import { FILE_TYPES, type FileType } from '@utils/config';

// -----------------------------------------------------------------------------
// Zod Schemas - Single Source of Truth
// -----------------------------------------------------------------------------

/** Schema for tool session state */
const ToolSessionStateSchema = z.object({
  lastFollowUpAt: z.number().optional(),
});

/** Active files record schema */
const ActiveFilesSchema = z.record(
  z.enum(FILE_TYPES),
  z.boolean(),
) as z.ZodType<Record<FileType, boolean>>;

/** Schema for workflow task state with category discriminator */
const WorkflowTaskStateSchema = z.object({
  agentConfig: AgentConfigSchema.and(
    z.object({
      session: AgentSessionDescriptorSchema.and(
        z.object({ agentCategory: z.literal(AgentCategory.Workflow) }),
      ),
    }),
  ),
  activeFiles: ActiveFilesSchema,
});

/** Schema for tool-use task state with category discriminator */
const ToolUseTaskStateSchema = z.object({
  agentConfig: AgentConfigSchema.and(
    z.object({
      session: AgentSessionDescriptorSchema.and(
        z.object({ agentCategory: z.literal(AgentCategory.ToolUse) }),
      ),
    }),
  ),
  toolSessionState: ToolSessionStateSchema.optional(),
});

/**
 * TaskState schema using discriminated union on agentConfig.session.agentCategory.
 * Use safeParse for validation when loading persisted state.
 */
export const TaskStateSchema = z.union([
  WorkflowTaskStateSchema,
  ToolUseTaskStateSchema,
]);

// -----------------------------------------------------------------------------
// Types - Derived from Schemas
// -----------------------------------------------------------------------------

export interface ToolSessionState {
  lastFollowUpAt?: number;
}

export type WorkflowTaskState = z.infer<typeof WorkflowTaskStateSchema>;
export type ToolUseTaskState = z.infer<typeof ToolUseTaskStateSchema>;
export type TaskState = z.infer<typeof TaskStateSchema>;

// -----------------------------------------------------------------------------
// Type Guards
// -----------------------------------------------------------------------------

export function isWorkflowTaskState(
  taskState: TaskState,
): taskState is WorkflowTaskState {
  return taskState.agentConfig.session.agentCategory === AgentCategory.Workflow;
}

export function isToolUseTaskState(
  taskState: TaskState,
): taskState is ToolUseTaskState {
  return taskState.agentConfig.session.agentCategory === AgentCategory.ToolUse;
}
