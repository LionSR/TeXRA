/**
 * ToolUseCycleNode - Runs the tool-use cycle (API call + tool execution).
 *
 * Calls runToolUseCycle() directly — no inner Flow, no separate cycle services.
 */
import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import {
  runToolUseCycle,
  type ToolUseCycleOutcome,
} from '@agent/core/flows/ToolUseCycleFlow';
import { bus } from '@eventBus/ProgressEventBus';

import {
  type ToolUseRunShared,
  type CyclePrepResult,
  assertPreparedShared,
} from './types';
import type { ToolUseServices, ToolUseFlowParams } from '../ToolUseServices';
import type { TodoItem } from '@shared/schemas';

type NodeOutcome = ToolUseCycleOutcome | { outcome: 'skipped' };

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

  async exec(prepRes: CyclePrepResult): Promise<NodeOutcome> {
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

    const clientRef = { current: await modelHandler.getClient() };

    prepRes.workspaceState.todos.setOnUpdate((todos: TodoItem[]) => {
      bus.emit('updateTodos', { streamId, todos });
    });

    try {
      return await runToolUseCycle<C>({
        messages: prepRes.messages,
        cycleIndex: prepRes.runState.totalRounds,
        services: {
          ...this.services,
          setting: { ...setting, tools: resolvedTools },
          get client() {
            return clientRef.current;
          },
          async refreshClient() {
            clientRef.current = await modelHandler.getClient();
          },
          modelName: config.model,
          agentName: config.agent,
          run: prepRes.runState,
          workspace: prepRes.workspaceState,
        },
      });
    } finally {
      prepRes.workspaceState.todos.clearOnUpdate();
    }
  }

  async execFallback(
    _prepRes: CyclePrepResult,
    error: Error,
  ): Promise<NodeOutcome> {
    return { outcome: 'failed', message: error.message };
  }

  async post(
    shared: ToolUseRunShared,
    prepRes: CyclePrepResult,
    execRes: NodeOutcome,
  ): Promise<string | undefined> {
    if (prepRes.shouldSkip) {
      shared.shouldSkipCycle = false;
    }

    shared.stateSlices = {
      runStateSnapshot: prepRes.runState,
      workspaceSnapshot: prepRes.workspaceState.toSnapshot(),
      userChannels: prepRes.userChannels,
    };

    switch (execRes.outcome) {
      case 'completed':
        shared.messages = execRes.messages;
        return FlowTransition.DEFAULT;

      case 'skipped':
        return FlowTransition.DEFAULT;

      case 'failed':
        throw new Error(execRes.message);

      case 'cancelled':
        shared.userCancelledRetry = true;
        return FlowTransition.FINALIZE;
    }
  }
}
