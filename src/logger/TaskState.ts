// Third-party imports
import { z } from 'zod';

// Local imports
import { AgentCategory, type AgentConfig } from '@agent/core/AgentConfig';

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

/**
 * Helper to extract agentCategory from either new or legacy format.
 * - New format: agentConfig.agentCategory (lifted to top level)
 * - Legacy format: agentConfig.session.agentCategory (nested in session)
 */
function getAgentCategory(
  config: Record<string, unknown>,
): AgentCategory | undefined {
  // Try new format first (top-level agentCategory)
  if (
    'agentCategory' in config &&
    typeof config.agentCategory === 'string' &&
    Object.values(AgentCategory).includes(config.agentCategory as AgentCategory)
  ) {
    return config.agentCategory as AgentCategory;
  }

  // Fall back to legacy format (nested in session)
  if (
    'session' in config &&
    typeof config.session === 'object' &&
    config.session !== null &&
    'agentCategory' in config.session
  ) {
    const session = config.session as Record<string, unknown>;
    if (
      typeof session.agentCategory === 'string' &&
      Object.values(AgentCategory).includes(
        session.agentCategory as AgentCategory,
      )
    ) {
      return session.agentCategory as AgentCategory;
    }
  }

  return undefined;
}

/**
 * Minimal agentConfig schema - validates category from either location.
 * Accepts both new format (agentConfig.agentCategory) and legacy format
 * (agentConfig.session.agentCategory) for backwards compatibility with
 * persisted task states.
 */
const AgentConfigWithCategorySchema = z
  .looseObject({})
  .refine((c) => getAgentCategory(c) !== undefined, {
    error: 'Missing agentCategory in agentConfig',
  });

/** Schema for workflow task state */
const WorkflowTaskStateSchema = z.object({
  agentConfig: AgentConfigWithCategorySchema.refine(
    (c) => getAgentCategory(c) === AgentCategory.Workflow,
    { error: 'Expected Workflow category' },
  ),
  activeFiles: ActiveFilesSchema,
});

/** Schema for tool-use task state */
const ToolUseTaskStateSchema = z.object({
  agentConfig: AgentConfigWithCategorySchema.refine(
    (c) => getAgentCategory(c) === AgentCategory.ToolUse,
    { error: 'Expected ToolUse category' },
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
  agentConfig: AgentConfig & { agentCategory: AgentCategory.Workflow };
  activeFiles: Record<FileType, boolean>;
}

export interface ToolUseTaskState {
  agentConfig: AgentConfig & { agentCategory: AgentCategory.ToolUse };
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
  return taskState.agentConfig.agentCategory === AgentCategory.Workflow;
}

/** Type guard for TaskState narrowing to ToolUseTaskState */
export function isToolUseTaskState(
  taskState: TaskState,
): taskState is ToolUseTaskState {
  return taskState.agentConfig.agentCategory === AgentCategory.ToolUse;
}
