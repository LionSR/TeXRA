import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import {
  createToolUseCycleFlow,
  type ToolUseCycleShared,
} from '@agent/core/flows/ToolUseCycleFlow';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import { formatProviderHttpError } from '@common/errors';

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
  | { outcome: 'failed'; message: string; userRetryable?: boolean };

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
    const {
      streamId,
      setting,
      resolvedTools,
      modelHandler,
      config,
      runtimeHost,
    } = this.services;

    if (prepRes.shouldSkip) {
      const { todos, plan } = prepRes.workspaceState.workPlan;
      if (todos.length) {
        runtimeHost.emit('updateTodos', { streamId, todos });
      }
      if (plan) {
        runtimeHost.emit('updatePlan', { streamId, plan });
      }
      return { outcome: 'skipped' };
    }

    const cycleShared: ToolUseCycleShared = {
      messages: prepRes.messages,
      shouldStop: false,
      endTurn: false,
      cycleIndex: prepRes.runState.totalRounds,
      cycleResponseTimeMs: 0,
    };

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
    let todoPersistChain = Promise.resolve();
    prepRes.workspaceState.workPlan.setOnUpdate({
      onTodosUpdate: (todos) => {
        runtimeHost.emit('updateTodos', { streamId, todos });
        if (persistTodos) {
          todoPersistChain = todoPersistChain
            .then(() => persistTodos(todos))
            .catch(() => {});
        }
        onProgress?.({ kind: 'todos', todos });
      },
      onPlanUpdate: (plan) => {
        runtimeHost.emit('updatePlan', { streamId, plan });
        onProgress?.({ kind: 'plan', plan });
      },
    });

    try {
      await flow.run(cycleShared);

      if (cycleShared.shouldStop && cycleShared.lastError) {
        return {
          outcome: 'failed',
          message: cycleShared.lastError.message,
          userRetryable: cycleShared.lastError.userRetryable,
        };
      }
      if (cycleShared.shouldStop && !cycleShared.endTurn) {
        return { outcome: 'cancelled' };
      }
      return { outcome: 'completed', messages: cycleShared.messages };
    } finally {
      prepRes.workspaceState.workPlan.clearOnUpdate();
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
      userRetryable: formatted.userRetryable,
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

    // All outcomes continue to WaitNode (FlowTransition.DEFAULT).
    // Tool-use agents are conversational — the user can send a
    // follow-up to retry after a failure, unlike workflows.
    switch (execRes.outcome) {
      case 'completed':
        shared.messages = execRes.messages;
        break;
      case 'skipped':
        break;
      case 'failed':
        shared.lastError = {
          message: execRes.message,
          userRetryable: execRes.userRetryable ?? false,
        };
        break;
      case 'cancelled':
        shared.userCancelledRetry = true;
        break;
    }

    return FlowTransition.DEFAULT;
  }
}
