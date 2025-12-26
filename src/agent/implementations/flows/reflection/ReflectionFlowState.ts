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
import type { AgentLifecycle } from '@agent/implementations/flows/common';
import type { RetryState } from '@agent/core/flows/RetryState';
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
 * Phase definitions for reflection flow lifecycle.
 */
export const REFLECTION_PHASE = {
  IDLE: 'idle',
  INIT: 'init',
  PREPARE_WORKSPACE: 'prepare_workspace',
  PREPARE_CONTEXT: 'prepare_context',
  RESPONSE_CYCLE: 'response_cycle',
  OUTPUT: 'output',
  ROUND_COMPLETE: 'round_complete',
  FINALIZE: 'finalize',
} as const;

export type ReflectionPhase =
  (typeof REFLECTION_PHASE)[keyof typeof REFLECTION_PHASE];

export type ReflectionLifecycle = AgentLifecycle<ReflectionPhase>;

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
}

/**
 * Shared context passed through the flow.
 *
 * Contains:
 * - agent: Reference for lifecycle methods and flow-specific operations
 * - state: Mutable runtime state
 * - lifecycle: Phase/status state machine
 * - retryState: Retry tracking for error handling
 *
 * Note: Work nodes use services from this.services, not agent methods.
 * The agent reference is for lifecycle management and flow-specific operations
 * (like resetPromptBuilder) that are called during initialization.
 */
export interface ReflectionFlowShared {
  /** Agent reference for lifecycle and flow-specific methods */
  agent: IReflectionFlowAgent;
  state: ReflectionFlowState;
  lifecycle: ReflectionLifecycle;
  retryState: RetryState;
}

/**
 * Create initial state for a reflection flow run.
 */
export function createInitialReflectionState(
  totalRounds: number,
  initialWorkspaceState: AgentWorkspaceState,
): ReflectionFlowState {
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
  };
}

// Re-export state classes for convenience
export { AgentRunState, ConversationRoundState };
