// Local imports - core flow primitives
import { BaseNode, Flow } from '@agent/node';

// Local imports - flow constants
import { FlowTransition } from '@agent/core/flows/FlowTransitions';

// Local imports - agent components
import type { AgentRunState } from '@agent/core/AgentState';
import type {
  BaseReflectionAgent,
  ReflectionRoundContext,
  ReflectionRoundResult,
} from '../BaseReflectionAgent';
import { AgentInitNode } from '@agent/implementations/flows/common/AgentInitNode';
import type { AgentRunShared } from '@agent/implementations/flows/common/types';
import {
  beginLifecyclePhase,
  completeLifecycle,
  failLifecycle,
  setLifecyclePhase,
} from '@agent/implementations/flows/common/lifecycle';

type RunPhase = 'idle' | 'init' | 'rounds' | 'finalize';
type RunStatus = 'pending' | 'running' | 'error' | 'completed';

export interface ReflectionRunLifecycle {
  phase: RunPhase;
  status: RunStatus;
  error?: unknown;
}

export interface ReflectionRunHooks {
  start(): Promise<string>;
  init(runGroupId: string): Promise<void>;
  resetPromptBuilder(): void;
  initializeClient(): Promise<void>;
  end(status: 'stopped' | 'error'): void | Promise<void>;
  cleanup(): void | Promise<void>;
}

export interface ReflectionRunState {
  totalRounds: number;
  currentRound: number;
  continueRounds: boolean;
  messages: any[];
  globalState: AgentRunState;
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
  messages: any[];
  globalState: AgentRunState;
}

interface ReflectionRoundExec<C> extends ReflectionRoundPrep<C> {
  result?: ReflectionRoundResult;
  error?: unknown;
}

interface ReflectionFinalizePrep {
  hooks: ReflectionRunHooks;
  lifecycle: ReflectionRunLifecycle;
}

interface ReflectionFinalizeExec {
  endError?: unknown;
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
      messages: state.messages,
      globalState: state.globalState,
    };
  }

  async exec(
    prepRes: ReflectionRoundPrep<C>,
  ): Promise<ReflectionRoundPrep<C> | ReflectionRoundExec<C>> {
    if (prepRes.shouldFinalize) {
      return prepRes;
    }

    try {
      prepRes.agent.setCurrentRound(prepRes.roundIndex);
      const result = await prepRes.agent.runReflectionRound({
        roundIndex: prepRes.roundIndex,
        globalState: prepRes.state.globalState,
        messages: prepRes.state.messages,
      } satisfies ReflectionRoundContext);

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

    shared.agent.roundStates.push(result.roundState);
    shared.agent.toolStates.push(result.toolState);
    if (result.outputArtifacts) {
      shared.agent.roundOutputArtifacts[result.outputArtifacts.round] =
        result.outputArtifacts;
    }
    shared.state.globalState = result.globalState;
    shared.state.messages = result.messages;
    shared.state.continueRounds = result.shouldContinue;
    shared.state.currentRound += 1;
    shared.state.globalState.incrementRounds();

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

class ReflectionFinalizeNode<C> extends BaseNode<ReflectionRunShared<C>> {
  async prep(shared: ReflectionRunShared<C>): Promise<ReflectionFinalizePrep> {
    setLifecyclePhase(shared.lifecycle, 'finalize');
    return {
      hooks: shared.hooks,
      lifecycle: shared.lifecycle,
    };
  }

  async exec(prepRes: ReflectionFinalizePrep): Promise<ReflectionFinalizeExec> {
    const status = prepRes.lifecycle.error ? 'error' : 'stopped';
    try {
      await Promise.resolve(prepRes.hooks.end(status));
      return {};
    } catch (error) {
      return { endError: error };
    }
  }

  async post(
    shared: ReflectionRunShared<C>,
    prepRes: ReflectionFinalizePrep,
    execRes: ReflectionFinalizeExec,
  ): Promise<string | undefined> {
    let error = shared.lifecycle.error ?? execRes.endError;

    try {
      await Promise.resolve(prepRes.hooks.cleanup());
    } catch (cleanupError) {
      if (!error) {
        error = cleanupError;
      }
    }

    if (error) {
      failLifecycle(shared.lifecycle, error);
    } else {
      completeLifecycle(shared.lifecycle);
    }

    return undefined;
  }
}

export function createReflectionRunFlow<C>(): Flow<ReflectionRunShared<C>> {
  const initNode = new AgentInitNode<ReflectionRunShared<C>>({
    phase: 'init',
    beforeInitialize: (shared) => {
      shared.hooks.resetPromptBuilder();
    },
    onSuccess: (shared) => {
      beginLifecyclePhase(shared.lifecycle, 'rounds');
      return FlowTransition.ROUND;
    },
  });
  const roundNode = new ReflectionRoundNode<C>();
  const finalizeNode = new ReflectionFinalizeNode<C>();

  initNode.on(FlowTransition.ROUND, roundNode);
  initNode.on(FlowTransition.FINALIZE, finalizeNode);

  roundNode.on(FlowTransition.CONTINUE, roundNode);
  roundNode.on(FlowTransition.FINALIZE, finalizeNode);

  return new Flow<ReflectionRunShared<C>>(initNode);
}
