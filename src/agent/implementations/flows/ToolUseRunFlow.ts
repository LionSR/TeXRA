// Local imports - core flow primitives
import { BaseNode, Flow } from '@agent/node';

// Local imports - flow constants
import { FlowTransition } from '@agent/core/flows/FlowTransitions';

// Local imports - agent components
import { AgentSharedStore } from '@agent/core/AgentSharedStore';
import { AgentRunState, ConversationRoundState } from '@agent/core/AgentState';
import type { ToolUseCycleOptions } from '@agent/core/ToolUseCycle';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { BaseToolUseAgent } from '../BaseToolUseAgent';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import { AgentInitNode } from '@agent/implementations/flows/common/AgentInitNode';
import type { AgentRunShared } from '@agent/implementations/flows/common/types';
import type { AgentLogStage } from '@logger/AgentLogger';
import {
  beginLifecyclePhase,
  failLifecycle,
  setLifecyclePhase,
  setLifecycleStatus,
} from '@agent/implementations/flows/common/lifecycle';

interface ToolUsePrepareResult<C> {
  messages: ProviderMessage[];
  toolState: AgentWorkspaceState;
  shouldSkipCycle: boolean;
  cycleOptions: ToolUseCycleOptions<C>;
}

interface ToolUsePrepareExecResult<C> {
  result?: ToolUsePrepareResult<C>;
  error?: unknown;
}

interface ToolUseCycleExecResult {
  error?: unknown;
}

interface ToolUseFinalizePrep<C> {
  hooks: ToolUseRunHooks<C>;
  lifecycle: ToolUseRunLifecycle;
}

interface ToolUseFinalizeExecResult {
  snapshotError?: unknown;
  endError?: unknown;
}

type ToolUseRunPhase = 'idle' | 'init' | 'prepare' | 'cycle' | 'finalize';
type ToolUseRunStatus = 'pending' | 'running' | 'error' | 'completed';

export interface ToolUseRunLifecycle {
  phase: ToolUseRunPhase;
  status: ToolUseRunStatus;
  error?: unknown;
}

export interface ToolUseRunState<C = unknown> {
  messages: ProviderMessage[];
  toolState: AgentWorkspaceState | null;
  cycleOptions: ToolUseCycleOptions<C> | null;
  shouldSkipCycle: boolean;
  store: AgentSharedStore | null;
  runState: AgentRunState;
  nextRoundIndex: number;
}

export interface ToolUseRunHooks<C = unknown> {
  start(): Promise<AgentLogStage | undefined>;
  init(runStage: AgentLogStage | undefined): Promise<void>;
  initializeClient(): Promise<void>;
  prepareState(): Promise<{
    messages: ProviderMessage[];
    toolState: AgentWorkspaceState;
    shouldSkipCycle: boolean;
  }>;
  buildCycleOptions(toolState: AgentWorkspaceState): ToolUseCycleOptions<C>;
  runCycle(
    options: ToolUseCycleOptions<C>,
    messages: ProviderMessage[],
    store: AgentSharedStore,
  ): Promise<void>;
  checkInterruption(): boolean;
  hasQueuedFollowUp(): boolean;
  enterWaitingState(): Promise<void>;
  clearPersistedSnapshot(): Promise<void>;
  waitForFollowUp(): Promise<string | null>;
  markRunning(): Promise<void>;
  applyFollowUp(
    followUp: string,
    messages: ProviderMessage[],
  ): Promise<ProviderMessage[]>;
  end(status: 'stopped' | 'error'): Promise<void>;
  cleanup(): Promise<void>;
  logFinalizeWarning?(message: string, error: unknown): void;
}

export type ToolUseRunShared<C = unknown> = AgentRunShared<
  BaseToolUseAgent<C>,
  ToolUseRunState<C>,
  ToolUseRunLifecycle,
  ToolUseRunHooks<C>
>;

class ToolUsePrepareNode<C> extends BaseNode<ToolUseRunShared<C>> {
  async prep(shared: ToolUseRunShared<C>): Promise<ToolUseRunShared<C>> {
    beginLifecyclePhase(shared.lifecycle, 'prepare');
    return shared;
  }

  async exec(
    shared: ToolUseRunShared<C>,
  ): Promise<ToolUsePrepareExecResult<C>> {
    try {
      const prepared = await shared.hooks.prepareState();
      if (!prepared) {
        return {
          error: new Error(
            'Failed to prepare tool-use run: prepareState returned no result',
          ),
        };
      }
      const cycleOptions = shared.hooks.buildCycleOptions(prepared.toolState);
      if (!cycleOptions) {
        return {
          error: new Error(
            'Failed to prepare tool-use run: buildCycleOptions returned no result',
          ),
        };
      }
      return {
        result: {
          ...prepared,
          cycleOptions,
        },
      };
    } catch (error) {
      return { error };
    }
  }

  async post(
    shared: ToolUseRunShared<C>,
    _prepRes: ToolUseRunShared<C>,
    execRes: ToolUsePrepareExecResult<C>,
  ): Promise<string | undefined> {
    if (execRes.error || !execRes.result) {
      const error =
        execRes.error ??
        new Error('Failed to prepare tool-use run: no result from prepare');
      failLifecycle(shared.lifecycle, error);
      return FlowTransition.FINALIZE;
    }

    const { messages, toolState, shouldSkipCycle, cycleOptions } =
      execRes.result;
    shared.state.messages = messages;
    shared.state.toolState = toolState;
    shared.state.shouldSkipCycle = shouldSkipCycle;
    shared.state.cycleOptions = cycleOptions;
    if (!shared.state.store) {
      const roundState = new ConversationRoundState(
        shared.state.nextRoundIndex,
      );
      shared.state.store = new AgentSharedStore({
        round: roundState,
        run: shared.state.runState,
        workspace: toolState,
        user: shared.agent.getUserVarChannels(),
      });
    } else {
      shared.state.store.setRound(
        new ConversationRoundState(shared.state.nextRoundIndex),
      );
    }

    beginLifecyclePhase(shared.lifecycle, 'cycle');

    return FlowTransition.EXECUTE;
  }
}

