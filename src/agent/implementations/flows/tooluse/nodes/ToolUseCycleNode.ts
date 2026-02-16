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

import {
  type ToolUseRunShared,
  type CyclePrepResult,
  assertPreparedShared,
} from './types';
import type { ToolUseServices, ToolUseFlowParams } from '../ToolUseServices';
import type { TodoItem } from '@shared/schemas';

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
          message: cycleShared.lastError.message ?? 'Cycle failed',
          retryable: cycleShared.lastError.retryable,
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

    const workspaceSnapshot = prepRes.workspaceState.toSnapshot();
    shared.stateSlices = {
      runStateSnapshot: prepRes.runState,
      workspaceSnapshot,
      userChannels: prepRes.userChannels,
    };

    // Emit overview progress after each completed cycle.
    // toolCallCount = actual number of tool invocations (not model cycles).
    if (execRes.outcome === 'completed') {
      const { onProgress } = this.services;
      if (onProgress) {
        const interactions = workspaceSnapshot.interactions;
        const edits = interactions?.edits ?? [];
        onProgress({
          kind: 'overview',
          toolCallCount: interactions?.toolCallCount ?? 0,
          filesChanged: edits.map(
            (e: { path: string }) => e.path,
          ),
        });
      }
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
        return FlowTransition.FINALIZE;

      case 'cancelled':
        shared.userCancelledRetry = true;
        return FlowTransition.FINALIZE;
    }
  }
}
