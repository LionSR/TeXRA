// Local imports
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentCategory, AgentType } from '@agent/core/AgentDataclass';
import type { FileType } from '@utils/config';

/** Shared properties for all task state variants. */
interface BaseTaskState {
  agentConfig: AgentConfig;
  agentType?: AgentType;
  agentCategory: AgentCategory;
}

/**
 * Workflow task state stores file visibility information for toolbar actions.
 */
export interface WorkflowTaskState extends BaseTaskState {
  agentCategory: 'workflow';
  activeFiles: Record<FileType, boolean>;
}

/**
 * Tool-use task state reserves space for persisting interactive session data.
 */
export interface ToolSessionState {
  lastFollowUpAt?: number;
}

export interface ToolUseTaskState extends BaseTaskState {
  agentCategory: 'toolUse';
  toolSessionState?: ToolSessionState;
}

export type TaskState = WorkflowTaskState | ToolUseTaskState;

export function isWorkflowTaskState(
  taskState: TaskState,
): taskState is WorkflowTaskState {
  return taskState.agentCategory === 'workflow';
}

export function isToolUseTaskState(
  taskState: TaskState,
): taskState is ToolUseTaskState {
  return taskState.agentCategory === 'toolUse';
}
