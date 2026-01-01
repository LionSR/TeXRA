/**
 * Shared state types for reflection flow.
 *
 * ## Architecture: Live State with Serialization Hooks
 *
 * This module defines shared state that nodes work with directly using class instances.
 * Serialization to/from JSON happens ONLY at persistence boundaries via SerializationHooks.
 *
 * **Before (snapshot pattern - removed):**
 * ```typescript
 * // 1. Reconstruct instance from snapshot
 * const workspace = getWorkspaceState(shared);
 * // 2. Mutate
 * workspace.media.addMediaFiles(files);
 * // 3. Store snapshot back (easy to forget!)
 * updateWorkspaceSnapshot(shared, workspace);
 * ```
 *
 * **After (live instance pattern):**
 * ```typescript
 * // Just mutate directly - serialization hooks handle persistence
 * shared.workspace.media.addMediaFiles(files);
 * ```
 *
 * ## Key Components
 *
 * - **ReflectionFlowShared**: Live state with class instances (workspace, run)
 * - **reflectionFlowSerializationHooks**: Converts instances ↔ snapshots at persistence
 * - **RoundContext**: Per-round context (messages, prefill, round state snapshot)
 */

import { z } from 'zod';

import type { RoundOutput } from '@agent/output';
import { RoundOutputSchema } from '@agent/output';
import {
  AgentRunState,
  AgentRunStateSnapshotSchema,
  ConversationRoundState,
  ConversationRoundStateSnapshotSchema,
  type AgentRunStateSnapshot,
  type ConversationRoundStateSnapshot,
} from '@agent/core/AgentState';
import {
  AgentWorkspaceState,
  AgentWorkspaceStateSnapshotSchema,
  type AgentWorkspaceSnapshot,
} from '@agent/core/AgentWorkspaceState';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import { ProviderMessageSchema } from '@agent/modelHandlers/types/ProviderMessage';
import type { RetryErrorInfo } from '@agent/core/flows/RetryState';
import { RetryErrorInfoSchema } from '@agent/core/flows/RetryState';
import type { SerializationHooks } from '@agent/node/persisted-flow';
import type { AgentFileLocation } from '@utils/files';
import { AgentFileLocationSchema } from '@utils/files';

// ============================================================================
// Round Context (per-round prepared data)
// ============================================================================

/**
 * Schema for round context (natively serializable).
 * stateRoundSnapshot remains a snapshot since it's only used for recording.
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

// ============================================================================
// Live State Type (with class instances)
// ============================================================================

/**
 * Live state for reflection flow execution.
 *
 * This is the RUNTIME representation that nodes work with directly.
 * Contains class instances (AgentWorkspaceState, AgentRunState) for direct mutation.
 *
 * ## Key Difference from Previous Pattern
 *
 * - `workspace`: AgentWorkspaceState instance (NOT snapshot)
 * - `run`: AgentRunState instance (NOT snapshot)
 *
 * Nodes mutate these directly. Serialization to snapshots happens ONLY
 * when PersistedFlow persists state, via reflectionFlowSerializationHooks.
 */
export interface ReflectionFlowShared {
  // Index signature required to satisfy RoundAwareState constraint
  [key: string]: unknown;

  // Round tracking
  currentRound: number;
  totalRounds: number;

  // Per-round state (CLASS INSTANCES for direct mutation)
  /** Workspace state - mutate directly, no need for helper functions */
  workspace: AgentWorkspaceState;
  /** Run state - mutate directly, no need for helper functions */
  run: AgentRunState;

  /** Round context prepared for current round */
  context: RoundContext | null;
  /** Output location for current round */
  outputLocation: AgentFileLocation | null;

  // Accumulated state
  conversation: ProviderMessage[];

  // Results (natively serializable - these are just data)
  roundStateSnapshots: ConversationRoundStateSnapshot[];
  roundOutputs: RoundOutput[];

  // Control flags
  continueRounds: boolean;
  endTurn: boolean;

  // Retry state
  lastRetryError?: RetryErrorInfo;
}

// ============================================================================
// Serialization Hooks
// ============================================================================

/**
 * Schema for serialized state (what gets persisted).
 * Uses snapshots instead of class instances.
 */
export const ReflectionFlowSerializedStateSchema = z.object({
  currentRound: z.number(),
  totalRounds: z.number(),
  workspaceSnapshot: AgentWorkspaceStateSnapshotSchema,
  runStateSnapshot: AgentRunStateSnapshotSchema,
  context: RoundContextSchema.nullable(),
  outputLocation: AgentFileLocationSchema.nullable(),
  conversation: z.array(ProviderMessageSchema),
  roundStateSnapshots: z.array(ConversationRoundStateSnapshotSchema),
  roundOutputs: z.array(RoundOutputSchema),
  continueRounds: z.boolean(),
  endTurn: z.boolean(),
  lastRetryError: RetryErrorInfoSchema.optional(),
});

