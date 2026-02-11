/**
 * Shared types for tool-use flow nodes.
 */
import { z } from 'zod';

import type { AgentRunStateSnapshot } from '@agent/core/AgentState';
import type {
  AgentWorkspaceState,
  AgentWorkspaceSnapshot,
} from '@agent/core/AgentWorkspaceState';
import type { UserVariableChannels } from '@agent/core/AgentCycleOptions';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

export interface StateSlicesSnapshot {
  runStateSnapshot: AgentRunStateSnapshot;
  workspaceSnapshot: AgentWorkspaceSnapshot;
  userChannels: UserVariableChannels;
}

/** Runtime shared state for tool-use flows (flat structure for PersistedFlow). */
export interface ToolUseRunShared {
  messages: ProviderMessage[];
  shouldSkipCycle: boolean;
  stateSlices: StateSlicesSnapshot | null;
  userCancelledRetry?: boolean;
}

interface NodeResultStateBase {
  runState: AgentRunStateSnapshot;
  workspaceState: AgentWorkspaceState;
  userChannels: UserVariableChannels;
}

/** Result from ToolUsePrepareNode. */
export interface PrepareResult extends NodeResultStateBase {
  messages: ProviderMessage[];
  shouldSkipCycle: boolean;
}

/** Result from ToolUseWaitNode exec phase. */
export type WaitExecResult =
  | { kind: 'continue'; followUp: string }
  | { kind: 'stop' };

/** Result from ToolUseCycleNode prep phase. */
export interface CyclePrepResult extends NodeResultStateBase {
  messages: ProviderMessage[];
  shouldSkip: boolean;
}

export type PreparedShared = ToolUseRunShared & {
  stateSlices: StateSlicesSnapshot;
};

/** Walk messages backwards to find the last assistant text. */
export function findLastAssistantText(
  messages: ProviderMessage[],
  extractAssistantText: (message: ProviderMessage) => string | undefined,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = extractAssistantText(messages[i]);
    if (text !== undefined) return text;
  }
  return undefined;
}

export function assertPreparedShared(
  shared: ToolUseRunShared,
): asserts shared is PreparedShared {
  if (shared.stateSlices === null) {
    throw new Error('PrepareNode must run before CycleNode');
  }
}

/** Lightweight schema for detecting shared state format (handles both field names). */
const MessagesSchema = z.looseObject({
  messages: z.array(z.unknown()),
});
const LegacyConversationSchema = z.looseObject({
  conversation: z.array(z.unknown()),
});

/**
 * Migrate legacy shared state formats to current ToolUseRunShared:
 * 1. Nested `{ state: {...} }` → flat format
 * 2. Legacy `conversation` field → `messages` field
 * Returns null if the state is unparseable.
 */
export function migrateSharedState(
  shared: unknown,
): { data: ToolUseRunShared; migrated: boolean } | null {
  // Try current format first (flat with `messages`)
  const currentResult = MessagesSchema.safeParse(shared);
  if (currentResult.success && !('state' in currentResult.data)) {
    return { data: shared as ToolUseRunShared, migrated: false };
  }

  // Try legacy flat format (`conversation` → `messages`)
  const legacyFlatResult = LegacyConversationSchema.safeParse(shared);
  if (legacyFlatResult.success && !('state' in legacyFlatResult.data)) {
    const { conversation, ...rest } = shared as Record<string, unknown>;
    return {
      data: { ...rest, messages: conversation } as ToolUseRunShared,
      migrated: true,
    };
  }

  // Try nested format (`{ state: {...} }`)
  const obj = shared as Record<string, unknown>;
  if (obj && typeof obj === 'object' && 'state' in obj) {
    const nestedCurrent = MessagesSchema.safeParse(obj.state);
    if (nestedCurrent.success) {
      return { data: obj.state as ToolUseRunShared, migrated: true };
    }
    const nestedLegacy = LegacyConversationSchema.safeParse(obj.state);
    if (nestedLegacy.success) {
      const { conversation, ...rest } = obj.state as Record<string, unknown>;
      return {
        data: { ...rest, messages: conversation } as ToolUseRunShared,
        migrated: true,
      };
    }
  }

  return null;
}
