import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import {
  createToolUseCycleFlow,
  createToolUseCycleShared,
} from '@agent/core/flows/ToolUseCycleFlow';
import { buildCycleServices } from '@agent/core/flows/CycleServices';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import { formatProviderHttpError } from '@common/errors';
import { bus } from '@eventBus/ProgressEventBus';
import type { ProviderError, TodoItem } from '@shared/schemas';

import {
  type ToolUseRunShared,
  type CyclePrepResult,
  assertPreparedShared,
} from './types';
import type { ToolUseServices, ToolUseFlowParams } from '../ToolUseServices';

type ToolUseCycleOutcome =
  | { outcome: 'completed'; messages: ProviderMessage[] }
  | { outcome: 'skipped' }
  | { outcome: 'cancelled' }
  | { outcome: 'failed'; error: ProviderError };

export class ToolUseCycleNode<C> extends Node<
  ToolUseRunShared,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  async prep(shared: ToolUseRunShared): Promise<CyclePrepResult> {
    assertPreparedShared(shared);

    return {
      shouldSkip: shared.shouldSkipCycle,
      messages: shared.messages,
      runState: shared.stateSlices.runStateSnapshot,
      workspaceState: AgentWorkspaceState.fromSnapshot(
        shared.stateSlices.workspaceSnapshot,
      ),
      userChannels: shared.stateSlices.userChannels,
    };
  }

  async exec(prepRes: CyclePrepResult): Promise<ToolUseCycleOutcome> {
    const { streamId, setting, resolvedTools, modelHandler, config } =
      this.services;

    if (prepRes.shouldSkip) {
      if (prepRes.workspaceState.todos.todos.length > 0) {
        bus.emit('updateTodos', {
          streamId,
          todos: prepRes.workspaceState.todos.todos,
        });
      }
      return { outcome: 'skipped' };
    }

    const cycleShared = createToolUseCycleShared(
      prepRes.messages,
      prepRes.runState.totalRounds,
    );

    const flow = createToolUseCycleFlow<C>();
    flow.setServices(
      await buildCycleServices(this.services, {
        setting: { ...setting, tools: resolvedTools },
        run: prepRes.runState,
        workspace: prepRes.workspaceState,
        modelName: config.model,
        agentName: config.agent,
      }),
    );

    const { onProgress } = this.services;
    prepRes.workspaceState.todos.setOnUpdate((todos: TodoItem[]) => {
      bus.emit('updateTodos', {
        streamId,
        todos,
      });
      onProgress?.({ kind: 'todos', todos });
    });

    try {
      await flow.run(cycleShared);

      if (cycleShared.shouldStop && cycleShared.lastError) {
        return {
          outcome: 'failed',
          error: cycleShared.lastError,
        };
      }
      if (cycleShared.shouldStop && !cycleShared.endTurn) {
        return { outcome: 'cancelled' };
      }
      return { outcome: 'completed', messages: cycleShared.messages };
    } finally {
      prepRes.workspaceState.todos.clearOnUpdate();
    }
  }

  async execFallback(
    _prepRes: CyclePrepResult,
    error: unknown,
  ): Promise<ToolUseCycleOutcome> {
    return {
      outcome: 'failed',
      error: formatProviderHttpError(error),
    };
  }

  async post(
    shared: ToolUseRunShared,
    prepRes: CyclePrepResult,
    execRes: ToolUseCycleOutcome,
  ): Promise<string | undefined> {
    if (prepRes.shouldSkip) {
      shared.shouldSkipCycle = false;
    }

    const workspaceSnapshot = prepRes.workspaceState.toSnapshot();
    shared.stateSlices = {
      runStateSnapshot: prepRes.runState,
      workspaceSnapshot,
      userChannels: prepRes.userChannels,
    };

    if (execRes.outcome === 'completed' && this.services.onProgress) {
      const { interactions } = prepRes.workspaceState;
      const cost = prepRes.runState.usageAccumulator.totals.totalCost;
      this.services.onProgress({
        kind: 'overview',
        toolCallCount: interactions.toolCallCount,
        filesChanged: interactions.editedFilePaths,
        cost: cost > 0 ? cost : undefined,
      });
    }

    switch (execRes.outcome) {
      case 'completed':
        shared.messages = execRes.messages;
        return FlowTransition.DEFAULT;

      case 'skipped':
        return FlowTransition.DEFAULT;

      case 'failed':
        shared.lastError = execRes.error;
        return FlowTransition.FINALIZE;

      case 'cancelled':
        shared.userCancelledRetry = true;
        return FlowTransition.FINALIZE;
    }
  }
}
