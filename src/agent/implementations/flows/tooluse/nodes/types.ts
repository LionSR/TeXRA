import { z } from 'zod';

import {
  AgentRunStateSnapshotSchema,
  type AgentRunStateSnapshot,
} from '@agent/core/state/AgentState';
import {
  AgentWorkspaceStateSnapshotSchema,
  type AgentWorkspaceState,
} from '@agent/core/state/AgentWorkspaceState';
import {
  UserVariableChannelsSchema,
  type UserVariableChannels,
} from '@agent/core/definition/AgentCycleOptions';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityKey';
import type { FollowUpQueueBatchItem } from '@agent/followUp/FollowUpQueue';
import type { RetryErrorInfo } from '@shared/schemas';

export const StateSlicesSchema = z.object({
  runStateSnapshot: AgentRunStateSnapshotSchema,
  workspaceSnapshot: AgentWorkspaceStateSnapshotSchema,
  userChannels: UserVariableChannelsSchema,
});

export type StateSlicesSnapshot = z.infer<typeof StateSlicesSchema>;

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
  modelHandlerCompatibilityKey?: ModelHandlerCompatibilityKey;
  shouldSkipCycle: boolean;
  stateSlices: StateSlicesSnapshot | null;
  /**
   * System prompt for providers that pass `system` per-call (Anthropic,
   * Google) instead of embedding it into `messages`. Set once by
   * `ToolUsePrepareNode`; threaded into every `ToolUseRoundShared` by
   * `ToolUseCycleNode` so it reaches `createResponse` on every round.
   */
  systemPrompt?: string;
  userCancelledRetry?: boolean;
  /** Distinguishes failure from cancellation during resume. */
  lastError?: RetryErrorInfo;
  /** Last assembled assistant response, retained without persisting full assembly strings. */
  lastResponse?: string;
  /** True after a tool-use subagent delivered a cycle result to its parent. */
  deliveredToOrchestrator?: boolean;
}

export type WaitExecResult =
  | {
      kind: 'continue';
      followUps: readonly FollowUpQueueBatchItem[];
      /**
       * True when `followUps` were synthesized by an idle-continuation provider
       * instead of being consumed from `session.waitForFollowUp()`. The
       * post() handler uses this to skip `onFollowUpConsumed` so synthetic
       * continuations don't emit a spurious updateQueuedFollowUps event.
       */
      synthetic?: boolean;
    }
  | { kind: 'stop' }
  | { kind: 'waiting' };

/**
 * Prepared shared state needed to run one tool-use cycle: produced by
 * `ToolUsePrepareNode`'s one-time session init and re-derived by
 * `ToolUseCycleNode.prep()` from `shared.stateSlices` on every subsequent
 * cycle.
 */
export interface CyclePrepResult {
  runState: AgentRunStateSnapshot;
  workspaceState: AgentWorkspaceState;
  userChannels: UserVariableChannels;
  messages: ProviderMessage[];
  shouldSkipCycle: boolean;
  systemPrompt?: string;
}

export type PreparedShared = ToolUseRunShared & {
  stateSlices: StateSlicesSnapshot;
};

export function findLastAssistantText(
  messages: ProviderMessage[],
  extractAssistantText: (message: ProviderMessage) => string | undefined,
): string | undefined {
  for (const message of messages.toReversed()) {
    const text = extractAssistantText(message);
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
