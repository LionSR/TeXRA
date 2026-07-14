import { z } from 'zod';

import {
  MULTIPLE_DOCUMENT_FILE_TYPES,
  type MultipleDocumentFileType,
} from '@shared/schemas/fileTypes';

import { AgentCategory } from '../definition/AgentDataclass';
import {
  ToolUseAgentConfigSchema,
  WorkflowAgentConfigSchema,
  type ToolUseAgentConfig,
  type WorkflowAgentConfig,
} from '../definition/AgentConfig';

const ActiveFilesSchema = z
  .partialRecord(z.enum(MULTIPLE_DOCUMENT_FILE_TYPES), z.boolean())
  .transform((partial) => {
    const complete = {} as Record<MultipleDocumentFileType, boolean>;
    for (const key of MULTIPLE_DOCUMENT_FILE_TYPES) {
      complete[key] = partial[key] ?? false;
    }
    return complete;
  });

export interface WorkflowTaskState {
  agentConfig: WorkflowAgentConfig;
  activeFiles: Record<MultipleDocumentFileType, boolean>;
}

export interface ToolUseTaskState {
  agentConfig: ToolUseAgentConfig;
}

export type TaskState = WorkflowTaskState | ToolUseTaskState;

const WorkflowTaskStateSchema = z.object({
  agentConfig: WorkflowAgentConfigSchema,
  activeFiles: ActiveFilesSchema,
}) satisfies z.ZodType<WorkflowTaskState>;

const ToolUseTaskStateSchema = z.object({
  agentConfig: ToolUseAgentConfigSchema,
}) satisfies z.ZodType<ToolUseTaskState>;

export const TaskStateSchema = z.union([
  WorkflowTaskStateSchema,
  ToolUseTaskStateSchema,
]) satisfies z.ZodType<TaskState>;

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
