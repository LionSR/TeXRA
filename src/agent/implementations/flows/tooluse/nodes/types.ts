/**
 * Shared types for tool-use flow nodes.
 *
 * Contains state types, result types, and guards used across nodes.
 */
import { z } from 'zod';

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
 * Lightweight schema for detecting shared state format.
 * Uses looseObject to preserve all fields (stateSlices, shouldSkipCycle, etc.)
 * - only validates enough to detect format, not full content.
 */
const ConversationSchema = z.looseObject({
  conversation: z.array(z.unknown()),
});

/**
 * Migrate legacy shared state to current flat format.
 * Legacy: `{ state: { conversation, stateSlices, ... } }`
 * Current: `{ conversation, stateSlices, ... }` (flat)
 *
 * @returns Object with migrated data and whether migration occurred, or null if invalid
 */
export function migrateSharedState(
  shared: unknown,
): { data: ToolUseRunShared; migrated: boolean } | null {
  // Check if already flat format - return same reference (no migration needed)
  const flatResult = ConversationSchema.safeParse(shared);
  if (flatResult.success && !('state' in flatResult.data)) {
    return { data: shared as ToolUseRunShared, migrated: false };
  }

  // Check if legacy format - extract and return nested state
  const obj = shared as Record<string, unknown>;
  if (obj && typeof obj === 'object' && 'state' in obj) {
    const legacyResult = ConversationSchema.safeParse(obj.state);
    if (legacyResult.success) {
      return { data: obj.state as ToolUseRunShared, migrated: true };
    }
  }

  return null;
}
