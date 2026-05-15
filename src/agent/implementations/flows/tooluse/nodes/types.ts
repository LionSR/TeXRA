import { z } from 'zod';

import type { AgentRunStateSnapshot } from '@agent/core/AgentState';
import type {
  AgentWorkspaceState,
  AgentWorkspaceSnapshot,
} from '@agent/core/AgentWorkspaceState';
import type { UserVariableChannels } from '@agent/core/AgentCycleOptions';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { RetryErrorInfo } from '@shared/schemas';

export interface StateSlicesSnapshot {
  runStateSnapshot: AgentRunStateSnapshot;
  workspaceSnapshot: AgentWorkspaceSnapshot;
  userChannels: UserVariableChannels;
}

/** Extract edited file paths from a workspace state snapshot. */
export function extractTouchedFiles(
  stateSlices: StateSlicesSnapshot | null,
): string[] {
  return (
    stateSlices?.workspaceSnapshot?.interactions?.edits?.map((e) => e.path) ??
    []
  );
}

export interface ToolUseRunShared {
  messages: ProviderMessage[];
  shouldSkipCycle: boolean;
  stateSlices: StateSlicesSnapshot | null;
  userCancelledRetry?: boolean;
  /** Distinguishes failure from cancellation during resume. */
  lastError?: RetryErrorInfo;
}

export interface PrepareResult {
  runState: AgentRunStateSnapshot;
  workspaceState: AgentWorkspaceState;
  userChannels: UserVariableChannels;
  messages: ProviderMessage[];
  shouldSkipCycle: boolean;
}

export type WaitExecResult =
  | {
      kind: 'continue';
      followUp: string;
      /**
       * True when `followUp` was synthesized by an idle-continuation provider
       * instead of being consumed from `session.waitForFollowUp()`. The
       * post() handler uses this to skip `onFollowUpConsumed` so synthetic
       * continuations don't emit a spurious updateQueuedFollowUps event.
       */
      synthetic?: boolean;
    }
  | { kind: 'stop' };

export interface CyclePrepResult {
  runState: AgentRunStateSnapshot;
  workspaceState: AgentWorkspaceState;
  userChannels: UserVariableChannels;
  messages: ProviderMessage[];
  shouldSkip: boolean;
}

export type PreparedShared = ToolUseRunShared & {
  stateSlices: StateSlicesSnapshot;
};

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

const MessagesSchema = z.looseObject({ messages: z.array(z.unknown()) });
const LegacyConversationSchema = z.looseObject({
  conversation: z.array(z.unknown()),
});

/**
 * Migrate legacy shared state formats to current ToolUseRunShared.
 * Handles: flat with `messages`, flat with `conversation`, and nested `{ state: {...} }`.
 * Returns null if unparseable.
 */
export function migrateSharedState(
  shared: unknown,
): { data: ToolUseRunShared; migrated: boolean } | null {
  if (!shared || typeof shared !== 'object') return null;

  // Unwrap nested `{ state: {...} }` wrapper if present. The unwrap itself
  // counts as a migration even if the inner shape is already canonical.
  const nested = 'state' in shared;
  const obj = nested ? (shared as Record<string, unknown>).state : shared;
  if (!obj || typeof obj !== 'object') return null;

  if (MessagesSchema.safeParse(obj).success) {
    return { data: obj as ToolUseRunShared, migrated: nested };
  }
  if (LegacyConversationSchema.safeParse(obj).success) {
    const { conversation, ...rest } = obj as Record<string, unknown>;
    return {
      data: { ...rest, messages: conversation } as ToolUseRunShared,
      migrated: true,
    };
  }
  return null;
}