/** Serialized format for persistence */
type ReflectionFlowSerializedState = z.infer<
  typeof ReflectionFlowSerializedStateSchema
>;

/**
 * Serialization hooks for ReflectionFlowShared.
 *
 * Converts between live state (with class instances) and serialized state
 * (with plain JSON snapshots) at persistence boundaries.
 *
 * This is the SINGLE point where serialization happens, eliminating
 * the need for nodes to call getWorkspaceState/updateWorkspaceSnapshot.
 */
export const reflectionFlowSerializationHooks: SerializationHooks<ReflectionFlowShared> =
  {
    serialize: (
      shared: ReflectionFlowShared,
    ): Record<string, unknown> => ({
      currentRound: shared.currentRound,
      totalRounds: shared.totalRounds,
      workspaceSnapshot: shared.workspace.toSnapshot(),
      runStateSnapshot: shared.run.toSnapshot(),
      context: shared.context,
      outputLocation: shared.outputLocation,
      conversation: shared.conversation,
      roundStateSnapshots: shared.roundStateSnapshots,
      roundOutputs: shared.roundOutputs,
      continueRounds: shared.continueRounds,
      endTurn: shared.endTurn,
      lastRetryError: shared.lastRetryError,
    }),

    deserialize: (data: Record<string, unknown>): ReflectionFlowShared => {
      const serialized = data as ReflectionFlowSerializedState;
      return {
        currentRound: serialized.currentRound,
        totalRounds: serialized.totalRounds,
        workspace: AgentWorkspaceState.fromSnapshot(
          serialized.workspaceSnapshot,
        ),
        run: AgentRunState.fromSnapshot(serialized.runStateSnapshot),
        context: serialized.context,
        outputLocation: serialized.outputLocation,
        conversation: serialized.conversation,
        roundStateSnapshots: serialized.roundStateSnapshots,
        roundOutputs: serialized.roundOutputs,
        continueRounds: serialized.continueRounds,
        endTurn: serialized.endTurn,
        lastRetryError: serialized.lastRetryError,
      };
    },
  };

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create initial live state for a reflection flow run.
 *
 * @param totalRounds - Total rounds to execute
 * @param initialWorkspace - Initial workspace state (instance or snapshot)
 */
export function createInitialReflectionState(
  totalRounds: number,
  initialWorkspace?: AgentWorkspaceState | AgentWorkspaceSnapshot,
): ReflectionFlowShared {
  // Handle both instance and snapshot inputs for backward compatibility
  const workspace =
    initialWorkspace instanceof AgentWorkspaceState
      ? initialWorkspace
      : initialWorkspace
        ? AgentWorkspaceState.fromSnapshot(initialWorkspace)
        : AgentWorkspaceState.create();

  return {
    currentRound: 0,
    totalRounds,
    workspace,
    run: new AgentRunState(),
    context: null,
    outputLocation: null,
    conversation: [],
    roundStateSnapshots: [],
    roundOutputs: [],
    continueRounds: true,
    endTurn: false,
  };
}

/**
 * Create a fresh workspace for a new round.
 * Used by RoundPersistedFlow's resetForNextRound hook.
 */
export function createFreshWorkspace(): AgentWorkspaceState {
  return AgentWorkspaceState.create();
}

// ============================================================================
// Legacy Compatibility
// ============================================================================

/**
 * @deprecated Use createFreshWorkspace() instead.
 * Kept for backward compatibility with existing code.
 */
export function createFreshWorkspaceSnapshot(): AgentWorkspaceSnapshot {
  return AgentWorkspaceState.create().toSnapshot();
}

/**
 * @deprecated Access shared.workspace directly instead.
 * This returns the live instance - no reconstruction needed.
 */
export function getWorkspaceState(
  shared: ReflectionFlowShared,
): AgentWorkspaceState {
  return shared.workspace;
}

/**
 * @deprecated No-op: workspace is now a live instance.
 * Mutations persist automatically via serialization hooks.
 */
export function updateWorkspaceSnapshot(
  _shared: ReflectionFlowShared,
  _workspaceState: AgentWorkspaceState,
): void {
  // No-op: workspace is now a live instance
}

/**
 * @deprecated Access shared.run directly instead.
 * This returns the live instance - no reconstruction needed.
 */
export function getRunState(shared: ReflectionFlowShared): AgentRunState {
  return shared.run;
}

/**
 * @deprecated No-op: run is now a live instance.
 * Mutations persist automatically via serialization hooks.
 */
export function updateRunStateSnapshot(
  _shared: ReflectionFlowShared,
  _runState: AgentRunState,
): void {
  // No-op: run is now a live instance
}
