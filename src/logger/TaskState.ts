// Third-party imports
import { z } from 'zod';

// Local imports
import type { AgentConfig } from '@agent/core/AgentConfig';
// Internal imports
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { AgentSessionDescriptor } from '@agent/core/AgentSessionSchema';

// Type imports
import { FILE_TYPES, type FileType } from '@utils/config';

// -----------------------------------------------------------------------------
// Zod Schemas for Persisted State Validation
// -----------------------------------------------------------------------------
// These schemas validate persisted TaskState data. The agentConfig was already
// validated when created, so we use passthrough() to avoid re-validation and
// only check the discriminator and variant-specific fields.

/** Schema for tool session state */
const ToolSessionStateSchema = z.object({
  lastFollowUpAt: z.number().optional(),
});

/** Active files record schema */
const ActiveFilesSchema = z.partialRecord(
  z.enum(FILE_TYPES),
  z.boolean(),
) as z.ZodType<Record<FileType, boolean>>;

/** Minimal agentConfig schema - just validates the discriminator exists */
const AgentConfigWithSessionSchema = z.looseObject({
  session: z.object({
    agentCategory: z.enum(AgentCategory),
  }),
});

/** Schema for workflow task state */
const WorkflowTaskStateSchema = z.object({
  agentConfig: AgentConfigWithSessionSchema.refine(
    (c) => c.session.agentCategory === AgentCategory.Workflow,
    {
        error: 'Expected Workflow category'
    },
  ),
  activeFiles: ActiveFilesSchema,
});

/** Schema for tool-use task state */
const ToolUseTaskStateSchema = z.object({
  agentConfig: AgentConfigWithSessionSchema.refine(
    (c) => c.session.agentCategory === AgentCategory.ToolUse,
    {
        error: 'Expected ToolUse category'
    },
  ),
  toolSessionState: ToolSessionStateSchema.optional(),
});

/**
 * TaskState schema for validating persisted state.
 * Uses passthrough on agentConfig since it was validated when created.
 */
export const TaskStateSchema = z.union([
  WorkflowTaskStateSchema,
  ToolUseTaskStateSchema,
]);

// -----------------------------------------------------------------------------
// Types - Explicitly defined with proper AgentConfig structure
// -----------------------------------------------------------------------------
// Types are defined explicitly (not inferred from validation schemas) because
// the validation schemas use passthrough() for efficiency.

export type ToolSessionState = z.infer<typeof ToolSessionStateSchema>;

export interface WorkflowTaskState {
  agentConfig: AgentConfig & {
    session: AgentSessionDescriptor & { agentCategory: AgentCategory.Workflow };
  };
  activeFiles: Record<FileType, boolean>;
}

export interface ToolUseTaskState {
  agentConfig: AgentConfig & {
    session: AgentSessionDescriptor & { agentCategory: AgentCategory.ToolUse };
  };
  toolSessionState?: ToolSessionState;
}

export type TaskState = WorkflowTaskState | ToolUseTaskState;

// -----------------------------------------------------------------------------
// Type Guards
// -----------------------------------------------------------------------------

/** Type guard for TaskState narrowing to WorkflowTaskState */
export function isWorkflowTaskState(
  taskState: TaskState,
): taskState is WorkflowTaskState {
  return taskState.agentConfig.session.agentCategory === AgentCategory.Workflow;
}

/** Type guard for TaskState narrowing to ToolUseTaskState */
export function isToolUseTaskState(
  taskState: TaskState,
): taskState is ToolUseTaskState {
  return taskState.agentConfig.session.agentCategory === AgentCategory.ToolUse;
}
