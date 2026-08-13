/** Shared state types for reflection flow (flat, natively serializable). */

import { z } from 'zod';

import {
  AgentRunStateSnapshotSchema,
  ConversationRoundStateSnapshotSchema,
} from '@agent/core/state/AgentState';
import {
  AgentWorkspaceCurrentSnapshotSchema,
  AgentWorkspaceStateSnapshotSchema,
} from '@agent/core/state/AgentWorkspaceState';
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

/**
 * Same shape as `ReflectionFlowStateSchema`, but `workspaceSnapshot` is
 * validated against the strict canonical schema instead of the
 * legacy-migrating union. `ReflectionFlowStateSchema` itself stays reserved
 * for the one-time boundary parse of a freshly-read persisted record (see
 * `runReflectionFlow`'s resume check); `RoundPersistedFlow`'s defense-in-depth
 * revalidation runs on every node step against an already-canonical
 * in-memory `shared` (round-tripped through `AgentWorkspaceState.toSnapshot()`),
 * so it uses this variant to avoid re-walking the legacy arm on every step —
 * and to fail loudly, rather than silently migrate, if a mid-flow record
 * were ever corrupted into looking like the legacy shape.
 */
export const ReflectionFlowStateCanonicalSchema =
  ReflectionFlowStateSchema.extend({
    workspaceSnapshot: AgentWorkspaceCurrentSnapshotSchema,
  });
