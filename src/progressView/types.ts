// Local imports - agent types
import type { AgentType } from '@agent/core/AgentDataclass';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import type { AgentTypeFilter } from '@agent/types/AgentStreamTypes';

export interface StreamCapabilities {
  canRunAgain: boolean;
  canDiffStream: boolean;
  canPackStream: boolean;
  canCleanStream: boolean;
  canSendFollowUp: boolean;
}

export interface StreamTabInfo {
  name: string;
  /** Short label displayed in the tab UI */
  label: string;
  model?: string;
  agent?: string;
  agentType?: AgentType;
  hasMultipleOutputs?: boolean;
  lastTimestamp?: number;
  inputFile?: string;
  creationTimestamp?: number;
  status?: string;
  executionId?: ExecutionId;
  isToolUseAgent: boolean;
  capabilities: StreamCapabilities;
}

export type AgentFilter = AgentTypeFilter;
