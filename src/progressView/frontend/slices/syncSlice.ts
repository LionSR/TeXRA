/**
 * Sync handler: SYNC_STREAM_CONTENT.
 *
 * Batched content sync (tab switch: logs + todos + follow-ups + instruction in one message).
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

import {
  isToolUseState,
  isWorkflowState,
  type ToolUseStreamState,
  type WorkflowStreamState,
} from '../store';
import { updateParentStreamId } from '../stateUtils';
import { applyLogUpdate } from './logSlice';
import type { HandlerRegistry } from '../messageDispatcher';

export const syncHandlers: HandlerRegistry = {
  [PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT]: (data, ctx) => {
    // 1. Logs — shared logic with UPDATE_LOGS
    applyLogUpdate(data, ctx);

    if (!data.stream || data.action === 'clear') return;

    // 2-4. Consolidate stream state updates into a single create() call
    const hasTodos = !!(data.todos || data.queuedFollowUps);
    const hasInstruction = data.instruction !== undefined && !!data.runId;
    const hasMeta = !!(data.conversationProgress || data.badges);

    if (hasTodos || hasInstruction || hasMeta) {
      ctx.setStreamState(data.stream, (prev) =>
        create(prev, (draft) => {
          if (isToolUseState(prev)) {
            const d = draft as ToolUseStreamState;
            if (data.todos) d.todos = data.todos;
            if (data.queuedFollowUps) d.queuedFollowUps = data.queuedFollowUps;
          }
          if (isWorkflowState(prev) && data.instruction !== undefined && data.runId) {
            const d = draft as WorkflowStreamState;
            if (data.instruction) {
              d.runInstructions[data.runId] = data.instruction;
            } else {
              delete d.runInstructions[data.runId];
            }
          }
          if (data.conversationProgress) {
            draft.conversationProgress = data.conversationProgress;
          }
          if (data.badges) {
            draft.activeSubagents = data.badges.activeSubagents;
            draft.finishedSubagentCount = data.badges.finishedSubagentCount;
            draft.activeProcesses = data.badges.activeProcesses;
            draft.finishedProcessCount = data.badges.finishedProcessCount;
          }
        }),
      );
    }

    // parentStreamId uses ctx.setState (different target) — stays separate
    if (data.parentStreamId !== undefined) {
      updateParentStreamId(ctx, data.stream as string, data.parentStreamId);
    }
  },
};
