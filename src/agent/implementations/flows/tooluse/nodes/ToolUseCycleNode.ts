import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import {
  createToolUseCycleFlow,
  createToolUseCycleShared,
  type ToolUseCycleShared,
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

/** Result from exec: either skipped (resume), or the cycle's mutable shared state. */
type CycleExecResult =
  | { kind: 'skipped' }
  | { kind: 'ran'; cycleShared: ToolUseCycleShared };

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

  async exec(prepRes: CyclePrepResult): Promise<CycleExecResult> {
    const { streamId, setting, resolvedTools, config } = this.services;

    if (prepRes.shouldSkip) {
      if (prepRes.workspaceState.todos.todos.length > 0) {
        bus.emit('updateTodos', {
          streamId,
          todos: prepRes.workspaceState.todos.todos,
        });
      }
      return { kind: 'skipped' };
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
      bus.emit('updateTodos', { streamId, todos });
    });

    try {
      await flow.run(cycleShared);
    } finally {
      prepRes.workspaceState.todos.clearOnUpdate();
    }

    return { kind: 'ran', cycleShared };
  }

  async execFallback(
    _prepRes: CyclePrepResult,
    error: Error,
  ): Promise<CycleExecResult> {
    const formatted = formatProviderHttpError(error);
    const cycleShared: ToolUseCycleShared = {
      messages: [],
      endTurn: false,
      shouldStop: true,
      cycleIndex: 0,
      cycleResponseTimeMs: 0,
      lastError: { message: error.message, retryable: formatted.retryable },
    };
    return { kind: 'ran', cycleShared };
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
      runStateSnapshot: prepRes.runState,
      workspaceSnapshot: prepRes.workspaceState.toSnapshot(),
      userChannels: prepRes.userChannels,
    };

    if (execRes.kind === 'skipped') {
      return FlowTransition.DEFAULT;
    }

    const { cycleShared } = execRes;

    // Failed — propagate error
    if (cycleShared.shouldStop && cycleShared.lastError) {
      shared.lastError = {
        message: cycleShared.lastError.message ?? 'Cycle failed',
        retryable: cycleShared.lastError.retryable ?? false,
      };
      throw new Error(shared.lastError.message);
    }

    // Cancelled — signal finalization
    if (cycleShared.shouldStop && !cycleShared.endTurn) {
      shared.userCancelledRetry = true;
      return FlowTransition.FINALIZE;
    }

    // Completed — update messages
    shared.messages = cycleShared.messages;
    return FlowTransition.DEFAULT;
  }
}
