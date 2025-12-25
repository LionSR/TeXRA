// Local imports - core flow primitives
import { Node, Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
// Local imports - agent components
import type { AgentRunState } from '@agent/core/AgentState';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ReflectionRoundResult } from '@agent/implementations/BaseReflectionAgent';
// Type imports
import type { IFlowAgent } from '@agent/core/IAgent';
// Internal imports
import {
  StandardFinalizeNode,
  StandardInitNode,
  AgentLifecycle,
  type AgentRunShared,
} from '@agent/implementations/flows/common';

// ============================================================================
// Phase Definitions
// ============================================================================

/**
 * Reflection run phase - single source of truth for reflection agent flow phases.
 */
const REFLECTION_RUN_PHASE = {
  IDLE: 'idle',
  INIT: 'init',
  ROUNDS: 'rounds',
  FINALIZE: 'finalize',
} as const;

export type ReflectionRunPhase =
  (typeof REFLECTION_RUN_PHASE)[keyof typeof REFLECTION_RUN_PHASE];

export type ReflectionRunLifecycle = AgentLifecycle<ReflectionRunPhase>;

/**
 * Runtime state for reflection agent runs.
 */
export interface ReflectionRunState {
  conversation: ProviderMessage[];
  runState: AgentRunState;
  totalRounds: number;
  currentRound: number;
  continueRounds: boolean;
}

/**
 * Flow-specific hooks for reflection agent runs.
 *
 * Lifecycle methods (startRun, initRun, endRun, cleanupRun) are on IFlowAgent.
 * Round execution methods are on IReflectionFlowAgent.
 *
 * This interface contains only flow-specific hooks that vary by implementation.
 */
export interface ReflectionRunHooks {
  resetPromptBuilder(): void;
}

/**
 * Interface for agents used by ReflectionRunFlow.
 *
 * This interface captures the minimal contract that reflection flows depend on,
 * decoupling flow implementation from concrete agent classes.
 */
export interface IReflectionFlowAgent extends IFlowAgent {
  /** Initialize context for a new round. */
  beginRound(
    roundIndex: number,
    runState: AgentRunState,
    conversation: ProviderMessage[],
  ): void;

  /** Execute the current round and return results. */
  executeCurrentRound(): Promise<ReflectionRoundResult>;

  /** Record the result of a completed round. */
  recordRoundResult(result: ReflectionRoundResult): void;
}

export type ReflectionRunShared<C = unknown> = AgentRunShared<
  IReflectionFlowAgent,
  ReflectionRunState,
  ReflectionRunLifecycle,
  ReflectionRunHooks
>;

// ============================================================================
// Result Types - Clean discriminated unions following PocketFlow patterns
// ============================================================================

/**
 * Prep result for ReflectionRoundNode.
 */
interface RoundNodePrepResult {
  agent: IReflectionFlowAgent;
  state: ReflectionRunState;
  shouldFinalize: boolean;
  roundIndex: number;
}

/**
 * Result of a single round execution.
 * Uses 'kind' discriminant for clarity (matches ToolUseRunFlow pattern).
 */
type RoundExecResult =
  | { kind: 'finalize' }
  | { kind: 'success'; result: ReflectionRoundResult }
  | { kind: 'error'; error: unknown };

// ============================================================================
// Node Implementations
// ============================================================================

/**
 * Initializes the reflection agent run.
 *
 * Extends StandardInitNode to call resetPromptBuilder() before start.
 */
class ReflectionInitNode<C> extends StandardInitNode<ReflectionRunShared<C>> {
  constructor() {
    super('rounds');
  }

  protected override beforeStart(shared: ReflectionRunShared<C>): void {
    shared.hooks.resetPromptBuilder();
  }
}

/**
 * Executes a single reflection round.
 *
 * Phase ownership: None (stays in 'rounds' phase set by InitNode.post())
 * Note: StandardFinalizeNode sets 'finalize' phase.
 *
 * Uses PocketFlow's native error handling:
 * - exec(): Let errors throw naturally (no try/catch)
 * - execFallback(): Wrap error with round context for post()
 * - Node with maxRetries=1: No retry, just fallback on error
 */
class ReflectionRoundNode<C> extends Node<ReflectionRunShared<C>> {
  constructor() {
    super(1, 0); // maxRetries=1 (no retry), wait=0
  }

  async prep(shared: ReflectionRunShared<C>): Promise<RoundNodePrepResult> {
    const { agent, state } = shared;
    const shouldFinalize =
      state.currentRound >= state.totalRounds ||
      (state.currentRound > 0 && !state.continueRounds) ||
      agent.isInterruptionRequested();

    // Initialize round context in prep() where state setup belongs (PocketFlow compliance)
    // This must happen before exec() since executeCurrentRound() depends on the context
    if (!shouldFinalize) {
      agent.beginRound(state.currentRound, state.runState, state.conversation);
    }

    return {
      agent,
      state,
      shouldFinalize,
      roundIndex: state.currentRound,
    };
  }

  async exec(
    prepRes: RoundNodePrepResult,
  ): Promise<
    { kind: 'finalize' } | { kind: 'success'; result: ReflectionRoundResult }
  > {
    // Early exit if should finalize
    if (prepRes.shouldFinalize) {
      return { kind: 'finalize' };
    }

    // Let errors throw - Node._exec catches them and calls execFallback
    // Round context was initialized in prep()
    const result = await prepRes.agent.executeCurrentRound();

    return { kind: 'success', result };
  }

  async execFallback(
    prepRes: RoundNodePrepResult,
    error: Error,
  ): Promise<{ kind: 'error'; error: unknown }> {
    // Wrap error with round context
    const contextualError = new Error(
      `Round ${prepRes.roundIndex} failed: ${error.message}`,
      { cause: error },
    );
    return { kind: 'error', error: contextualError };
  }

  async post(
    shared: ReflectionRunShared<C>,
    _prepRes: RoundNodePrepResult,
    execRes: RoundExecResult,
  ): Promise<string | undefined> {
    switch (execRes.kind) {
      case 'finalize':
        return FlowTransition.FINALIZE;

      case 'error':
        shared.lifecycle.fail(execRes.error);
        return FlowTransition.FINALIZE;

      case 'success': {
        const { result } = execRes;

        // Record round result through agent API
        shared.agent.recordRoundResult(result);

        // Update flow state
        shared.state.runState = result.runState;
        shared.state.conversation = result.messages;
        shared.state.continueRounds = result.shouldContinue;
        shared.state.currentRound += 1;
        shared.state.runState.incrementRounds();

        // Check termination conditions
        if (
          shared.agent.isInterruptionRequested() ||
          shared.state.currentRound >= shared.state.totalRounds ||
          !shared.state.continueRounds
        ) {
          return FlowTransition.FINALIZE;
        }

        return FlowTransition.CONTINUE;
      }
    }
  }
}

export function createReflectionRunFlow<C>(): Flow<ReflectionRunShared<C>> {
  // Create all nodes
  const initNode = new ReflectionInitNode<C>();
  const roundNode = new ReflectionRoundNode<C>();
  const finalizeNode = new StandardFinalizeNode<ReflectionRunShared<C>>(
    'finalize',
  );

  // Wire using native PocketFlow API
  // Linear flow (happy path): init → round
  initNode.next(roundNode);

  // Branches: loop → roundNode, error/end → finalize
  initNode.on(FlowTransition.FINALIZE, finalizeNode);
  roundNode.on(FlowTransition.CONTINUE, roundNode);
  roundNode.on(FlowTransition.FINALIZE, finalizeNode);

  return new Flow<ReflectionRunShared<C>>(initNode);
}
