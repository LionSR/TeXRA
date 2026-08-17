/** Shared state types for reflection flow (flat, natively serializable). */

import { z } from 'zod';

import {
  AgentRunStateSnapshotSchema,
  ConversationRoundStateSnapshotSchema,
} from '@agent/core/state/AgentState';
import { AgentWorkspaceStateSnapshotSchema } from '@agent/core/state/AgentWorkspaceState';
import { ProviderMessageArraySchema } from '@agent/types/ProviderMessage';
import { ModelHandlerCompatibilityKeySchema } from '@agent/runtime/modelHandlerCompatibilityKey';
import {
  AgentFileLocationSchema,
  CompileResultSchema,
  RetryErrorInfoSchema,
  RoundOutputSchema,
} from '@shared/schemas';

const RoundContextSchema = z.object({
  messages: ProviderMessageArraySchema,
  stateRoundSnapshot: ConversationRoundStateSnapshotSchema,
});

export type RoundContext = z.infer<typeof RoundContextSchema>;

export const ReflectionFlowStateSchema = z.object({
  currentRound: z.int().nonnegative(),
  totalRounds: z.int().nonnegative(),

  workspaceSnapshot: AgentWorkspaceStateSnapshotSchema,
  context: RoundContextSchema.nullable(),
  outputLocation: AgentFileLocationSchema.nullable(),

  conversation: ProviderMessageArraySchema,
  runStateSnapshot: AgentRunStateSnapshotSchema,

  roundStateSnapshots: z.array(ConversationRoundStateSnapshotSchema),
  roundOutputs: z.array(RoundOutputSchema),

  continueRounds: z.boolean(),
  endTurn: z.boolean(),

  /** Distinguishes failure from cancellation during resume. */
  lastError: RetryErrorInfoSchema.optional(),

  /** Provider-message format used by the persisted conversation. */
  modelHandlerCompatibilityKey: ModelHandlerCompatibilityKeySchema.nullish(),

  /** Final LaTeX compile status for the last completed round, when checked. */
  lastCompileResult: CompileResultSchema.optional(),

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
