/**
 * ToolUseCycleNode - Runs the tool-use cycle (API call + tool execution).
 *
 * Creates and runs the ToolUseCycleFlow for model interaction.
 */
import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import {
  createToolUseCycleFlow,
  createToolUseCycleShared,
} from '@agent/core/flows/ToolUseCycleFlow';
import { buildCycleServices } from '@agent/core/flows/CycleServices';
import { bus } from '@eventBus/ProgressEventBus';

import {
  type ToolUseRunShared,
  type CyclePrepResult,
  assertPreparedShared,
} from './types';
import type { ToolUseServices, ToolUseFlowParams } from '../ToolUseServices';
import type { TodoItem } from '@shared/schemas';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

/**
 * Cycle outcome — single discriminated union that maps 1:1 to post() actions.
 * Eliminates the prior chain: shared flags → interpretCycleCompletion() →
 * InvocationResult mapping → post() switch.
 */
type ToolUseCycleOutcome =
  | { outcome: 'completed'; messages: ProviderMessage[] }
  | { outcome: 'skipped' }
  | { outcome: 'cancelled' }
  | { outcome: 'failed'; message: string };

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

    prepRes.workspaceState.todos.setOnUpdate((todos: TodoItem[]) => {
      bus.emit('updateTodos', {
        streamId,
        todos,
      });
    });

    try {
      await flow.run(cycleShared);

      // Determine outcome directly from shared state flags (single interpretation)
      if (cycleShared.shouldStop && cycleShared.lastError) {
        return {
          outcome: 'failed',
          message: cycleShared.lastError.message ?? 'Cycle failed',
        };
      }
      if (
        cycleShared.shouldStop &&
        !cycleShared.lastError &&
        !cycleShared.endTurn
      ) {
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
    return { outcome: 'failed', message: error.message };
  }

  async post(
    shared: ToolUseRunShared,
    prepRes: CyclePrepResult,
    execRes: ToolUseCycleOutcome,
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
