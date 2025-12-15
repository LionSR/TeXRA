// Local imports - agent types
import type { AgentCategory, AgentType } from '@agent/core/AgentDataclass';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';
import type { AgentTypeFilter } from '@agent/types/AgentStreamTypes';
import type { StreamStatus } from '@common/constants/streamStatus';

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
  /** Whether this is a remote agent */
  isRemote?: boolean;
  lastTimestamp?: number;
  inputFile?: string;
  creationTimestamp?: number;
  status?: string;
  executionId?: ExecutionId;
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

/**
 * Message payload for UPDATE_STREAM_STATUS command.
 * Used for efficient single-stream status updates without full list refresh.
 */
export interface UpdateStreamStatusMessage {
  command: 'updateStreamStatus';
  stream: StreamTabId;
  status: StreamStatus;
  /** Optional timestamp for updating "last activity" display */
  lastTimestamp?: number;
}
