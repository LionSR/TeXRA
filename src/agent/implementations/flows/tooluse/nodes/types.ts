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
import type { InvocationResult } from '@agent/core/flows/RetryState';
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

/**
 * Result type for tool-use cycle execution.
 * Uses InvocationResult as the single source of truth for result patterns.
 */
export type CycleExecResult = InvocationResult<{ messages: ProviderMessage[] }>;

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

// ============================================================================
// State Migration (Legacy Support)
// ============================================================================

/**
 * Legacy shared state format (pre-flattening).
 * Used for migration from persisted sessions created before the flat structure.
 */
interface LegacyToolUseRunShared {
  state: {
    conversation: ProviderMessage[];
    shouldSkipCycle: boolean;
    stateSlices: StateSlicesSnapshot | null;
    userCancelledRetry?: boolean;
  };
}

/**
 * Check if shared state is in legacy format (wrapped in `state` property).
 */
function isLegacyFormat(shared: unknown): shared is LegacyToolUseRunShared {
  return (
    typeof shared === 'object' &&
    shared !== null &&
    'state' in shared &&
    typeof (shared as LegacyToolUseRunShared).state === 'object' &&
    (shared as LegacyToolUseRunShared).state !== null &&
    'conversation' in (shared as LegacyToolUseRunShared).state
  );
}

/**
 * Migrate legacy shared state to current flat format.
 *
 * PersistedFlow loads shared state from disk on resume. If a user upgrades
 * with an in-progress tool-use session, the stored shared still has the old
 * `{ state: { conversation, stateSlices, ... } }` structure.
 *
 * This function detects and migrates legacy format to prevent failures when
 * the cycle node tries to read `shared.stateSlices` (which would be undefined
 * in legacy format).
 *
 * @param shared - The shared state loaded from persistence (may be legacy format)
 * @returns Shared state in current flat format
 */
export function migrateSharedState(shared: unknown): ToolUseRunShared {
  if (isLegacyFormat(shared)) {
    return {
      conversation: shared.state.conversation,
      shouldSkipCycle: shared.state.shouldSkipCycle,
      stateSlices: shared.state.stateSlices,
      userCancelledRetry: shared.state.userCancelledRetry,
    };
  }

  // Already in current format or fresh start
  return shared as ToolUseRunShared;
}
