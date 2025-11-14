// Local imports - core flow primitives
import { BaseNode, Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentSharedStore } from '@agent/core/AgentSharedStore';
import { AgentRunState } from '@agent/core/AgentState';
// Type imports
import type { ToolUseCycleOptions } from '@agent/core/ToolUseCycle';
import type { BaseToolUseAgent } from '@agent/implementations/BaseToolUseAgent';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
// Internal imports
import { AgentInitNode } from '@agent/implementations/flows/common/AgentInitNode';
// Type imports
import type {
  AgentLifecycleState,
  AgentRunHooks,
  AgentRunShared,
} from '@agent/implementations/flows/common/types';
// Internal imports
import {
  beginLifecyclePhase,
  failLifecycle,
  setLifecyclePhase,
  setLifecycleStatus,
} from '@agent/implementations/flows/common/lifecycle';
import { buildRunFlow } from '@agent/implementations/flows/common/buildRunFlow';
import { finalizeLifecycle } from '@agent/implementations/flows/common/finalizeLifecycle';

interface ToolUsePrepareResult<C> {
  messages: ProviderMessage[];
  store: AgentSharedStore;
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

export type ToolUseRunPhase =
  | 'idle'
  | 'init'
  | 'prepare'
  | 'cycle'
  | 'finalize';

export type ToolUseRunLifecycle = AgentLifecycleState<ToolUseRunPhase>;

export interface ToolUseRunState<C = unknown> {
  conversation: ProviderMessage[];
  cycleOptions: ToolUseCycleOptions<C> | null;
  shouldSkipCycle: boolean;
  store: AgentSharedStore | null;
  runState: AgentRunState;
}

export interface ToolUseRunHooks<C = unknown> extends AgentRunHooks {
  prepareState(): Promise<{
    messages: ProviderMessage[];
    store: AgentSharedStore;
    shouldSkipCycle: boolean;
  }>;
  buildCycleOptions(store: AgentSharedStore): ToolUseCycleOptions<C>;
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
      const cycleOptions = shared.hooks.buildCycleOptions(prepared.store);
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

    const { messages, store, shouldSkipCycle, cycleOptions } = execRes.result;
    shared.state.conversation = [...messages];
    shared.state.shouldSkipCycle = shouldSkipCycle;
    shared.state.cycleOptions = cycleOptions;
    shared.state.store = store;

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
          await hooks.runCycle(cycleOptions, state.conversation, state.store);
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
          state.conversation,
        );
        state.conversation = [...updatedMessages];
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

  async exec(prepRes: ToolUseFinalizePrep<C>): Promise<void> {
    const status = prepRes.lifecycle.status === 'error' ? 'error' : 'stopped';
    await finalizeLifecycle({
      lifecycle: prepRes.lifecycle,
      runFinalize: async () => {
        await prepRes.hooks.clearPersistedSnapshot();
        await prepRes.hooks.end(status);
      },
      runCleanup: () => Promise.resolve(prepRes.hooks.cleanup()),
      onSuccess: () => setLifecycleStatus(prepRes.lifecycle, 'completed'),
      onSecondaryError: (error) =>
        prepRes.hooks.logFinalizeWarning?.(
          'Additional finalize error encountered.',
          error,
        ),
    });
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

  return buildRunFlow({
    init: initNode,
    finalize: finalizeNode,
    links: [
      { from: initNode, on: FlowTransition.EXECUTE, to: prepareNode },
      { from: prepareNode, on: FlowTransition.EXECUTE, to: cycleNode },
      { from: prepareNode, on: FlowTransition.FINALIZE },
      { from: cycleNode, on: FlowTransition.FINALIZE },
    ],
  });
}
