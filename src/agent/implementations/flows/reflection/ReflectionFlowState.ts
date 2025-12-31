/**
 * Shared state types for reflection flow.
 *
 * ## Schema-First Pattern
 *
 * Schemas are the single source of truth for data structures:
 * - Define schemas first, then derive TypeScript types using z.infer<>
 * - Enables validation during persistence/restoration
 * - Ensures type safety and DRY code
 *
 * ## Following koala-code-reader's Pattern
 *
 * Shared state is a FLAT structure containing ONLY natively serializable data:
 * - Use snapshots instead of class instances
 * - No runtime dependencies (those go in services)
 * - No functions or callbacks
 * - No nested wrappers (state is accessed directly as shared.X, not shared.state.X)
 *
 * This ensures clean serialization via structuredClone() in PersistedFlow.
 *
 * ## Architecture
 *
 * - **shared**: Mutable, natively serializable state (survives structuredClone)
 * - **services**: Runtime dependencies (logger, model handler, runStage, etc.)
 * - **params**: Immutable flow configuration
 */

import { z } from 'zod';

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
import { ProviderMessageSchema } from '@agent/modelHandlers/types/ProviderMessage';
import { RetryErrorInfoSchema } from '@agent/core/flows/RetryState';
import { AgentFileLocationSchema } from '@utils/files';

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
 * ## Serialization Strategy
 *
 * Following koala-code-reader's pattern, we store **snapshots** for
 * complex state objects instead of class instances:
 * - workspaceSnapshot: AgentWorkspaceSnapshot (not AgentWorkspaceState)
 * - runStateSnapshot: AgentRunStateSnapshot (not AgentRunState)
 * - roundStateSnapshots: ConversationRoundStateSnapshot[] (not class array)
 * - context.stateRoundSnapshot: snapshot, not ConversationRoundState
 *
 * Nodes reconstruct class instances from snapshots when needed, then
 * store snapshots back after mutation. This ensures structuredClone()
 * works without any special handling.
 *
 * ## Runtime-Only Fields
 *
 * - roundStage: Moved to services (ReflectionServices.roundStage)
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

  // Retry state (flattened - was separate RetryState object)
  /** Last error from model invocation, if any. Used to distinguish failure from cancellation. */
  lastRetryError: RetryErrorInfoSchema.optional(),
});

/** Derived type from schema */
export type ReflectionFlowState = z.infer<typeof ReflectionFlowStateSchema>;

/**
 * Shared context passed through the flow.
 *
 * This is now a type alias - ReflectionFlowState IS the shared state.
 * No more nested `shared.state.X` - access directly as `shared.X`.
 */
export type ReflectionFlowShared = ReflectionFlowState;

/**
 * Create initial state for a reflection flow run.
 *
 * @param totalRounds - Total rounds to execute
 * @param initialWorkspaceSnapshot - Initial workspace state snapshot
 */
export function createInitialReflectionState(
  totalRounds: number,
  initialWorkspaceSnapshot: AgentWorkspaceSnapshot,
): ReflectionFlowState {
  return {
    currentRound: 0,
    totalRounds,
    workspaceSnapshot: initialWorkspaceSnapshot,
    context: null,
    outputLocation: null,
    conversation: [],
    runStateSnapshot: new AgentRunState().toSnapshot(),
    roundStateSnapshots: [],
    roundOutputs: [],
    continueRounds: true,
    endTurn: false,
  };
}

// ============================================================================
// Helper Functions for Snapshot Conversion
// ============================================================================

/**
 * Reconstruct AgentWorkspaceState from snapshot.
 * Use this when nodes need to mutate workspace state.
 */
export function getWorkspaceState(
  shared: ReflectionFlowShared,
): AgentWorkspaceState {
  return AgentWorkspaceState.fromSnapshot(shared.workspaceSnapshot);
}

/**
 * Update workspace snapshot after mutation.
 * Call this after modifying the workspace state.
 */
export function updateWorkspaceSnapshot(
  shared: ReflectionFlowShared,
  workspaceState: AgentWorkspaceState,
): void {
  shared.workspaceSnapshot = workspaceState.toSnapshot();
}

/**
 * Reconstruct AgentRunState from snapshot.
 * Use this when nodes need to access or mutate run state.
 */
export function getRunState(shared: ReflectionFlowShared): AgentRunState {
  return AgentRunState.fromSnapshot(shared.runStateSnapshot);
}

/**
 * Update run state snapshot after mutation.
 * Call this after modifying the run state.
 */
export function updateRunStateSnapshot(
  shared: ReflectionFlowShared,
  runState: AgentRunState,
): void {
  shared.runStateSnapshot = runState.toSnapshot();
}

/**
 * Create fresh workspace snapshot for a new round.
 */
export function createFreshWorkspaceSnapshot(): AgentWorkspaceSnapshot {
  return AgentWorkspaceState.create().toSnapshot();
}
