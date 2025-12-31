/**
 * Shared state types for reflection flow.
 *
 * ## Following koala-code-reader's Pattern
 *
 * Shared state contains ONLY natively serializable data (plain JSON):
 * - Use snapshots instead of class instances
 * - No runtime dependencies (those go in services)
 * - No functions or callbacks
 *
 * This ensures clean serialization via structuredClone() in PersistedFlow.
 *
 * ## Architecture
 *
 * - **shared**: Mutable, natively serializable state (survives structuredClone)
 * - **services**: Runtime dependencies (logger, model handler, runStage, etc.)
 * - **params**: Immutable flow configuration
 */

import type { RoundOutput } from '@agent/output';
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
import type { RetryState } from '@agent/core/flows/RetryState';
import type { AgentFileLocation } from '@utils/files';

/**
 * Natively serializable context prepared for a round.
 *
 * Following koala-code-reader pattern:
 * - stateRoundSnapshot is a plain JSON snapshot (not class instance)
 * - Nodes reconstruct ConversationRoundState when needed for mutation
 * - This ensures structuredClone() works correctly in PersistedFlow
 */
export interface RoundContext {
  /** Prepared messages for the model */
  messages: ProviderMessage[];
  /** Prefill text for assistant response */
  prefill: string;
  /** Round state snapshot (natively serializable) */
  stateRoundSnapshot: ConversationRoundStateSnapshot;
}

/**
 * Mutable state for reflection flow.
 *
 * This flows through all nodes and gets updated in post() methods.
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
export interface ReflectionFlowState {
  // Round tracking
  currentRound: number;
  totalRounds: number;

  // Per-round state (natively serializable)
  workspaceSnapshot: AgentWorkspaceSnapshot;
  context: RoundContext | null;
  outputLocation: AgentFileLocation | null;

  // Accumulated state (natively serializable)
  conversation: ProviderMessage[];
  runStateSnapshot: AgentRunStateSnapshot;

  // Results (natively serializable)
  roundStateSnapshots: ConversationRoundStateSnapshot[];
  roundOutputs: RoundOutput[];

  // Control flags
  continueRounds: boolean;
  endTurn: boolean;
}

/**
 * Shared context passed through the flow.
 *
 * Following koala-code-reader's pattern:
 * - Contains ONLY natively serializable data (plain JSON)
 * - Runtime dependencies like `runStage` are in services, not here
 * - All fields survive structuredClone() without special handling
 */
export interface ReflectionFlowShared {
  state: ReflectionFlowState;
  retryState: RetryState;
  /** Index signature for PersistedFlow serialization compatibility */
  [key: string]: unknown;
}

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
  return AgentWorkspaceState.fromSnapshot(shared.state.workspaceSnapshot);
}

/**
 * Update workspace snapshot after mutation.
 * Call this after modifying the workspace state.
 */
export function updateWorkspaceSnapshot(
  shared: ReflectionFlowShared,
  workspaceState: AgentWorkspaceState,
): void {
  shared.state.workspaceSnapshot = workspaceState.toSnapshot();
}

/**
 * Reconstruct AgentRunState from snapshot.
 * Use this when nodes need to access or mutate run state.
 */
export function getRunState(shared: ReflectionFlowShared): AgentRunState {
  return AgentRunState.fromSnapshot(shared.state.runStateSnapshot);
}

/**
 * Update run state snapshot after mutation.
 * Call this after modifying the run state.
 */
export function updateRunStateSnapshot(
  shared: ReflectionFlowShared,
  runState: AgentRunState,
): void {
  shared.state.runStateSnapshot = runState.toSnapshot();
}

/**
 * Create fresh workspace snapshot for a new round.
 */
export function createFreshWorkspaceSnapshot(): AgentWorkspaceSnapshot {
  return AgentWorkspaceState.create().toSnapshot();
}

// Re-export state classes and schemas for convenience
export {
  AgentRunState,
  AgentRunStateSnapshotSchema,
  ConversationRoundState,
  ConversationRoundStateSnapshotSchema,
  AgentWorkspaceState,
  AgentWorkspaceStateSnapshotSchema,
};

// Re-export snapshot types
export type { AgentRunStateSnapshot, ConversationRoundStateSnapshot };
