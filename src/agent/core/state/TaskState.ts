import { z } from 'zod';

import {
  MULTIPLE_DOCUMENT_FILE_TYPES,
  type MultipleDocumentFileType,
} from '@shared/schemas/fileTypes';

import { AgentCategory } from '../definition/AgentDataclass';
import { AgentConfigSchema, type AgentConfig } from '../definition/AgentConfig';

const ToolSessionStateSchema = z.object({});

const ActiveFilesSchema = z
  .partialRecord(z.enum(MULTIPLE_DOCUMENT_FILE_TYPES), z.boolean())
  .transform((partial) => {
    const complete = {} as Record<MultipleDocumentFileType, boolean>;
    for (const key of MULTIPLE_DOCUMENT_FILE_TYPES) {
      complete[key] = partial[key] ?? false;
    }
    return complete;
  });

type WorkflowAgentConfig = AgentConfig & {
  agentCategory: typeof AgentCategory.Workflow;
};

type ToolUseAgentConfig = AgentConfig & {
  agentCategory: typeof AgentCategory.ToolUse;
};

export interface WorkflowTaskState {
  agentConfig: WorkflowAgentConfig;
  activeFiles: Record<MultipleDocumentFileType, boolean>;
}

export interface ToolUseTaskState {
  agentConfig: ToolUseAgentConfig;
  toolSessionState?: ToolSessionState;
}

export type TaskState = WorkflowTaskState | ToolUseTaskState;

const WorkflowAgentConfigSchema = AgentConfigSchema.refine(
  (c) => c.agentCategory === AgentCategory.Workflow,
  { error: 'Expected Workflow category' },
) as z.ZodType<WorkflowAgentConfig>;

const ToolUseAgentConfigSchema = AgentConfigSchema.refine(
  (c) => c.agentCategory === AgentCategory.ToolUse,
  { error: 'Expected ToolUse category' },
) as z.ZodType<ToolUseAgentConfig>;

const WorkflowTaskStateSchema = z.object({
  agentConfig: WorkflowAgentConfigSchema,
  activeFiles: ActiveFilesSchema,
}) satisfies z.ZodType<WorkflowTaskState>;

const ToolUseTaskStateSchema = z.object({
  agentConfig: ToolUseAgentConfigSchema,
  toolSessionState: ToolSessionStateSchema.optional(),
}) satisfies z.ZodType<ToolUseTaskState>;

export const TaskStateSchema = z.union([
  WorkflowTaskStateSchema,
  ToolUseTaskStateSchema,
]) satisfies z.ZodType<TaskState>;

export type ToolSessionState = z.infer<typeof ToolSessionStateSchema>;

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
