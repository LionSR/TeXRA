/**
 * Sync handler: SYNC_STREAM_CONTENT.
 *
 * Batched content sync (tab switch: logs + todos + follow-ups + instruction in one message).
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

import {
  updateToolUseState,
  updateWorkflowState,
  updateParentStreamId,
} from '../stateUtils';
import { applyLogUpdate } from './logSlice';
import type { HandlerRegistry } from '../messageDispatcher';

export const syncHandlers: HandlerRegistry = {
  [PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT]: (data, ctx) => {
    // 1. Logs — shared logic with UPDATE_LOGS
    applyLogUpdate(data, ctx);

    if (!data.stream || data.action === 'clear') return;

    // 2. Todos and queued follow-ups
    if (data.todos || data.queuedFollowUps) {
      updateToolUseState(ctx, data.stream, (prev) =>
        create(prev, (draft) => {
          if (data.todos) draft.todos = data.todos;
          if (data.queuedFollowUps)
            draft.queuedFollowUps = data.queuedFollowUps;
        }),
      );
    }

    // 3. Instruction
    if (data.instruction !== undefined && data.runId) {
      updateWorkflowState(ctx, data.stream, (prev) =>
        create(prev, (draft) => {
          const runId = data.runId as string;
          if (data.instruction) {
            draft.runInstructions[runId] = data.instruction;
          } else {
            delete draft.runInstructions[runId];
          }
        }),
      );
    }

    // 4. Active-stream state (R2: replaces separate syncActiveStreamState messages)
    if (data.conversationProgress || data.badges) {
      ctx.setStreamState(data.stream, (prev) =>
        create(prev, (draft) => {
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
    if (data.parentStreamId !== undefined) {
      updateParentStreamId(ctx, data.stream as string, data.parentStreamId);
    }
  },
};
