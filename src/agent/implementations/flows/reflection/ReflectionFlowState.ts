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

export const ReflectionFlowStateSchema = z.object({
  currentRound: z.int().nonnegative(),
  totalRounds: z.int().nonnegative(),

  workspaceSnapshot: AgentWorkspaceStateSnapshotSchema,
  context: ProviderMessageArraySchema.nullable(),
  outputLocation: AgentFileLocationSchema.nullable(),

  runStateSnapshot: AgentRunStateSnapshotSchema,

  roundOutputs: z.array(RoundOutputSchema),

  continueRounds: z.boolean(),
  endTurn: z.boolean(),

  /** Distinguishes failure from cancellation during resume. */
  lastError: RetryErrorInfoSchema.optional(),

  /** Provider-message format used by the persisted `context` messages.
   *  Absent for an untagged handler. */
  modelHandlerCompatibilityKey: ModelHandlerCompatibilityKeySchema.optional(),

  /** One-shot compile-failure feedback injected into the next round prompt. */
  compileFailureContext: z.string().optional(),

  /** Rejected compile result awaiting an explicit successful compile. */
  unresolvedCompileRejection: z.boolean().optional(),
});

/** Shared state type for reflection flow nodes. */
export type ReflectionFlowShared = z.infer<typeof ReflectionFlowStateSchema>;
