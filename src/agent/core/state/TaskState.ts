import { z } from 'zod';

import {
  MULTIPLE_DOCUMENT_FILE_TYPES,
  type MultipleDocumentFileType,
} from '@shared/schemas/fileTypes';

import { AgentCategory } from '../definition/AgentDataclass';
import {
  ToolUseAgentConfigSchema,
  WorkflowAgentConfigSchema,
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

const WorkflowTaskStateSchema = z.object({
  agentConfig: WorkflowAgentConfigSchema,
  activeFiles: ActiveFilesSchema,
});
export type WorkflowTaskState = z.infer<typeof WorkflowTaskStateSchema>;

const ToolUseTaskStateSchema = z.object({
  agentConfig: ToolUseAgentConfigSchema,
});
export type ToolUseTaskState = z.infer<typeof ToolUseTaskStateSchema>;

export const TaskStateSchema = z.union([
  WorkflowTaskStateSchema,
  ToolUseTaskStateSchema,
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

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
