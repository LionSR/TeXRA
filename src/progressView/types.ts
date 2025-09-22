// Local imports - agent types
import type { AgentSessionKind, AgentType } from '@agent/core/AgentDataclass';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import type { AgentTypeFilter } from '@agent/types/AgentStreamTypes';

export interface StreamUITraits {
  /** Canonical session grouping for the stream. */
  sessionKind: AgentSessionKind;
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
  agentSessionKind: AgentSessionKind;
  uiTraits: StreamUITraits;
  hasMultipleOutputs?: boolean;
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
