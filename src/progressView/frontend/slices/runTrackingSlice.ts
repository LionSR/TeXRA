/**
 * Run tracking handlers: UPDATE_FILES, UPDATE_MISSING_OUTPUTS,
 * UPDATE_INSTRUCTION, UPDATE_RUN_USAGE.
 *
 * Workflow streams are one run per tab — file/missing/instruction updates
 * always target the single active run. Tool-use streams keep their own
 * per-run usage map (resume produces multiple runs in one tab).
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import { sumUsageStats } from '@shared/schemas';

import { isToolUseState, isWorkflowState } from '../store';
import { updateWorkflowState, updateRounds } from '../stateUtils';
import type { HandlerRegistry } from '../messageDispatcher';

export const runTrackingHandlers: HandlerRegistry = {
  [PROGRESS_VIEW_COMMANDS.UPDATE_FILES]: (data, ctx) => {
    const { stream, rounds, reset } = data;
    updateWorkflowState(ctx, stream, (prev) =>
      create(prev, (draft) => {
        draft.files = updateRounds(prev.files, { rounds, reset });
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS]: (data, ctx) => {
    const { stream, rounds, reset } = data;
    updateWorkflowState(ctx, stream, (prev) =>
      create(prev, (draft) => {
        draft.missingOutputs = updateRounds(prev.missingOutputs, {
          rounds,
          reset,
        });
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_INSTRUCTION]: (data, ctx) => {
    const { stream, instruction } = data;
    if (!stream) return;

    updateWorkflowState(ctx, stream, (prev) =>
      create(prev, (draft) => {
        draft.instruction = instruction ?? null;
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
          draft.usage = usage;
        });
      }
      return prev;
    });
  },
};
