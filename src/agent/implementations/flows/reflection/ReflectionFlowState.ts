/**
 * Shared state types for reflection flow.
 *
 * ## Direct State Access (Lazy Persistence Pattern)
 *
 * With lazy persistence mode, shared state stores **class instances** directly:
 * - workspace: AgentWorkspaceState (class instance)
 * - runState: AgentRunState (class instance)
 *
 * Nodes access these directly without reconstruction. Serialization only
 * happens at round boundaries via custom serialization hooks.
 *
 * ## Architecture
 *
 * - **shared**: Mutable state with class instances (serialized at boundaries)
 * - **services**: Runtime dependencies (logger, model handler, runStage, etc.)
 * - **params**: Immutable flow configuration
 */

import { z } from 'zod';

import { RoundOutputSchema, type RoundOutput } from '@agent/output';
import {
  AgentRunState,
  AgentRunStateSnapshotSchema,
  ConversationRoundState,
  ConversationRoundStateSnapshotSchema,
  type ConversationRoundStateSnapshot,
} from '@agent/core/AgentState';
import {
  AgentWorkspaceState,
  AgentWorkspaceStateSnapshotSchema,
} from '@agent/core/AgentWorkspaceState';
import {
  ProviderMessageSchema,
  type ProviderMessage,
} from '@agent/modelHandlers/types/ProviderMessage';
import {
  RetryErrorInfoSchema,
  type RetryErrorInfo,
} from '@agent/core/flows/RetryState';
import {
  AgentFileLocationSchema,
  type AgentFileLocation,
} from '@utils/files';
import type { SerializationHooks } from '@agent/node/persisted-flow';

// ============================================================================
// Schemas (Single Source of Truth)
// ============================================================================

/**
 * Natively serializable context prepared for a round.
 *
 * Following koala-code-reader pattern:
 * - stateRoundSnapshot is a plain JSON snapshot (not class instance)
 * - Nodes reconstruct ConversationRoundState when needed for mutation
 * - This ensures structuredClone() works correctly in PersistedFlow
 */
export const RoundContextSchema = z.object({
  /** Prepared messages for the model */
  messages: z.array(ProviderMessageSchema),
  /** Prefill text for assistant response */
  prefill: z.string(),
  /** Round state snapshot (natively serializable) */
  stateRoundSnapshot: ConversationRoundStateSnapshotSchema,
});

/** Derived type from schema */
export type RoundContext = z.infer<typeof RoundContextSchema>;

/**
 * Shared state for reflection flow (flat structure).
 *
 * This flows through all nodes and gets updated in post() methods.
 * Access fields directly as `shared.currentRound`, not `shared.state.currentRound`.
 *
 * ## Direct State Access (Lazy Persistence Pattern)
 *
 * With lazy persistence mode, we store **class instances** directly:
 * - workspace: AgentWorkspaceState (class instance)
 * - runState: AgentRunState (class instance)
 *
 * Nodes access these directly without reconstruction. Serialization only
 * happens at round boundaries via custom serialization hooks.
 *
 * ## Round Stage Management
 *
 * Round stages (r0, r1, r2...) are managed by RoundPersistedFlow, not by
 * shared state or services. This keeps round lifecycle as a flow-level
 * concern, invisible to individual nodes.
 */
export const ReflectionFlowStateSchema = z.object({
  // Round tracking
  currentRound: z.number(),
  totalRounds: z.number(),

  // Per-round state - workspace uses snapshot schema for persistence validation
  // At runtime, this is AgentWorkspaceState (see ReflectionFlowShared type)
  workspaceSnapshot: AgentWorkspaceStateSnapshotSchema,
  context: RoundContextSchema.nullable(),
  outputLocation: AgentFileLocationSchema.nullable(),

  // Accumulated state - runState uses snapshot schema for persistence validation
  // At runtime, this is AgentRunState (see ReflectionFlowShared type)
  conversation: z.array(ProviderMessageSchema),
  runStateSnapshot: AgentRunStateSnapshotSchema,

  // Results (natively serializable)
  roundStateSnapshots: z.array(ConversationRoundStateSnapshotSchema),
  roundOutputs: z.array(RoundOutputSchema),

  // Control flags
  continueRounds: z.boolean(),
  endTurn: z.boolean(),

  // Retry state (flattened - was separate RetryState object)
  /** Last error from model invocation, if any. Used to distinguish failure from cancellation. */
  lastRetryError: RetryErrorInfoSchema.optional(),
});

