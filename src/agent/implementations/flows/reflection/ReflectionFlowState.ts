/**
 * Shared state types for reflection flow.
 *
 * Following PocketFlow patterns:
 * - State is mutable and flows through nodes
 * - Services are immutable and injected via _params
 *
 * Note: We keep an agent reference for lifecycle methods (startRun, endRun, etc.)
 * but work nodes use services from _params, not agent methods.
 */

import type { RoundOutput } from '@agent/output';
import { AgentRunState, ConversationRoundState } from '@agent/core/AgentState';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { IFlowAgent } from '@agent/core/IAgent';
import type { RetryState } from '@agent/core/flows/RetryState';
import type { AgentLogStage } from '@logger/AgentLogger';
import type { AgentFileLocation } from '@utils/files';

// ============================================================================
// Agent Interface
// ============================================================================

/**
 * Interface for agents used by ReflectionFlow.
 *
 * Extends IFlowAgent with reflection-specific methods.
 * This mirrors the pattern used by ToolUseFlow (IToolUseFlowAgent).
 */
export interface IReflectionFlowAgent extends IFlowAgent {
  /** Reset prompt builder before starting rounds. */
  resetPromptBuilder(): void;
}

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
 * - agent: Reference for flow-specific operations
 * - state: Mutable runtime state
 * - retryState: Retry tracking for error handling
 * - runStage: Parent stage for creating round stages (r0, r1, r2...)
 *
 * Note: Agent owns lifecycle (init/finalize in agent.run() try/finally).
 * Work nodes use services from this.services, throw errors on failure.
 * The agent reference is for flow-specific operations only.
 */
export interface ReflectionFlowShared {
  /** Agent reference for flow-specific methods */
  agent: IReflectionFlowAgent;
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
 * @param hydratedOutputs - Optional pre-hydrated round outputs from resume (for latexdiff)
 */
export function createInitialReflectionState(
  totalRounds: number,
  initialWorkspaceState: AgentWorkspaceState,
  hydratedOutputs?: RoundOutput[],
): ReflectionFlowState {
  // Always start from round 0, even on resume.
  // Completed rounds are "replayed" - their output files already exist,
  // so initializeOutputAndPrefill() will read them instead of calling the model.
  // This ensures conversation is built correctly through the normal flow.
  return {
    currentRound: 0,
    totalRounds,
    workspaceState: initialWorkspaceState,
    context: null,
    outputLocation: null,
    conversation: [],
    runState: new AgentRunState(),
    roundStates: [],
    roundOutputs: hydratedOutputs ? [...hydratedOutputs] : [],
    continueRounds: true,
    endTurn: false,
    roundStage: null, // Set by agent.run() before flow starts
  };
}

// Re-export state classes for convenience
export { AgentRunState, ConversationRoundState };
