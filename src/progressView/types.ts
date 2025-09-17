// Local imports - agent types
import type { AgentType } from '@agent/core/AgentDataclass';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import type { AgentTypeFilter } from '@agent/types/AgentStreamTypes';

export interface StreamUITraits {
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
  uiTraits: StreamUITraits;
  hasMultipleOutputs?: boolean;
  lastTimestamp?: number;
  inputFile?: string;
  creationTimestamp?: number;
  status?: string;
  executionId?: ExecutionId;
}

export type AgentFilter = AgentTypeFilter;
