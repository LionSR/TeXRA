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
  ConversationRoundState,
  ConversationRoundStateSnapshotSchema,
  type AgentRunStateSnapshot,
  type ConversationRoundStateSnapshot,
} from '@agent/core/AgentState';
import {
  AgentWorkspaceStateSnapshotSchema,
  type AgentWorkspaceSnapshot,
} from '@agent/core/AgentWorkspaceState';
import { ProviderMessageSchema } from '@agent/modelHandlers/types/ProviderMessage';
import {
  CycleFieldsSchema,
  type CycleTransientFields,
} from '@agent/core/flows/ResponseCycleFlow';

/** Natively serializable context prepared for a round (snapshots, not class instances). */
const RoundContextSchema = z.object({
  messages: z.array(ProviderMessageSchema),
  prefill: z.string(),
  stateRoundSnapshot: ConversationRoundStateSnapshotSchema,
});

export type RoundContext = z.infer<typeof RoundContextSchema>;

/**
 * Optional cycle fields for native nesting. Omits endTurn and outputLocation because
 * they have different semantics at reflection vs cycle level (required vs optional,
 * nullable vs enforced). The base schema defines these directly.
 */
const OptionalCycleFieldsSchema = CycleFieldsSchema.partial().omit({
  endTurn: true,
  outputLocation: true,
});

/**
 * Shared state for reflection flow (flat structure).
 *
 * Uses snapshots (not class instances) for all complex state objects to ensure
 * structuredClone() works. Nodes reconstruct classes from snapshots when needed.
 *
 * Includes optional cycle fields for native nesting - see CycleFieldsSchema for details.
 */
export const ReflectionFlowStateSchema = z
  .object({
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

    // Note: lastError is inherited from OptionalCycleFieldsSchema (via BaseCycleFieldsSchema).
    // Used to distinguish failure from cancellation during resume.
  })
  .extend(OptionalCycleFieldsSchema.shape);

export type ReflectionFlowState = z.infer<typeof ReflectionFlowStateSchema>;

/**
 * Combines serializable state with transient cycle fields for native flow nesting.
 * Serializable fields are persisted; transient fields are cleared between checkpoints.
 */
export type ReflectionFlowShared = ReflectionFlowState & CycleTransientFields;
