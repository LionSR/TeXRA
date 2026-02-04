/**
 * Shared types for tool-use flow nodes.
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
import type { CompactionState } from '@shared/schemas';

export interface StateSlicesSnapshot {
  runStateSnapshot: AgentRunStateSnapshot;
  workspaceSnapshot: AgentWorkspaceSnapshot;
  userChannels: UserVariableChannels;
}

/** Runtime shared state for tool-use flows (flat structure for PersistedFlow). */
export interface ToolUseRunShared {
  conversation: ProviderMessage[];
  shouldSkipCycle: boolean;
  stateSlices: StateSlicesSnapshot | null;
  userCancelledRetry?: boolean;
  compactionState?: CompactionState | null;
}

interface NodeResultStateBase {
  runState: AgentRunState;
  workspaceState: AgentWorkspaceState;
  userChannels: UserVariableChannels;
}

/** Result from ToolUsePrepareNode. */
export interface PrepareResult extends NodeResultStateBase {
  messages: ProviderMessage[];
  shouldSkipCycle: boolean;
  compactionState: CompactionState | null;
}

/** Result from ToolUseCycleNode exec phase. */
export type CycleExecResult = InvocationResult<{
  messages: ProviderMessage[];
  compactionState: CompactionState | null;
}>;

/** Result from ToolUseWaitNode exec phase. */
export type WaitExecResult =
  | { kind: 'continue'; followUp: string }
  | { kind: 'stop' };

/** Result from ToolUseCycleNode prep phase. */
export interface CyclePrepResult extends NodeResultStateBase {
  conversation: ProviderMessage[];
  shouldSkip: boolean;
  compactionState: CompactionState | null;
}

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

/** Lightweight schema for detecting shared state format. */
const ConversationSchema = z.looseObject({
  conversation: z.array(z.unknown()),
  compactionState: z.unknown().optional(),
});

/**
 * Migrate legacy shared state (nested `{ state: {...} }`) to flat format.
 * Returns null if the state is unparseable.
 */
export function migrateSharedState(
  shared: unknown,
): { data: ToolUseRunShared; migrated: boolean } | null {
  const flatResult = ConversationSchema.safeParse(shared);
  if (flatResult.success && !('state' in flatResult.data)) {
    const data = shared as ToolUseRunShared;
    if (data.compactionState === undefined) {
      data.compactionState = null;
    }
    return { data, migrated: false };
  }

  const obj = shared as Record<string, unknown>;
  if (obj && typeof obj === 'object' && 'state' in obj) {
    const legacyResult = ConversationSchema.safeParse(obj.state);
    if (legacyResult.success) {
      const data = obj.state as ToolUseRunShared;
      if (data.compactionState === undefined) {
        data.compactionState = null;
      }
      return { data, migrated: true };
    }
  }

  return null;
}
