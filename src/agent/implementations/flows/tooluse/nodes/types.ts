import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import {
  AgentRunStateSnapshotSchema,
  type AgentRunStateSnapshot,
} from '@agent/core/state/AgentState';
import {
  AgentWorkspaceCurrentSnapshotSchema,
  AgentWorkspaceStateSnapshotSchema,
  type AgentWorkspaceState,
} from '@agent/core/state/AgentWorkspaceState';
import {
  UserVariableChannelsSchema,
  type UserVariableChannels,
} from '@agent/core/definition/AgentCycleOptions';
import {
  ProviderMessageArraySchema,
  type ProviderMessage,
} from '@agent/types/ProviderMessage';
import { ModelHandlerCompatibilityKeySchema } from '@agent/runtime/modelHandlerCompatibilityKey';
import type { FollowUpQueueBatchItem } from '@agent/followUp/FollowUpQueue';
import { RetryErrorInfoSchema } from '@shared/schemas';

export const StateSlicesSchema = z.object({
  runStateSnapshot: AgentRunStateSnapshotSchema,
  workspaceSnapshot: AgentWorkspaceStateSnapshotSchema,
  userChannels: UserVariableChannelsSchema,
});

const StateSlicesCanonicalSchema = StateSlicesSchema.extend({
  workspaceSnapshot: AgentWorkspaceCurrentSnapshotSchema,
});

export type StateSlicesSnapshot = z.output<typeof StateSlicesSchema>;

/** Full persisted and live shared state for one tool-use flow. */
export const ToolUseRunSharedSchema = z.looseObject({
  messages: ProviderMessageArraySchema,
  modelHandlerCompatibilityKey: ModelHandlerCompatibilityKeySchema.nullable()
    .transform((key) => key ?? undefined)
    .optional(),
  shouldSkipCycle: z.boolean(),
  stateSlices: StateSlicesSchema.nullable(),
  /** Per-call system text for providers that do not embed it in messages. */
  systemPrompt: z.string().optional(),
  userCancelledRetry: z.boolean().optional(),
  /** Distinguishes failure from cancellation during resume. */
  lastError: RetryErrorInfoSchema.optional(),
  /** Last assistant response without the full assembly buffers. */
  lastResponse: z.string().optional(),
});

/** Per-step schema after the one-time legacy workspace migration. */
export const ToolUseRunSharedCanonicalSchema = ToolUseRunSharedSchema.extend({
  stateSlices: StateSlicesCanonicalSchema.nullable(),
});

export type ToolUseRunShared = z.output<typeof ToolUseRunSharedSchema>;

/** Extract edited file paths from a workspace state snapshot. */
export function extractTouchedFiles(
  stateSlices: StateSlicesSnapshot | null,
): string[] {
  return (
    stateSlices?.workspaceSnapshot?.interactions?.edits?.map((e) => e.path) ??
    []
  );
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

/**
 * Parse persisted shared state once, normalizing the legacy conversation key,
 * outer state wrapper, and workspace snapshot before live flow code sees it.
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

  const record = obj as Record<string, unknown>;
  const messages = ProviderMessageArraySchema.safeParse(record.messages);
  const conversation = ProviderMessageArraySchema.safeParse(
    record.conversation,
  );
  if (!messages.success && !conversation.success) return null;

  const { conversation: _legacyConversation, ...candidate } = record;
  let migrated = nested;
  if (!messages.success) {
    candidate.messages = conversation.data;
  }
  if (Object.hasOwn(record, 'conversation')) {
    migrated = true;
  }

  const parsed = ToolUseRunSharedSchema.safeParse(candidate);
  if (!parsed.success) return null;

  return {
    data: parsed.data,
    migrated: migrated || !isDeepStrictEqual(candidate, parsed.data),
  };
}
