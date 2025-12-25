import { z } from 'zod';

// Local imports - core flow primitives
import { BaseNode, Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
// Local imports - agent components
import {
  type AgentRunState,
  AgentRunStateSnapshotSchema,
} from '@agent/core/AgentState';
import {
  type ProviderMessage,
  ProviderMessageSchema,
} from '@agent/modelHandlers/types/ProviderMessage';
import type {
  BaseReflectionAgent,
  ReflectionRoundResult,
} from '@agent/implementations/BaseReflectionAgent';
// Type imports
import type { AgentRunHooks } from '@agent/core/IAgent';
// Internal imports
import {
  createAgentRunFlow,
  createStandardFinalizeNode,
  AgentLifecycle,
  type AgentRunShared,
} from '@agent/implementations/flows/common';

// ============================================================================
// Serialization Schema (formerly in common/runStateSchemas.ts)
// ============================================================================

/** Reflection agent run state schema for serialization. */
export const ReflectionRunStateSchema = z.object({
  runState: AgentRunStateSnapshotSchema,
  conversation: z.array(ProviderMessageSchema),
  totalRounds: z.number().int().nonnegative(),
  currentRound: z.number().int().nonnegative(),
  continueRounds: z.boolean(),
});

export type ReflectionRunStateSnapshot = z.infer<
  typeof ReflectionRunStateSchema
>;

/**
 * Reflection run phase - single source of truth for reflection agent flow phases.
 */
export const REFLECTION_RUN_PHASE = {
  IDLE: 'idle',
  INIT: 'init',
  ROUNDS: 'rounds',
  FINALIZE: 'finalize',
} as const;

export const ReflectionRunPhaseSchema = z.enum([
  REFLECTION_RUN_PHASE.IDLE,
  REFLECTION_RUN_PHASE.INIT,
  REFLECTION_RUN_PHASE.ROUNDS,
  REFLECTION_RUN_PHASE.FINALIZE,
]);

export type ReflectionRunPhase = z.infer<typeof ReflectionRunPhaseSchema>;

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

export interface ReflectionRunHooks extends AgentRunHooks {
  resetPromptBuilder(): void;
}

export type ReflectionRunShared<C = unknown> = AgentRunShared<
  BaseReflectionAgent<C>,
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
interface RoundNodePrepResult<C> {
  agent: BaseReflectionAgent<C>;
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
// Node Implementation
// ============================================================================

class ReflectionRoundNode<C> extends BaseNode<ReflectionRunShared<C>> {
  async prep(shared: ReflectionRunShared<C>): Promise<RoundNodePrepResult<C>> {
    const { agent, state } = shared;
    const shouldFinalize =
      state.currentRound >= state.totalRounds ||
      (state.currentRound > 0 && !state.continueRounds) ||
      agent.isInterruptionRequested();

    return {
      agent,
      state,
      shouldFinalize,
      roundIndex: state.currentRound,
    };
  }

  async exec(prepRes: RoundNodePrepResult<C>): Promise<RoundExecResult> {
    // Early exit if should finalize
    if (prepRes.shouldFinalize) {
      return { kind: 'finalize' };
    }

    try {
      // Initialize agent's round context
      prepRes.agent.beginRound(
        prepRes.roundIndex,
        prepRes.state.runState,
        prepRes.state.conversation,
      );

      // Execute the round using agent's internal context
      const result = await prepRes.agent.executeCurrentRound();

      return { kind: 'success', result };
    } catch (error) {
      const contextualError =
        error instanceof Error
          ? new Error(`Round ${prepRes.roundIndex} failed: ${error.message}`, {
              cause: error,
            })
          : new Error(`Round ${prepRes.roundIndex} failed: ${String(error)}`);
      return { kind: 'error', error: contextualError };
    }
  }

  async post(
    shared: ReflectionRunShared<C>,
    _prepRes: RoundNodePrepResult<C>,
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
  const roundNode = new ReflectionRoundNode<C>();
  const finalizeNode = createStandardFinalizeNode<ReflectionRunShared<C>>({
    finalizePhase: 'finalize',
  });

  return createAgentRunFlow<ReflectionRunShared<C>>({
    init: {
      phase: 'init',
      beforeInitialize: (shared) => {
        shared.hooks.resetPromptBuilder();
      },
      onSuccess: (shared) => {
        shared.lifecycle.begin('rounds');
        return FlowTransition.ROUND;
      },
    },
    finalize: finalizeNode,
    links: ({ init }) => [
      { from: init, on: FlowTransition.ROUND, to: roundNode },
      { from: roundNode, on: FlowTransition.CONTINUE, to: roundNode },
      { from: roundNode, on: FlowTransition.FINALIZE },
    ],
  });
}
