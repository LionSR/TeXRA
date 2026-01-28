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
    if (prepRes.shouldSkip) {
      const recoveredTodos = prepRes.workspaceState.todos.todos;
      if (recoveredTodos.length > 0) {
        bus.emit('updateTodos', {
          streamId: this.services.streamId,
          todos: recoveredTodos,
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
    flow.setServices({
      ...this.services,
      setting: { ...this.services.setting, tools: this.services.resolvedTools },
      client: await this.services.modelHandler.getClient(),
      run: prepRes.runState,
      workspace: prepRes.workspaceState,
      onRoundFinalized: this.services.getUsageRecorder(),
      modelName: this.services.config.model,
      agentName: this.services.config.agent,
      session: this.services.session,
      onFollowUpConsumed: this.services.onFollowUpConsumed,
    });

    prepRes.workspaceState.todos.setOnUpdate((todos: TodoItem[]) => {
      bus.emit('updateTodos', {
        streamId: this.services.streamId,
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
