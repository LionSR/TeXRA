import { z } from 'zod';

import { AgentCategory } from '@agent/core/AgentDataclass';
import {
  liftLegacyAgentCategory,
  type AgentConfig,
} from '@agent/core/AgentConfig';
import { FILE_TYPES, type FileType } from '@utils/config';

const ToolSessionStateSchema = z.object({
  lastFollowUpAt: z.number().optional(),
});

const ActiveFilesSchema = z.partialRecord(
  z.enum(FILE_TYPES),
  z.boolean(),
) as z.ZodType<Record<FileType, boolean>>;

const AgentConfigSchema = z.preprocess(
  liftLegacyAgentCategory,
  z.looseObject({ agentCategory: z.enum(AgentCategory) }),
);

const WorkflowTaskStateSchema = z.object({
  agentConfig: AgentConfigSchema.refine(
    (c) => c.agentCategory === AgentCategory.Workflow,
    { error: 'Expected Workflow category' },
  ),
  activeFiles: ActiveFilesSchema,
});

const ToolUseTaskStateSchema = z.object({
  agentConfig: AgentConfigSchema.refine(
    (c) => c.agentCategory === AgentCategory.ToolUse,
    { error: 'Expected ToolUse category' },
  ),
  toolSessionState: ToolSessionStateSchema.optional(),
});

export const TaskStateSchema = z.union([
  WorkflowTaskStateSchema,
  ToolUseTaskStateSchema,
]);

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

export function isWorkflowTaskState(
  taskState: TaskState,
): taskState is WorkflowTaskState {
  return taskState.agentConfig.agentCategory === AgentCategory.Workflow;
}

export function isToolUseTaskState(
  taskState: TaskState,
): taskState is ToolUseTaskState {
  return taskState.agentConfig.agentCategory === AgentCategory.ToolUse;
}
