/**
 * Shared state types for reflection flow.
 *
 * Following PocketFlow patterns:
 * - State is mutable and flows through nodes
 * - Services are immutable and injected via _params
 *
 * ## Flow-First Architecture
 *
 * The flow operates independently of the agent:
 * - All services are accessed via this.services (injected)
 * - State flows through nodes via shared.state
 * - No agent reference is needed - all behavior is via strategies
 *
 * The agent's only responsibility is lifecycle (init/finalize) and
 * providing the initial configuration via ReflectionFlowContext.
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
 * Contains:
 * - state: Mutable runtime state
 * - retryState: Retry tracking for error handling
 * - runStage: Parent stage for creating round stages (r0, r1, r2...)
 *
 * ## Flow-First Design
 *
 * No agent reference is included. All services are accessed via this.services
 * (injected via flow.setServices). Polymorphic behavior is captured via
 * strategy objects in ReflectionFlowContext, not via callbacks to agent methods.
 *
 * The agent's responsibility is:
 * 1. Create ReflectionFlowContext with strategies
 * 2. Create the flow and inject services
 * 3. Call flow.run(shared) and handle results
 * 4. Lifecycle (init before flow, finalize after)
 */
export interface ReflectionFlowShared {
  state: ReflectionFlowState;
  retryState: RetryState;
  /** Parent stage for round stages (used to create r0, r1, r2... as siblings) */
  runStage: AgentLogStage;
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
