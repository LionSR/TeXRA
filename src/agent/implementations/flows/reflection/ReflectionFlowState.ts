/** Shared state types for reflection flow (flat, natively serializable). */

import { z } from 'zod';

import {
  AgentRunStateSnapshotSchema,
  ConversationRoundStateSnapshotSchema,
} from '@agent/core/state/AgentState';
import { AgentWorkspaceStateSnapshotSchema } from '@agent/core/state/AgentWorkspaceState';
import { ProviderMessageSchema } from '@agent/modelHandlers/types/ProviderMessage';
import { ModelHandlerCompatibilityKeySchema } from '@agent/runtime/modelHandlerCompatibilityKey';
import {
  AgentFileLocationSchema,
  CompileResultSchema,
  RetryErrorInfoSchema,
  RoundOutputSchema,
} from '@shared/schemas';

const RoundContextSchema = z.object({
  messages: z.array(ProviderMessageSchema),
  prefill: z.string(),
  stateRoundSnapshot: ConversationRoundStateSnapshotSchema,
});

export type RoundContext = z.infer<typeof RoundContextSchema>;

export const ReflectionFlowStateSchema = z.object({
  currentRound: z.int().nonnegative(),
  totalRounds: z.int().nonnegative(),

  workspaceSnapshot: AgentWorkspaceStateSnapshotSchema,
  context: RoundContextSchema.nullable(),
  outputLocation: AgentFileLocationSchema.nullable(),

  conversation: z.array(ProviderMessageSchema),
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
});

export type ReflectionFlowState = z.infer<typeof ReflectionFlowStateSchema>;

/** Shared state type for reflection flow nodes. */
export type ReflectionFlowShared = ReflectionFlowState;
