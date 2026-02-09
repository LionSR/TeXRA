/**
 * CycleSetupNode - Reconstructs workspace from snapshot, resets cycle state,
 * updates service refs. Routes COMPLETE to skip cycle on resume.
 */
import { BaseNode } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { resetCycleState } from '@agent/core/flows/CommonCycleTypes';
import { bus } from '@eventBus/ProgressEventBus';

import { type ToolUseRunShared, assertPreparedShared } from './types';
import type { FlatToolUseServices } from '../runToolUseFlow';
import type { TodoItem } from '@shared/schemas';

export class CycleSetupNode<C> extends BaseNode<
  ToolUseRunShared,
  Record<string, unknown>,
  FlatToolUseServices<C>
> {
  async prep(shared: ToolUseRunShared) {
    assertPreparedShared(shared);
    const { runStateSnapshot, workspaceSnapshot } = shared.stateSlices;
    return {
      shouldSkip: shared.shouldSkipCycle,
      runState: runStateSnapshot,
      workspace: AgentWorkspaceState.fromSnapshot(workspaceSnapshot),
    };
  }

  async post(
    shared: ToolUseRunShared,
    prepRes: Awaited<ReturnType<CycleSetupNode<C>['prep']>>,
  ): Promise<string | undefined> {
    if (prepRes.shouldSkip) {
      if (prepRes.workspace.todos.todos.length > 0) {
        bus.emit('updateTodos', { streamId: this.services.streamId, todos: prepRes.workspace.todos.todos });
      }
      return FlowTransition.COMPLETE;
    }

    this.services.updateCycleState(prepRes.runState, prepRes.workspace);

    prepRes.workspace.todos.setOnUpdate((todos: TodoItem[]) => {
      bus.emit('updateTodos', { streamId: this.services.streamId, todos });
    });

    resetCycleState(shared, ['response', 'toolCalls', 'text', 'cycleNormalizedUsage']);
    shared.cycleResponseTimeMs = 0;

    return FlowTransition.DEFAULT;
  }
}
