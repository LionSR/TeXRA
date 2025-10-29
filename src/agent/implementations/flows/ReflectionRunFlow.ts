// Local imports - core flow primitives
import { BaseNode, Flow } from '@agent/node';

// Local imports - agent components
import type { AgentStateGlobal } from '@agent/core/AgentState';
import type {
  BaseReflectionAgent,
  ReflectionRoundContext,
  ReflectionRoundResult,
} from '../BaseReflectionAgent';

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
  globalState: AgentStateGlobal;
}

export interface ReflectionRunShared<C = unknown> {
  agent: BaseReflectionAgent<C>;
  state: ReflectionRunState;
  lifecycle: ReflectionRunLifecycle;
  hooks: ReflectionRunHooks;
}

interface ReflectionInitPrep<C> {
  agent: BaseReflectionAgent<C>;
  hooks: ReflectionRunHooks;
  lifecycle: ReflectionRunLifecycle;
}

interface ReflectionInitExec {
  error?: unknown;
}

interface ReflectionRoundPrep<C> {
  agent: BaseReflectionAgent<C>;
  state: ReflectionRunState;
  shouldFinalize: boolean;
  roundIndex: number;
  messages: any[];
  globalState: AgentStateGlobal;
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

class ReflectionInitNode<C> extends BaseNode<ReflectionRunShared<C>> {
  async prep(shared: ReflectionRunShared<C>): Promise<ReflectionInitPrep<C>> {
    shared.lifecycle.phase = 'init';
    shared.lifecycle.status = 'running';
    shared.lifecycle.error = undefined;
    return {
      agent: shared.agent,
      hooks: shared.hooks,
      lifecycle: shared.lifecycle,
    };
  }

  async exec(prepRes: ReflectionInitPrep<C>): Promise<ReflectionInitExec> {
    try {
      const runGroupId = await prepRes.hooks.start();
      await prepRes.hooks.init(runGroupId);
      prepRes.hooks.resetPromptBuilder();
      await prepRes.hooks.initializeClient();
      return {};
    } catch (error) {
      return { error };
    }
  }

  async post(
    shared: ReflectionRunShared<C>,
    _prepRes: ReflectionInitPrep<C>,
    execRes: ReflectionInitExec,
  ): Promise<string | undefined> {
    if (execRes.error) {
      shared.lifecycle.status = 'error';
      shared.lifecycle.error = execRes.error;
      return 'finalize';
    }

    shared.lifecycle.phase = 'rounds';
    shared.lifecycle.status = 'running';
    shared.lifecycle.error = undefined;
    return 'round';
  }
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
      return 'finalize';
    }

    const execResult = execRes as ReflectionRoundExec<C>;

    if (execResult.error) {
      shared.lifecycle.status = 'error';
      shared.lifecycle.error = execResult.error;
      return 'finalize';
    }

    const { result } = execResult;
    if (!result) {
      const missingResultError = new Error('Round result is missing.');
      shared.lifecycle.status = 'error';
      shared.lifecycle.error = missingResultError;
      return 'finalize';
    }

    shared.agent.roundStates.push(result.roundState);
    shared.agent.toolStates.push(result.toolState);
    shared.state.globalState = result.globalState;
    shared.state.messages = result.messages;
    shared.state.continueRounds = result.shouldContinue;
    shared.state.currentRound += 1;
    shared.state.globalState.incrementRounds();

    if (shared.agent.isInterruptionRequested()) {
      return 'finalize';
    }

    if (shared.state.currentRound >= shared.state.totalRounds) {
      return 'finalize';
    }

    if (!shared.state.continueRounds) {
      return 'finalize';
    }

    return 'continue';
  }
}

class ReflectionFinalizeNode<C> extends BaseNode<ReflectionRunShared<C>> {
  async prep(shared: ReflectionRunShared<C>): Promise<ReflectionFinalizePrep> {
    shared.lifecycle.phase = 'finalize';
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
      shared.lifecycle.status = 'error';
      shared.lifecycle.error = error;
    } else {
      shared.lifecycle.status = 'completed';
      shared.lifecycle.error = undefined;
    }

    return undefined;
  }
}

export function createReflectionRunFlow<C>(): Flow<ReflectionRunShared<C>> {
  const initNode = new ReflectionInitNode<C>();
  const roundNode = new ReflectionRoundNode<C>();
  const finalizeNode = new ReflectionFinalizeNode<C>();

  initNode.on('round', roundNode);
  initNode.on('finalize', finalizeNode);

  roundNode.on('continue', roundNode);
  roundNode.on('finalize', finalizeNode);

  return new Flow<ReflectionRunShared<C>>(initNode);
}
