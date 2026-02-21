/**
 * Run tracking handlers: UPDATE_FILES, UPDATE_MISSING_OUTPUTS,
 * UPDATE_INSTRUCTION, UPDATE_RUN_USAGE.
 */

import { create } from 'mutative';

import { sumUsageStats } from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

import { isToolUseState, isWorkflowState } from '../store';
import { updateWorkflowState, updateNestedRounds } from '../stateUtils';
import type { HandlerRegistry } from '../messageDispatcher';

export const runTrackingHandlers: HandlerRegistry = {
  [PROGRESS_VIEW_COMMANDS.UPDATE_FILES]: (data, ctx) => {
    const { stream, ...update } = data;
    updateWorkflowState(ctx, stream, (prev) =>
      create(prev, (draft) => {
        draft.runFiles = updateNestedRounds(prev.runFiles, update);
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS]: (data, ctx) => {
    const { stream, ...update } = data;
    updateWorkflowState(ctx, stream, (prev) =>
      create(prev, (draft) => {
        draft.runMissingOutputs = updateNestedRounds(
          prev.runMissingOutputs,
          update,
        );
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_INSTRUCTION]: (data, ctx) => {
    const { stream, instruction, runId } = data;
    if (!stream || !runId) return;

    updateWorkflowState(ctx, stream, (prev) =>
      create(prev, (draft) => {
        if (instruction) {
          draft.runInstructions[runId] = instruction;
        } else {
          delete draft.runInstructions[runId];
        }
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE]: (data, ctx) => {
    const { stream, runId, usage } = data;
    ctx.setStreamState(stream, (prev) => {
      if (isToolUseState(prev)) {
        return create(prev, (draft) => {
          draft.runUsage[runId] = usage;
          draft.sessionUsage = sumUsageStats(Object.values(draft.runUsage));
        });
      }
      if (isWorkflowState(prev)) {
        return create(prev, (draft) => {
          draft.runUsage[runId] = usage;
        });
      }
      return prev;
    });
  },
};
