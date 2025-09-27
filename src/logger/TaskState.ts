// Local imports
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSessionKind } from '@agent/core/AgentDataclass';
import type { AgentType } from '@agent/core/AgentDataclass';
import type { FileType } from '@utils/config';

/** Shared properties for all task state variants. */
interface BaseTaskState {
  agentConfig: AgentConfig;
  agentType?: AgentType;
  agentSessionKind: AgentSessionKind;
}

/**
 * Workflow task state stores file visibility information for toolbar actions.
 */
export interface WorkflowTaskState extends BaseTaskState {
  agentSessionKind: AgentSessionKind.Workflow;
  activeFiles: Record<FileType, boolean>;
}

/**
 * Tool-use task state reserves space for persisting interactive session data.
 */
export interface ToolSessionState {
  lastFollowUpAt?: number;
}

export interface ToolUseTaskState extends BaseTaskState {
  agentSessionKind: AgentSessionKind.ToolUse;
  toolSessionState?: ToolSessionState;
}

export type TaskState = WorkflowTaskState | ToolUseTaskState;

export function isWorkflowTaskState(
  taskState: TaskState,
): taskState is WorkflowTaskState {
  return taskState.agentSessionKind === AgentSessionKind.Workflow;
}

export function isToolUseTaskState(
  taskState: TaskState,
): taskState is ToolUseTaskState {
  return taskState.agentSessionKind === AgentSessionKind.ToolUse;
}
