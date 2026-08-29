/** Shared state types for reflection flow (flat, natively serializable). */

import { z } from 'zod';

import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceStateSnapshotSchema } from '@agent/core/state/AgentWorkspaceState';
import { ProviderMessageArraySchema } from '@agent/types/ProviderMessage';
import { ModelHandlerCompatibilityKeySchema } from '@agent/runtime/modelHandlerCompatibilityKey';
import {
  AgentFileLocationSchema,
  RetryErrorInfoSchema,
  RoundOutputSchema,
} from '@shared/schemas';

/**
 * The round conversation, normalized at this parse boundary.
 *
 * Records written before the round-metrics snapshot was moved out of the
 * persisted context wrapped the messages in `{ messages, stateRoundSnapshot }`.
 * That snapshot is a per-attempt metrics accumulator, so persisting it meant a
 * round resumed after a cancel re-recorded the cancelled attempt's response
 * time and usage. The snapshot is now minted fresh per attempt in
 * `ResponseCycleNode`, and the legacy wrapper unwraps to its messages here so
 * nothing downstream branches on the format.
 *
 * Legacy arm introduced 2026-08-29 with the retirement (#11568); remove it
 * after 2026-11-29 once persisted wrapped-context rounds have aged out.
 */
const RoundConversationSchema = z.union([
  z
    .object({
      messages: ProviderMessageArraySchema,
      stateRoundSnapshot: z.unknown(),
    })
    .transform((legacy) => legacy.messages),
  ProviderMessageArraySchema,
]);

export const ReflectionFlowStateSchema = z.object({
  currentRound: z.int().nonnegative(),
  totalRounds: z.int().nonnegative(),

  workspaceSnapshot: AgentWorkspaceStateSnapshotSchema,
  context: RoundConversationSchema.nullable(),
  outputLocation: AgentFileLocationSchema.nullable(),

  runStateSnapshot: AgentRunStateSnapshotSchema,

  roundOutputs: z.array(RoundOutputSchema),

  continueRounds: z.boolean(),
  endTurn: z.boolean(),

  /** Distinguishes failure from cancellation during resume. */
  lastError: RetryErrorInfoSchema.optional(),

  /** Provider-message format used by the persisted `context` messages. */
  modelHandlerCompatibilityKey: ModelHandlerCompatibilityKeySchema.nullish(),

  /** One-shot repair context injected into the next round's user request. */
  compileFailureContext: z.string().optional(),

  /**
   * Set once a compile-repair round has been granted, so a compile failure
   * on that repair round (or a resumed run) can't grant a second one.
   * Bounds the repair round to exactly one per run.
   */
  compileRepairRoundGranted: z.boolean().optional(),
});

/** Shared state type for reflection flow nodes. */
export type ReflectionFlowShared = z.infer<typeof ReflectionFlowStateSchema>;