/** Schema type for persistence (uses snapshots) */
export type ReflectionFlowStatePersisted = z.infer<
  typeof ReflectionFlowStateSchema
>;

/**
 * Runtime shared state with class instances.
 *
 * At runtime, workspace and runState are class instances for direct access.
 * The schema type uses snapshots for persistence validation only.
 *
 * Extends Record<string, unknown> to satisfy RoundAwareState constraint.
 */
export interface ReflectionFlowShared extends Record<string, unknown> {
  // Round tracking (required by RoundAwareState)
  currentRound: number;
  totalRounds: number;
  continueRounds: boolean;

  // Per-round state - CLASS INSTANCES at runtime
  workspace: AgentWorkspaceState;
  context: RoundContext | null;
  outputLocation: AgentFileLocation | null;

  // Accumulated state - CLASS INSTANCE at runtime
  conversation: ProviderMessage[];
  runState: AgentRunState;

  // Results (natively serializable)
  roundStateSnapshots: ConversationRoundStateSnapshot[];
  roundOutputs: RoundOutput[];

  // Control flags
  endTurn: boolean;

  // Retry state
  lastRetryError?: RetryErrorInfo;
}

/**
 * Create initial state for a reflection flow run.
 *
 * @param totalRounds - Total rounds to execute
 * @param initialWorkspace - Initial workspace state (class instance)
 */
export function createInitialReflectionState(
  totalRounds: number,
  initialWorkspace?: AgentWorkspaceState,
): ReflectionFlowShared {
  return {
    currentRound: 0,
    totalRounds,
    workspace: initialWorkspace ?? AgentWorkspaceState.create(),
    context: null,
    outputLocation: null,
    conversation: [],
    runState: new AgentRunState(),
    roundStateSnapshots: [],
    roundOutputs: [],
    continueRounds: true,
    endTurn: false,
  };
}

// ============================================================================
// Serialization Hooks for Lazy Persistence
// ============================================================================

/**
 * Serialization hooks for ReflectionFlowShared.
 *
 * Converts between runtime state (class instances) and persisted state (snapshots).
 * Used by RoundPersistedFlow at round boundaries.
 */
export const reflectionFlowSerializationHooks: SerializationHooks<ReflectionFlowShared> =
  {
    /**
     * Convert runtime state to persisted format.
     * Class instances → snapshots.
     */
    serialize: (shared: ReflectionFlowShared): Record<string, unknown> => ({
      currentRound: shared.currentRound,
      totalRounds: shared.totalRounds,
      workspaceSnapshot: shared.workspace.toSnapshot(),
      context: shared.context,
      outputLocation: shared.outputLocation,
      conversation: shared.conversation,
      runStateSnapshot: shared.runState.toSnapshot(),
      roundStateSnapshots: shared.roundStateSnapshots,
      roundOutputs: shared.roundOutputs,
      continueRounds: shared.continueRounds,
      endTurn: shared.endTurn,
      lastRetryError: shared.lastRetryError,
    }),

    /**
     * Reconstruct runtime state from persisted format.
     * Snapshots → class instances.
     */
    deserialize: (data: Record<string, unknown>): ReflectionFlowShared => {
      // Validate with schema first
      const parsed = ReflectionFlowStateSchema.parse(data);
      return {
        currentRound: parsed.currentRound,
        totalRounds: parsed.totalRounds,
        workspace: AgentWorkspaceState.fromSnapshot(parsed.workspaceSnapshot),
        context: parsed.context,
        outputLocation: parsed.outputLocation,
        conversation: parsed.conversation,
        runState: AgentRunState.fromSnapshot(parsed.runStateSnapshot),
        roundStateSnapshots: parsed.roundStateSnapshots,
        roundOutputs: parsed.roundOutputs,
        continueRounds: parsed.continueRounds,
        endTurn: parsed.endTurn,
        lastRetryError: parsed.lastRetryError,
      };
    },
  };

/**
 * Reset workspace for a new round.
 * Used by RoundPersistedFlow lifecycle hooks.
 */
export function resetWorkspaceForNextRound(shared: ReflectionFlowShared): void {
  shared.workspace = AgentWorkspaceState.create();
}
