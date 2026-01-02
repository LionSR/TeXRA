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
 * Reconstruct AgentWorkspaceState from snapshot for mutation.
 *
 * ## When to use this helper vs direct access
 *
 * - **Use this helper** when you need to mutate workspace state (e.g., adding media files,
 *   modifying workspace data). The reconstructed class instance provides methods for
 *   manipulation.
 * - **Use direct access** (`shared.workspaceSnapshot`) when you only need to read
 *   immutable snapshot data or pass the snapshot to other functions.
 *
 * ## Pattern: Reconstruct → Mutate → Update Snapshot
 *
 * This helper is step 1 of the standard mutation pattern:
 *
 * ```typescript
 * // 1. Reconstruct class instance from snapshot
 * const workspaceState = getWorkspaceState(shared);
 *
 * // 2. Mutate the instance (e.g., in latexMediaManager.processInputFiles)
 * await latexMediaManager.processInputFiles(files, workspaceState, ...);
 *
 * // 3. Update snapshot to persist changes
 * updateWorkspaceSnapshot(shared, workspaceState);
 * ```
 *
 * ## Why these helpers exist
 *
 * Following the koala-code-reader pattern, shared state stores **snapshots** (plain JSON)
 * instead of class instances to ensure `structuredClone()` works correctly in PersistedFlow.
 * These helpers maintain snapshot consistency while allowing nodes to work with rich
 * class instances that provide mutation methods.
 *
 * @param shared - The reflection flow shared state containing the workspace snapshot
 * @returns Reconstructed AgentWorkspaceState instance with mutation methods
 *
 * @example
 * // In MediaPreparationNode.prep()
 * const workspaceState = getWorkspaceState(shared);
 * // ... pass to latexMediaManager for mutation ...
 * // ... in post(), call updateWorkspaceSnapshot() to persist changes
 */
export function getWorkspaceState(
  shared: ReflectionFlowShared,
): AgentWorkspaceState {
  return AgentWorkspaceState.fromSnapshot(shared.workspaceSnapshot);
}

/**
 * Update workspace snapshot after mutation to persist changes.
 *
 * This is step 3 of the standard mutation pattern - call this after modifying
 * a workspace state instance to save changes back to the shared state snapshot.
 *
 * ## Pattern: Reconstruct → Mutate → Update Snapshot
 *
 * ```typescript
 * // 1. Reconstruct
 * const workspaceState = getWorkspaceState(shared);
 *
 * // 2. Mutate (e.g., adding media files)
 * await latexMediaManager.processInputFiles(files, workspaceState, ...);
 *
 * // 3. Update snapshot (THIS FUNCTION)
 * updateWorkspaceSnapshot(shared, workspaceState);
 * ```
 *
 * **CRITICAL**: Always call this after mutations or changes will be lost.
 * The snapshot is what gets persisted and restored across flow executions.
 *
 * @param shared - The reflection flow shared state to update
 * @param workspaceState - The mutated workspace state instance
 *
 * @example
 * // In MediaPreparationNode.post() - CRITICAL step
 * updateWorkspaceSnapshot(shared, prepRes.workspaceState);
 */
export function updateWorkspaceSnapshot(
  shared: ReflectionFlowShared,
  workspaceState: AgentWorkspaceState,
): void {
  shared.workspaceSnapshot = workspaceState.toSnapshot();
}

/**
 * Create fresh workspace snapshot for a new round.
 *
 * Used when transitioning between rounds to reset workspace state.
 * Each round starts with a clean workspace to avoid state pollution.
 *
 * @returns Fresh AgentWorkspaceSnapshot for a new round
 *
 * @example
 * // In RoundCompleteNode.post() - transitioning to next round
 * shared.workspaceSnapshot = createFreshWorkspaceSnapshot();
 */
export function createFreshWorkspaceSnapshot(): AgentWorkspaceSnapshot {
  return AgentWorkspaceState.create().toSnapshot();
}
