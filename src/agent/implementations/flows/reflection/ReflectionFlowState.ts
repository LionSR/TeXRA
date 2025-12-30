/**
 * Shared state types for reflection flow.
 *
 * ## Following koala-code-reader's Pattern
 *
 * Shared state contains ONLY serializable data (plain JSON):
 * - No class instances (use snapshots instead)
 * - No runtime dependencies (those go in services)
 * - No functions or callbacks
 *
 * This ensures clean serialization via structuredClone() in PersistedFlow.
 *
 * ## Architecture
 *
 * - **shared**: Mutable, serializable state (survives structuredClone)
 * - **services**: Runtime dependencies (logger, model handler, etc.)
 * - **params**: Immutable flow configuration
 */

import type { RoundOutput } from '@agent/output';
import { AgentRunState, ConversationRoundState } from '@agent/core/AgentState';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { RetryState } from '@agent/core/flows/RetryState';
import type { AgentLogStage } from '@logger/AgentLogger';
import type { AgentFileLocation } from '@utils/files';

/**
 * Context prepared for a round (messages + prefill).
 */
export interface RoundContext {
  /** Prepared messages for the model */
  messages: ProviderMessage[];
  /** Prefill text for assistant response */
  prefill: string;
  /** Round state for tracking */
  stateRound: ConversationRoundState;
}

/**
 * Mutable state for reflection flow.
 *
 * This flows through all nodes and gets updated in post() methods.
 */
export interface ReflectionFlowState {
  // Round tracking
  currentRound: number;
  totalRounds: number;

  // Per-round state (reset each round)
  workspaceState: AgentWorkspaceState;
  context: RoundContext | null;
  outputLocation: AgentFileLocation | null;

  // Accumulated state
  conversation: ProviderMessage[];
  runState: AgentRunState;

  // Results
  roundStates: ConversationRoundState[];
  roundOutputs: RoundOutput[];

  // Control flags
  continueRounds: boolean;
  endTurn: boolean;

  // UI logging - round stage for collapsible groups (r0, r1, r2...)
  roundStage: AgentLogStage | null;
}

/**
 * Shared context passed through the flow.
 *
 * Following koala-code-reader's pattern:
 * - Contains ONLY serializable data (plain JSON)
 * - Runtime dependencies like `runStage` are in services, not here
 * - All fields must survive structuredClone()
 *
 * ## Note on Current Implementation
 *
 * Currently, `state` contains class instances (AgentRunState, etc.) which
 * are converted to plain objects by structuredClone(). This works for
 * persistence but loses class methods. Future refactoring should convert
 * to pure snapshot format (plain data only).
 *
 * TODO: Convert ReflectionFlowState fields to snapshot format:
 * - workspaceState → workspaceSnapshot (via toSnapshot())
 * - runState → runStateSnapshot (via toSnapshot())
 * - roundStates → roundStateSnapshots (via map + toSnapshot())
 */
export interface ReflectionFlowShared {
  state: ReflectionFlowState;
  retryState: RetryState;
  /** Parent stage for round stages - RUNTIME ONLY, not persisted */
  runStage: AgentLogStage;
  /** Index signature for PersistedFlow serialization compatibility */
  [key: string]: unknown;
}

/**
 * Create initial state for a reflection flow run.
 *
 * On resume, we always start from round 0 and "replay" all rounds.
 * Completed rounds are detected by initializeOutputAndPrefill() which
 * checks if output file exists - if so, it reads the existing response
 * instead of calling the model, allowing conversation to build correctly.
 *
 * @param totalRounds - Total rounds to execute
 * @param initialWorkspaceState - Initial workspace state
 */
export function createInitialReflectionState(
  totalRounds: number,
  initialWorkspaceState: AgentWorkspaceState,
): ReflectionFlowState {
  // Always start from round 0, even on resume.
  // Completed rounds are "replayed" - their output files already exist,
  // so initializeOutputAndPrefill() will read them instead of calling the model.
  // This ensures conversation is built correctly through the normal flow.
  // roundOutputs is populated by OutputNode as each round completes.
  return {
    currentRound: 0,
    totalRounds,
    workspaceState: initialWorkspaceState,
    context: null,
    outputLocation: null,
    conversation: [],
    runState: new AgentRunState(),
    roundStates: [],
    roundOutputs: [],
    continueRounds: true,
    endTurn: false,
    roundStage: null, // Set by agent.run() before flow starts
  };
}

// Re-export state classes for convenience
export { AgentRunState, ConversationRoundState };