class ToolUseCycleNode<C> extends BaseNode<ToolUseRunShared<C>> {
  async prep(shared: ToolUseRunShared<C>): Promise<ToolUseRunShared<C>> {
    beginLifecyclePhase(shared.lifecycle, 'cycle');
    return shared;
  }

  async exec(shared: ToolUseRunShared<C>): Promise<ToolUseCycleExecResult> {
    const { hooks, state } = shared;
    const cycleOptions = state.cycleOptions!;

    try {
      while (true) {
        if (!state.shouldSkipCycle) {
          if (!state.store) {
            throw new Error('Tool-use store is not initialized.');
          }
          await hooks.runCycle(cycleOptions, state.messages, state.store);
          state.nextRoundIndex = state.store.round.roundIndex;
        } else {
          state.shouldSkipCycle = false;
        }

        if (hooks.checkInterruption()) {
          return {};
        }

        if (hooks.hasQueuedFollowUp()) {
          await hooks.clearPersistedSnapshot();
        } else {
          await hooks.enterWaitingState();
        }

        const followUp = await hooks.waitForFollowUp();
        if (!followUp || hooks.checkInterruption()) {
          return {};
        }

        await hooks.markRunning();
        await hooks.clearPersistedSnapshot();
        const updatedMessages = await hooks.applyFollowUp(
          followUp,
          state.messages,
        );
        state.messages = updatedMessages;
      }
    } catch (error) {
      return { error };
    }
  }

  async post(
    shared: ToolUseRunShared<C>,
    _prepRes: ToolUseRunShared<C>,
    execRes: ToolUseCycleExecResult,
  ): Promise<string | undefined> {
    if (execRes.error) {
      failLifecycle(shared.lifecycle, execRes.error);
    } else {
      setLifecycleStatus(shared.lifecycle, 'running');
    }

    return FlowTransition.FINALIZE;
  }
}

class ToolUseFinalizeNode<C> extends BaseNode<ToolUseRunShared<C>> {
  async prep(shared: ToolUseRunShared<C>): Promise<ToolUseFinalizePrep<C>> {
    setLifecyclePhase(shared.lifecycle, 'finalize');
    return {
      hooks: shared.hooks,
      lifecycle: shared.lifecycle,
    };
  }

  async exec(
    prepRes: ToolUseFinalizePrep<C>,
  ): Promise<ToolUseFinalizeExecResult> {
    const status = prepRes.lifecycle.status === 'error' ? 'error' : 'stopped';
    const result: ToolUseFinalizeExecResult = {};

    try {
      await prepRes.hooks.clearPersistedSnapshot();
    } catch (error) {
      result.snapshotError = error;
    }

    try {
      await prepRes.hooks.end(status);
    } catch (error) {
      result.endError = error;
    }

    return result;
  }

  async post(
    shared: ToolUseRunShared<C>,
    prepRes: ToolUseFinalizePrep<C>,
    execRes: ToolUseFinalizeExecResult,
  ): Promise<string | undefined> {
    const errors: unknown[] = [];

    if (shared.lifecycle.error) {
      errors.push(shared.lifecycle.error);
    }

    if (execRes.snapshotError) {
      errors.push(execRes.snapshotError);
    }

    if (execRes.endError) {
      errors.push(execRes.endError);
    }

    let error = errors[0];

    try {
      await prepRes.hooks.cleanup();
    } catch (cleanupError: unknown) {
      errors.push(cleanupError);
      if (!error) {
        error = cleanupError;
      }
    }

    if (errors.length > 1) {
      errors.slice(1).forEach((err) => {
        prepRes.hooks.logFinalizeWarning?.(
          'Additional finalize error encountered.',
          err,
        );
      });
    }

    if (error) {
      failLifecycle(shared.lifecycle, error);
    } else {
      setLifecycleStatus(shared.lifecycle, 'completed');
    }

    return undefined;
  }
}

export function createToolUseRunFlow<C>(): Flow<ToolUseRunShared<C>> {
  const initNode = new AgentInitNode<ToolUseRunShared<C>>({
    phase: 'init',
    onSuccess: (shared) => {
      beginLifecyclePhase(shared.lifecycle, 'prepare');
      return FlowTransition.EXECUTE;
    },
  });
  const prepareNode = new ToolUsePrepareNode<C>();
  const cycleNode = new ToolUseCycleNode<C>();
  const finalizeNode = new ToolUseFinalizeNode<C>();

  initNode.on(FlowTransition.EXECUTE, prepareNode);
  initNode.on(FlowTransition.FINALIZE, finalizeNode);

  prepareNode.on(FlowTransition.EXECUTE, cycleNode);
  prepareNode.on(FlowTransition.FINALIZE, finalizeNode);

  cycleNode.on(FlowTransition.FINALIZE, finalizeNode);

  return new Flow<ToolUseRunShared<C>>(initNode);
}
