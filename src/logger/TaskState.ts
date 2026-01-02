// Local imports
import type { AgentConfig } from '@agent/core/AgentConfig';
// Internal imports
import {
  AgentCategory,
  type AgentSessionDescriptor,
} from '@agent/core/AgentDataclass';

// Type imports
import type { FileType } from '@utils/config';

/** Shared properties for all task state variants. */
interface BaseTaskState {
  agentConfig: AgentConfig;
}

/**
 * Workflow task state stores file visibility information for toolbar actions.
 */
export interface WorkflowTaskState extends BaseTaskState {
  agentConfig: AgentConfig & {
    session: AgentSessionDescriptor & { agentCategory: AgentCategory.Workflow };
  };
  activeFiles: Record<FileType, boolean>;
}

/**
 * Tool-use task state reserves space for persisting interactive session data.
 */
export interface ToolSessionState {
  lastFollowUpAt?: number;
}

export interface ToolUseTaskState extends BaseTaskState {
  agentConfig: AgentConfig & {
    session: AgentSessionDescriptor & { agentCategory: AgentCategory.ToolUse };
  };
  toolSessionState?: ToolSessionState;
}

export type TaskState = WorkflowTaskState | ToolUseTaskState;

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
