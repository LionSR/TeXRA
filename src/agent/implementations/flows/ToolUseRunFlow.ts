// Local imports - core flow primitives
import { BaseNode, Flow } from '@agent/node';

// Local imports - flow constants
import { FlowTransition } from '@agent/core/flows/FlowTransitions';

// Local imports - agent components
import type { ToolUseCycleOptions } from '@agent/core/ToolUseCycle';
import type { ToolState } from '@agent/core/ToolState';
import type { BaseToolUseAgent } from '../BaseToolUseAgent';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

interface ToolUsePrepareResult<C> {
  messages: ProviderMessage[];
  toolState: ToolState;
  shouldSkipCycle: boolean;
  cycleOptions: ToolUseCycleOptions<C>;
}

interface ToolUsePrepareExecResult<C> {
  result?: ToolUsePrepareResult<C>;
  error?: unknown;
}

interface ToolUseInitPrep<C> {
  hooks: ToolUseRunHooks<C>;
  lifecycle: ToolUseRunLifecycle;
}

interface ToolUseInitExecResult {
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
  toolState: ToolState | null;
  cycleOptions: ToolUseCycleOptions<C> | null;
  shouldSkipCycle: boolean;
}

export interface ToolUseRunHooks<C = unknown> {
  start(): Promise<string>;
  init(runGroupId: string): Promise<void>;
  initializeClient(): Promise<void>;
  prepareState(): Promise<{
    messages: ProviderMessage[];
    toolState: ToolState;
    shouldSkipCycle: boolean;
  }>;
  buildCycleOptions(toolState: ToolState): ToolUseCycleOptions<C>;
  runCycle(
    options: ToolUseCycleOptions<C>,
    messages: ProviderMessage[],
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
  end(status: 'stopped' | 'error'): void | Promise<void>;
  cleanup(): void | Promise<void>;
}

export interface ToolUseRunShared<C = unknown> {
  agent: BaseToolUseAgent<C>;
  state: ToolUseRunState<C>;
  lifecycle: ToolUseRunLifecycle;
  hooks: ToolUseRunHooks<C>;
}

class ToolUseInitNode<C> extends BaseNode<ToolUseRunShared<C>> {
  async prep(shared: ToolUseRunShared<C>): Promise<ToolUseInitPrep<C>> {
    shared.lifecycle.phase = 'init';
    shared.lifecycle.status = 'running';
    shared.lifecycle.error = undefined;
    return {
      hooks: shared.hooks,
      lifecycle: shared.lifecycle,
    };
  }

  async exec(prepRes: ToolUseInitPrep<C>): Promise<ToolUseInitExecResult> {
    try {
      const runGroupId = await prepRes.hooks.start();
      await prepRes.hooks.init(runGroupId);
      await prepRes.hooks.initializeClient();
      return {};
    } catch (error) {
      return { error };
    }
  }

  async post(
    shared: ToolUseRunShared<C>,
    _prepRes: ToolUseInitPrep<C>,
    execRes: ToolUseInitExecResult,
  ): Promise<string | undefined> {
    if (execRes.error) {
      shared.lifecycle.status = 'error';
      shared.lifecycle.error = execRes.error;
      return FlowTransition.FINALIZE;
    }

    shared.lifecycle.phase = 'prepare';
    shared.lifecycle.status = 'running';
    shared.lifecycle.error = undefined;
    return FlowTransition.EXECUTE;
  }
}

class ToolUsePrepareNode<C> extends BaseNode<ToolUseRunShared<C>> {
  async prep(shared: ToolUseRunShared<C>): Promise<void> {
    shared.lifecycle.phase = 'prepare';
    shared.lifecycle.status = 'running';
    shared.lifecycle.error = undefined;
  }

  async exec(shared: ToolUseRunShared<C>): Promise<ToolUsePrepareExecResult<C>> {
    try {
      const prepared = await shared.hooks.prepareState();
      const cycleOptions = shared.hooks.buildCycleOptions(prepared.toolState);
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
    _prepRes: void,
    execRes: ToolUsePrepareExecResult<C>,
  ): Promise<string | undefined> {
    if (execRes.error || !execRes.result) {
      const error = execRes.error ?? new Error('Failed to prepare tool-use run');
      shared.lifecycle.status = 'error';
      shared.lifecycle.error = error;
      return FlowTransition.FINALIZE;
    }

    const { messages, toolState, shouldSkipCycle, cycleOptions } = execRes.result;
    shared.state.messages = messages;
    shared.state.toolState = toolState;
    shared.state.shouldSkipCycle = shouldSkipCycle;
    shared.state.cycleOptions = cycleOptions;

    shared.lifecycle.phase = 'cycle';
    shared.lifecycle.status = 'running';
    shared.lifecycle.error = undefined;

    return FlowTransition.EXECUTE;
  }
}

class ToolUseCycleNode<C> extends BaseNode<ToolUseRunShared<C>> {
  async exec(shared: ToolUseRunShared<C>): Promise<ToolUseCycleExecResult> {
    const { hooks, state } = shared;

    if (!state.cycleOptions) {
      return { error: new Error('Tool-use cycle options are missing.') };
    }

    try {
      while (true) {
        if (!state.shouldSkipCycle) {
          await hooks.runCycle(state.cycleOptions, state.messages);
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
    _prepRes: unknown,
    execRes: ToolUseCycleExecResult,
  ): Promise<string | undefined> {
    if (execRes.error) {
      shared.lifecycle.status = 'error';
      shared.lifecycle.error = execRes.error;
    }

    return FlowTransition.FINALIZE;
  }
}

class ToolUseFinalizeNode<C> extends BaseNode<ToolUseRunShared<C>> {
  async prep(shared: ToolUseRunShared<C>): Promise<ToolUseFinalizePrep<C>> {
    shared.lifecycle.phase = 'finalize';
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
      await Promise.resolve(prepRes.hooks.end(status));
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
    let error = shared.lifecycle.error;

    if (!error && execRes.snapshotError) {
      error = execRes.snapshotError;
    }

    if (!error && execRes.endError) {
      error = execRes.endError;
    }

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

export function createToolUseRunFlow<C>(): Flow<ToolUseRunShared<C>> {
  const initNode = new ToolUseInitNode<C>();
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
