import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import {
  createToolUseCycleFlow,
  createToolUseCycleShared,
} from '@agent/core/flows/ToolUseCycleFlow';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import { formatProviderHttpError } from '@common/errors';
import { bus } from '@eventBus/ProgressEventBus';

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
  | { outcome: 'failed'; message: string; retryable?: boolean };

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
      if (prepRes.workspaceState.todos.todos.length) {
        bus.emit('updateTodos', {
          streamId,
          todos: prepRes.workspaceState.todos.todos,
        });
      }
      if (prepRes.workspaceState.plan.plan) {
        bus.emit('updatePlan', {
          streamId,
          plan: prepRes.workspaceState.plan.plan,
        });
      }
      return { outcome: 'skipped' };
    }

    const cycleShared = createToolUseCycleShared(
      prepRes.messages,
      prepRes.runState.totalRounds,
    );

    const flow = createToolUseCycleFlow<C>();
    let client = await modelHandler.getClient();
    flow.setServices({
      ...this.services,
      get client() {
        return client;
      },
      async refreshClient() {
        client = await modelHandler.getClient();
      },
      setting: { ...setting, tools: resolvedTools },
      run: prepRes.runState,
      workspace: prepRes.workspaceState,
      modelName: config.model,
      agentName: config.agent,
    });

    const { onProgress, persistTodos } = this.services;
    // Serialize writes so rapid updates don't persist out of order
    let todoPersistChain = Promise.resolve();
    prepRes.workspaceState.todos.setOnUpdate((todos) => {
      bus.emit('updateTodos', {
        streamId,
        todos,
      });
      if (persistTodos) {
        todoPersistChain = todoPersistChain
          .then(() => persistTodos(todos))
          .catch(() => {});
      }
      onProgress?.({ kind: 'todos', todos });
    });
    prepRes.workspaceState.plan.setOnUpdate((plan) => {
      bus.emit('updatePlan', {
        streamId,
        plan,
      });
      onProgress?.({ kind: 'plan', plan });
    });

    try {
      await flow.run(cycleShared);

      if (cycleShared.shouldStop && cycleShared.lastError) {
        return {
          outcome: 'failed',
          message: cycleShared.lastError.message,
          retryable: cycleShared.lastError.retryable,
        };
      }
      if (cycleShared.shouldStop && !cycleShared.endTurn) {
        return { outcome: 'cancelled' };
      }
      return { outcome: 'completed', messages: cycleShared.messages };
    } finally {
      prepRes.workspaceState.todos.clearOnUpdate();
      prepRes.workspaceState.plan.clearOnUpdate();
      // Drain in-flight persist writes before returning so they don't
      // race with the projection's writeTodos after this node completes.
      await todoPersistChain;
    }
  }

  async execFallback(
    _prepRes: CyclePrepResult,
    error: Error,
  ): Promise<ToolUseCycleOutcome> {
    const formatted = formatProviderHttpError(error);
    return {
      outcome: 'failed',
      message: error.message,
      retryable: formatted.retryable,
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

    const workspaceSnapshot = prepRes.workspaceState.toSnapshot({
      excludeAssemblyStrings: true,
    });
    shared.stateSlices = {
      runStateSnapshot: prepRes.runState,
      workspaceSnapshot,
      userChannels: prepRes.userChannels,
    };

    if (execRes.outcome === 'completed') {
      const { interactions } = prepRes.workspaceState;
      const cost = prepRes.runState.usageAccumulator.totals.totalCost;
      this.services.onProgress?.({
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
        shared.lastError = {
          message: execRes.message,
          retryable: execRes.retryable ?? false,
        };
        // Continue to WaitNode instead of ending the flow.
        // Tool-use agents are conversational — the user can send a
        // follow-up to retry after a failure, unlike workflows.
        return FlowTransition.DEFAULT;

      case 'cancelled':
        shared.userCancelledRetry = true;
        return FlowTransition.DEFAULT;
    }
  }
}
