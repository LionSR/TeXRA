import { isDeepStrictEqual } from 'node:util';

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
import {
  ProviderMessageArraySchema,
  type ProviderMessage,
} from '@agent/types/ProviderMessage';
import { ModelHandlerCompatibilityKeySchema } from '@agent/runtime/modelHandlerCompatibilityKey';
import type { FollowUpQueueBatchItem } from '@agent/followUp/FollowUpQueue';
import { JsonValueSchema, RetryErrorInfoSchema } from '@shared/schemas';

const StateSlicesSchema = z.object({
  runStateSnapshot: AgentRunStateSnapshotSchema,
  workspaceSnapshot: AgentWorkspaceStateSnapshotSchema,
  userChannels: UserVariableChannelsSchema,
});

export type StateSlicesSnapshot = z.output<typeof StateSlicesSchema>;

/**
 * Full persisted and live shared state for one tool-use flow.
 *
 * Default `z.object` semantics by decision (#10641), matching reflection's
 * shared schema: unknown top-level keys in a persisted record are accepted
 * but stripped at this parse boundary, and the existing deep-equal
 * self-heal checks on both resume paths then rewrite the healed record.
 * The heal is one-directional: an upgrade → resume-on-older-build →
 * upgrade cycle permanently erases the newer build's unknown keys, so a
 * future load-bearing top-level field must be added with that erasure in
 * mind. Deliberately not `z.strictObject` — a record written by a newer
 * build carrying keys this build does not know must still resume — and no
 * `.catch`: malformed known fields must keep failing loudly.
 */
export const ToolUseRunSharedSchema = z.object({
  messages: ProviderMessageArraySchema,
  /** Durable identity of the continuation attempt that owns this flow. */
  continuationGenerationId: z.uuid(),
  /**
   * The model the run is on, mirroring the live `ModelCell`. This is the
   * resume SSOT for model identity.
   */
  modelId: z.string().optional(),
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
  /** Validated terminal-tool result retained across interrupt and resume. */
  structured: JsonValueSchema.optional(),
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
  /**
   * `assembly.lastResponse` as captured when this cycle prepared — the
   * historical baseline. `ToolUseCycleNode.post()` may fall back to assembly
   * text only when it differs from this value, i.e. when the text was written
   * during this cycle (e.g. the failure-path copy in `exec`). An unchanged
   * value is a previous turn's response, and an answerless cycle must not
   * return it as its result (#9531).
   */
  cycleStartLastResponse: string;
  systemPrompt?: string;
}

export type PreparedShared = ToolUseRunShared & {
  stateSlices: StateSlicesSnapshot;
};

type ParsedToolUseSharedResult =
  | { success: true; data: ToolUseRunShared; changed: boolean }
  | { success: false; error: z.ZodError };

/**
 * Parse persisted shared state once before live flow code sees it. Malformed
 * known fields return `{success: false}` and are handled by the existing
 * resume boundary.
 */
export function parseToolUseShared(shared: unknown): ParsedToolUseSharedResult {
  const parsed = ToolUseRunSharedSchema.safeParse(shared);
  if (!parsed.success) return parsed;

  return {
    success: true,
    data: parsed.data,
    changed: !isDeepStrictEqual(shared, parsed.data),
  };
}
