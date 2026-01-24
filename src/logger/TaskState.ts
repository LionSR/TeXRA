// Third-party imports
import { z } from 'zod';

// Local imports
import { AgentCategory } from '@agent/core/AgentDataclass';
import {
  liftLegacyAgentCategory,
  type AgentConfig,
} from '@agent/core/AgentConfig';

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
 * Lightweight AgentConfig schema for persisted TaskState validation.
 * Uses shared liftLegacyAgentCategory (single source of truth) for migration.
 * Only validates agentCategory discriminator, not full config.
 */
const AgentConfigSchema = z.preprocess(
  liftLegacyAgentCategory,
  z.looseObject({ agentCategory: z.enum(AgentCategory) }),
);

/** Schema for workflow task state */
const WorkflowTaskStateSchema = z.object({
  agentConfig: AgentConfigSchema.refine(
    (c) => c.agentCategory === AgentCategory.Workflow,
    { error: 'Expected Workflow category' },
  ),
  activeFiles: ActiveFilesSchema,
});

/** Schema for tool-use task state */
const ToolUseTaskStateSchema = z.object({
  agentConfig: AgentConfigSchema.refine(
    (c) => c.agentCategory === AgentCategory.ToolUse,
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

// -----------------------------------------------------------------------------
// Factory Functions
// -----------------------------------------------------------------------------
// These factories encapsulate the category-specific TaskState construction,
// eliminating scattered conditional logic throughout the codebase.

/** Default active files record (all false) */
const DEFAULT_ACTIVE_FILES: Record<FileType, boolean> = Object.fromEntries(
  FILE_TYPES.map((type) => [type, false]),
) as Record<FileType, boolean>;

/**
 * Options for creating a TaskState.
 */
export interface CreateTaskStateOptions {
  /**
   * Active files record for workflow agents.
   * If not provided, defaults to all false.
   * Ignored for tool-use agents.
   */
  activeFiles?: Partial<Record<FileType, boolean>>;

  /**
   * Tool session state for tool-use agents.
   * Ignored for workflow agents.
   */
  toolSessionState?: ToolSessionState;
}

/**
 * Create a TaskState from an AgentConfig.
 *
 * This factory handles the category-specific structure automatically:
 * - Workflow agents get `activeFiles` (defaulting to all false if not provided)
 * - ToolUse agents get `toolSessionState` (optional)
 *
 * @param agentConfig - The agent configuration (determines category)
 * @param options - Optional category-specific fields
 * @returns The appropriate TaskState variant
 *
 * @example
 * ```typescript
 * // Workflow agent with some active files
 * const workflowState = createTaskState(workflowConfig, {
 *   activeFiles: { input: true, reference: true },
 * });
 *
 * // ToolUse agent (no options needed)
 * const toolUseState = createTaskState(toolUseConfig);
 * ```
 */
export function createTaskState(
  agentConfig: AgentConfig,
  options: CreateTaskStateOptions = {},
): TaskState {
  if (agentConfig.agentCategory === AgentCategory.Workflow) {
    return {
      agentConfig: agentConfig as AgentConfig & {
        agentCategory: AgentCategory.Workflow;
      },
      activeFiles: {
        ...DEFAULT_ACTIVE_FILES,
        ...options.activeFiles,
      },
    };
  }

  // ToolUse agent
  const toolUseState: ToolUseTaskState = {
    agentConfig: agentConfig as AgentConfig & {
      agentCategory: AgentCategory.ToolUse;
    },
  };

  if (options.toolSessionState) {
    toolUseState.toolSessionState = options.toolSessionState;
  }

  return toolUseState;
}
