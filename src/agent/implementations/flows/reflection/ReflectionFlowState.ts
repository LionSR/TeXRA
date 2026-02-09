/**
 * Shared state types for reflection flow.
 *
 * Schema-First Pattern: Schemas are the single source of truth - define schemas first,
 * then derive TypeScript types using z.infer<>. Enables validation and DRY code.
 *
 * Flat Structure: Shared state contains only natively serializable data (snapshots not
 * class instances, no functions). Access fields directly as shared.X, not shared.state.X.
 * This ensures clean serialization via structuredClone() in PersistedFlow.
 */

import { z } from 'zod';

import { AgentFileLocationSchema, RoundOutputSchema } from '@shared/schemas';
import {
  AgentRunStateSnapshotSchema,
  ConversationRoundStateSnapshotSchema,
  type AgentRunStateSnapshot,
  type ConversationRoundStateSnapshot,
} from '@agent/core/AgentState';
import {
  AgentWorkspaceStateSnapshotSchema,
  type AgentWorkspaceSnapshot,
} from '@agent/core/AgentWorkspaceState';
import { ProviderMessageSchema } from '@agent/modelHandlers/types/ProviderMessage';
import { RetryErrorInfoSchema } from '@shared/schemas';

/** Natively serializable context prepared for a round (snapshots, not class instances). */
const RoundContextSchema = z.object({
  messages: z.array(ProviderMessageSchema),
  prefill: z.string(),
  stateRoundSnapshot: ConversationRoundStateSnapshotSchema,
});

export type RoundContext = z.infer<typeof RoundContextSchema>;

/**
 * Shared state for reflection flow (flat structure).
 *
 * Uses snapshots (not class instances) for all complex state objects to ensure
 * structuredClone() works. Nodes reconstruct classes from snapshots when needed.
 *
 * Cycle fields are NOT on this type — ResponseCycleNode creates a separate
 * ResponseCycleShared for the cycle flow and syncs results back in post().
 */
export const ReflectionFlowStateSchema = z.object({
  // Round tracking
  currentRound: z.number(),
  totalRounds: z.number(),

  // Per-round state (natively serializable)
  workspaceSnapshot: AgentWorkspaceStateSnapshotSchema,
  context: RoundContextSchema.nullable(),
  outputLocation: AgentFileLocationSchema.nullable(),

  // Accumulated state (natively serializable)
  conversation: z.array(ProviderMessageSchema),
  runStateSnapshot: AgentRunStateSnapshotSchema,

  // Results (natively serializable)
  roundStateSnapshots: z.array(ConversationRoundStateSnapshotSchema),
  roundOutputs: z.array(RoundOutputSchema),

  // Control flags
  continueRounds: z.boolean(),
  endTurn: z.boolean(),

  // Distinguishes failure from cancellation during resume
  lastError: RetryErrorInfoSchema.optional(),
});

export type ReflectionFlowState = z.infer<typeof ReflectionFlowStateSchema>;

/** Shared state type for reflection flow nodes. */
export type ReflectionFlowShared = ReflectionFlowState;
