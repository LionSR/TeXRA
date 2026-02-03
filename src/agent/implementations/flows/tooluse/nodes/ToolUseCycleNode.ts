/**
 * ToolUseCycleNode - Runs the tool-use cycle (API call + tool execution).
 *
 * Creates and runs the ToolUseCycleFlow for model interaction.
 */
import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentRunState } from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import {
  createToolUseCycleFlow,
  type ToolUseCycleShared,
} from '@agent/core/flows/ToolUseCycleFlow';
import { interpretCycleCompletion } from '@agent/core/flows/CommonCycleTypes';
import {
  createClientRef,
  type ToolUseCycleServices,
} from '@agent/core/flows/CycleServices';
import { bus } from '@eventBus/ProgressEventBus';

import {
  type ToolUseRunShared,
  type CyclePrepResult,
  type CycleExecResult,
  assertPreparedShared,
} from './types';
import type { ToolUseServices, ToolUseFlowParams } from '../ToolUseServices';
import type { TodoItem } from '@shared/schemas';

export class ToolUseCycleNode<C> extends Node<
  ToolUseRunShared,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  async prep(shared: ToolUseRunShared): Promise<CyclePrepResult> {
    assertPreparedShared(shared);

    return {
      shouldSkip: shared.shouldSkipCycle,
      conversation: shared.conversation,
      runState: AgentRunState.fromSnapshot(shared.stateSlices.runStateSnapshot),
      workspaceState: AgentWorkspaceState.fromSnapshot(
        shared.stateSlices.workspaceSnapshot,
      ),
      userChannels: shared.stateSlices.userChannels,
    };
  }

  async exec(prepRes: CyclePrepResult): Promise<CycleExecResult> {
    const {
      streamId,
      setting,
      resolvedTools,
      modelHandler,
      getUsageRecorder,
      config,
    } = this.services;

    if (prepRes.shouldSkip) {
      if (prepRes.workspaceState.todos.todos.length > 0) {
        bus.emit('updateTodos', {
          streamId,
          todos: prepRes.workspaceState.todos.todos,
        });
      }
      return { kind: 'skipped' };
    }

    const cycleShared: ToolUseCycleShared = {
      messages: prepRes.conversation,
      shouldStop: false,
      endTurn: false,
      response: undefined,
      responseTimeMs: undefined,
      stopReason: undefined,
      lastError: undefined,
      toolCalls: undefined,
      text: undefined,
      cycleIndex: prepRes.runState.totalRounds,
      cycleResponseTimeMs: 0,
      cycleNormalizedUsage: undefined,
    };

    const flow = createToolUseCycleFlow<C>();
    const [clientRef, refreshClient] = createClientRef<C>(
      await modelHandler.getClient(),
      () => modelHandler.getClient(),
    );
    const flowServices: ToolUseCycleServices<C> & {
      refreshClient: () => Promise<void>;
    } = {
      ...this.services,
      setting: { ...setting, tools: resolvedTools },
      get client() {
        return clientRef.current;
      },
      run: prepRes.runState,
      workspace: prepRes.workspaceState,
      onRoundFinalized: getUsageRecorder(),
      modelName: config.model,
      agentName: config.agent,
      refreshClient,
    };
    flow.setServices(flowServices);

    prepRes.workspaceState.todos.setOnUpdate((todos: TodoItem[]) => {
      bus.emit('updateTodos', {
        streamId,
        todos,
      });
    });

    try {
      await flow.run(cycleShared);

      const completion = interpretCycleCompletion(cycleShared);
      if (completion.failedWithError) {
        return {
          kind: 'failed',
          message: completion.errorMessage ?? 'Cycle failed',
        };
      }
      if (completion.userCancelled) {
        return { kind: 'cancelled' };
      }
      return { kind: 'success', messages: cycleShared.messages };
    } finally {
      prepRes.workspaceState.todos.clearOnUpdate();
    }
  }

  async execFallback(
    _prepRes: CyclePrepResult,
    error: Error,
  ): Promise<CycleExecResult> {
    return { kind: 'failed', message: error.message };
  }

  async post(
    shared: ToolUseRunShared,
    prepRes: CyclePrepResult,
    execRes: CycleExecResult,
  ): Promise<string | undefined> {
    if (prepRes.shouldSkip) {
      shared.shouldSkipCycle = false;
    }

    shared.stateSlices = {
      runStateSnapshot: prepRes.runState.toSnapshot(),
      workspaceSnapshot: prepRes.workspaceState.toSnapshot(),
      userChannels: prepRes.userChannels,
    };

    switch (execRes.kind) {
      case 'success':
        shared.conversation = execRes.messages;
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
