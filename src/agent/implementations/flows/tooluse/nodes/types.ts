import { z } from 'zod';

import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import {
  ProviderMessageArraySchema,
  type ProviderMessage,
} from '@agent/types/ProviderMessage';
import type { FollowUpQueueBatchItem } from '@agent/followUp/FollowUpQueue';
import {
  ToolUseSnapshotStateSchema,
  type AgentRunStateSnapshot,
  type StateSlicesSnapshot,
  type UserVariableChannels,
} from '@shared/schemas';

/**
 * Full persisted and live shared state for one tool-use flow: the
 * message-free core (`ToolUseSnapshotStateSchema`, the shape a
 * `flow.snapshot` row carries) plus the provider messages, which only the
 * agent layer may name. Parse semantics are the core's (#10641): unknown
 * top-level keys are stripped, malformed known fields fail loudly.
 */
export const ToolUseRunSharedSchema = ToolUseSnapshotStateSchema.extend({
  messages: ProviderMessageArraySchema,
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

/**
 * Parse persisted shared state once before live flow code sees it. Malformed
 * known fields return `{success: false}` and are handled by the existing
 * resume boundary.
 */
export function parseToolUseShared(
  shared: unknown,
): z.ZodSafeParseResult<ToolUseRunShared> {
  return ToolUseRunSharedSchema.safeParse(shared);
}
