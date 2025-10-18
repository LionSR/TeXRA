// Local imports - agent types
import type { AgentCategory, AgentType } from '@agent/core/AgentDataclass';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import type { AgentTypeFilter } from '@agent/types/AgentStreamTypes';
// Local imports - logger types
import type { TaskGroup } from '@logger/LogTypes';

export type WorkflowRunInfo = Pick<
  TaskGroup,
  'id' | 'name' | 'startTime' | 'endTime' | 'status'
>;

export interface StreamUITraits {
  /** Canonical session grouping for the stream. */
  sessionKind: AgentCategory;
  /** Indicates whether the associated agent is a tool-use session. */
  isToolAgent: boolean;
}

export interface StreamTabInfo {
  name: string;
  /** Short label displayed in the tab UI */
  label: string;
  model?: string;
  agent?: string;
  agentType?: AgentType;
  agentSessionKind: AgentCategory;
  uiTraits: StreamUITraits;
  hasMultipleOutputs?: boolean;
  lastTimestamp?: number;
  inputFile?: string;
  creationTimestamp?: number;
  status?: string;
  executionId?: ExecutionId;
  /** Identifier of the active workflow run for this stream, when available. */
  activeWorkflowRunId?: string;
  /** Serialized root workflow run groups for this stream. */
  workflowRuns?: WorkflowRunInfo[];
}

export type AgentFilter = AgentTypeFilter;

export interface InstructionMetadata {
  showToggle?: boolean;
  expanded?: boolean;
}

export interface InstructionUpdate {
  text: string;
  metadata?: InstructionMetadata;
}
