/**
 * CycleTeardownNode - Syncs workspace/run back to snapshots, routes cycle outcome.
 * All COMPLETE transitions from cycle nodes route here.
 */
import { BaseNode } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';

import type { ToolUseRunShared } from './types';
import type { FlatToolUseServices } from '../runToolUseFlow';

export class CycleTeardownNode<C> extends BaseNode<
  ToolUseRunShared,
  Record<string, unknown>,
  FlatToolUseServices<C>
> {
  async post(shared: ToolUseRunShared): Promise<string | undefined> {
    const { run, workspace } = this.services;
    workspace.todos.clearOnUpdate();

    shared.stateSlices = {
      runStateSnapshot: run,
      workspaceSnapshot: workspace.toSnapshot(),
      userChannels: shared.stateSlices!.userChannels,
    };

    if (shared.shouldSkipCycle) shared.shouldSkipCycle = false;

    if (shared.shouldStop && shared.lastError) {
      throw new Error(shared.lastError.message ?? 'Cycle failed');
    }
    if (shared.shouldStop && !shared.lastError && !shared.endTurn) {
      shared.userCancelledRetry = true;
      return FlowTransition.FINALIZE;
    }

    return FlowTransition.DEFAULT;
  }
}
