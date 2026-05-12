import { z } from 'zod';

import { AgentCategory } from '@agent/core/AgentDataclass';
import { AgentConfigSchema, type AgentConfig } from '@agent/core/AgentConfig';
import { DOCUMENT_FILE_TYPES, type DocumentFileType } from '@utils/config';

const ToolSessionStateSchema = z.object({
  lastFollowUpAt: z.number().optional(),
});

const ActiveFilesSchema = z.partialRecord(
  z.enum(DOCUMENT_FILE_TYPES),
  z.boolean(),
) as z.ZodType<Record<DocumentFileType, boolean>>;

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
  agentConfig: AgentConfig & { agentCategory: typeof AgentCategory.Workflow };
  activeFiles: Record<DocumentFileType, boolean>;
}

export interface ToolUseTaskState {
  agentConfig: AgentConfig & { agentCategory: typeof AgentCategory.ToolUse };
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
