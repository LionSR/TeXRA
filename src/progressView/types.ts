// Local imports - agent types
import type { AgentCategory, AgentType } from '@agent/core/AgentDataclass';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import type { AgentTypeFilter } from '@agent/types/AgentStreamTypes';

export interface StreamUITraits {
  /** Canonical session grouping for the stream. */
  sessionKind: AgentCategory;
  /** Indicates whether the associated agent is a tool-use session. */
  isToolAgent: boolean;
}

export interface WorkflowRunInfo {
  id: string;
  name: string;
  startTime: number;
  endTime?: number;
  status?: string;
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
  /** List of top-level workflow runs associated with this stream. */
  workflowRuns?: WorkflowRunInfo[];
  /** Identifier of the active workflow run when available. */
  activeWorkflowRunId?: string;
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
