// Local imports - core flow primitives
import { BaseNode, Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
// Local imports - agent components
import type { AgentRunState } from '@agent/core/AgentState';
import type {
  BaseReflectionAgent,
  ReflectionRoundResult,
} from '@agent/implementations/BaseReflectionAgent';
// Internal imports
import {
  createAgentRunFlow,
  createAgentFinalizeNode,
  beginLifecyclePhase,
  completeLifecycle,
  failLifecycle,
  type AgentLifecycleState,
  type AgentRunHooks,
  type AgentRunShared,
} from '@agent/implementations/flows/common';

export type ReflectionRunPhase = 'idle' | 'init' | 'rounds' | 'finalize';

export type ReflectionRunLifecycle = AgentLifecycleState<ReflectionRunPhase>;

export interface ReflectionRunState {
  conversation: any[];
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

interface ReflectionRoundPrep<C> {
  agent: BaseReflectionAgent<C>;
  state: ReflectionRunState;
  shouldFinalize: boolean;
  roundIndex: number;
}

interface ReflectionRoundExec<C> extends ReflectionRoundPrep<C> {
  result?: ReflectionRoundResult;
  error?: unknown;
}

class ReflectionRoundNode<C> extends BaseNode<ReflectionRunShared<C>> {
  async prep(shared: ReflectionRunShared<C>): Promise<ReflectionRoundPrep<C>> {
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

  async exec(
    prepRes: ReflectionRoundPrep<C>,
  ): Promise<ReflectionRoundPrep<C> | ReflectionRoundExec<C>> {
    if (prepRes.shouldFinalize) {
      return prepRes;
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

      return {
        ...prepRes,
        result,
      };
    } catch (error) {
      const contextualError =
        error instanceof Error
          ? new Error(`Round ${prepRes.roundIndex} failed: ${error.message}`, {
              cause: error,
            })
          : new Error(`Round ${prepRes.roundIndex} failed: ${String(error)}`);
      return {
        ...prepRes,
        error: contextualError,
      };
    }
  }

  async post(
    shared: ReflectionRunShared<C>,
    prepRes: ReflectionRoundPrep<C>,
    execRes: ReflectionRoundPrep<C> | ReflectionRoundExec<C>,
  ): Promise<string | undefined> {
    if (prepRes.shouldFinalize) {
      return FlowTransition.FINALIZE;
    }

    const execResult = execRes as ReflectionRoundExec<C>;

    if (execResult.error) {
      failLifecycle(shared.lifecycle, execResult.error);
      return FlowTransition.FINALIZE;
    }

    const { result } = execResult;
    if (!result) {
      const missingResultError = new Error('Round result is missing.');
      failLifecycle(shared.lifecycle, missingResultError);
      return FlowTransition.FINALIZE;
    }

    // Record round result through agent API instead of direct mutation
    shared.agent.recordRoundResult(result);

    // Update flow state
    shared.state.runState = result.runState;
    // Direct reference - messages aren't mutated by subsequent operations
    shared.state.conversation = result.messages;
    shared.state.continueRounds = result.shouldContinue;
    shared.state.currentRound += 1;
    shared.state.runState.incrementRounds();

    if (shared.agent.isInterruptionRequested()) {
      return FlowTransition.FINALIZE;
    }

    if (shared.state.currentRound >= shared.state.totalRounds) {
      return FlowTransition.FINALIZE;
    }

    if (!shared.state.continueRounds) {
      return FlowTransition.FINALIZE;
    }

    return FlowTransition.CONTINUE;
  }
}

export function createReflectionRunFlow<C>(): Flow<ReflectionRunShared<C>> {
  const roundNode = new ReflectionRoundNode<C>();
  const finalizeNode = createAgentFinalizeNode<
    ReflectionRunShared<C>,
    'error' | 'stopped'
  >({
    finalizePhase: 'finalize',
    computeStatus: ({ lifecycle }) => (lifecycle.error ? 'error' : 'stopped'),
    runFinalize: async ({ hooks }, status) => {
      await hooks.end(status);
    },
    runCleanup: async ({ hooks }) => {
      await hooks.cleanup();
    },
    onSuccess: ({ lifecycle }) => completeLifecycle(lifecycle),
  });

  return createAgentRunFlow<ReflectionRunShared<C>>({
    init: {
      phase: 'init',
      beforeInitialize: (shared) => {
        shared.hooks.resetPromptBuilder();
      },
      onSuccess: (shared) => {
        beginLifecyclePhase(shared.lifecycle, 'rounds');
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
