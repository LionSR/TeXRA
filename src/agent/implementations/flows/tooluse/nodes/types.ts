/**
 * Shared types for tool-use flow nodes.
 *
 * Contains state types, result types, and guards used across nodes.
 */
import type {
  AgentRunState,
  AgentRunStateSnapshot,
} from '@agent/core/AgentState';
import type {
  AgentWorkspaceState,
  AgentWorkspaceSnapshot,
} from '@agent/core/AgentWorkspaceState';
import type { UserVariableChannels } from '@agent/core/AgentCycleOptions';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

// ============================================================================
// State Types
// ============================================================================

export interface StateSlicesSnapshot {
  runStateSnapshot: AgentRunStateSnapshot;
  workspaceSnapshot: AgentWorkspaceSnapshot;
  userChannels: UserVariableChannels;
}

/**
 * Runtime shared state for tool-use flows.
 * Stored as serializable snapshots for PersistedFlow.
 *
 * Uses flat structure (like reflection) for consistent access patterns:
 * - shared.conversation (not shared.state.conversation)
 * - shared.stateSlices (not shared.state.stateSlices)
 */
export interface ToolUseRunShared {
  conversation: ProviderMessage[];
  shouldSkipCycle: boolean;
  stateSlices: StateSlicesSnapshot | null;
  userCancelledRetry?: boolean;
}

// ============================================================================
// Result Types
// ============================================================================

export interface PrepareResult {
  messages: ProviderMessage[];
  runState: AgentRunState;
  workspaceState: AgentWorkspaceState;
  userChannels: UserVariableChannels;
  shouldSkipCycle: boolean;
}

export type CycleExecResult =
  | { kind: 'success'; messages: ProviderMessage[] }
  | { kind: 'skipped' }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' };

export type WaitExecResult =
  | { kind: 'continue'; followUp: string }
  | { kind: 'stop' };

export interface CyclePrepResult {
  shouldSkip: boolean;
  conversation: ProviderMessage[];
  runState: AgentRunState;
  workspaceState: AgentWorkspaceState;
  userChannels: UserVariableChannels;
}

// ============================================================================
// State Guards
// ============================================================================

export type PreparedShared = ToolUseRunShared & {
  stateSlices: StateSlicesSnapshot;
};

export function assertPreparedShared(
  shared: ToolUseRunShared,
): asserts shared is PreparedShared {
  if (shared.stateSlices === null) {
    throw new Error('PrepareNode must run before CycleNode');
  }
}
