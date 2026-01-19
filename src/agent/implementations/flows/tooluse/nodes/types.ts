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
 * Lightweight schema for detecting flat vs legacy shared state format.
 * Validates only the minimum needed to determine format - full content
 * validation happens in SessionResumeRetrieval.ts during session resume.
 */
const FlatFormatSchema = z.object({ conversation: z.array(z.unknown()) });
const LegacyFormatSchema = z.object({
  state: z.object({ conversation: z.array(z.unknown()) }),
});

const MigrationSharedSchema = z
  .union([FlatFormatSchema, LegacyFormatSchema])
  .transform((data) => ('state' in data ? data.state : data));

/**
 * Migrate legacy shared state to current flat format.
 * Legacy: `{ state: { conversation, stateSlices, ... } }`
 * Current: `{ conversation, stateSlices, ... }` (flat)
 *
 * @returns Migrated state, or null if neither format matches
 */
export function migrateSharedState(shared: unknown): ToolUseRunShared | null {
  const result = MigrationSharedSchema.safeParse(shared);
  return result.success ? (result.data as ToolUseRunShared) : null;
}
