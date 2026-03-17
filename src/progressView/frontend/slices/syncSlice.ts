import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import { sumUsageStats } from '@shared/schemas';

import {
  isToolUseState,
  isWorkflowState,
  type ToolUseStreamState,
  type WorkflowStreamState,
} from '../store';
import { updateParentStreamId } from '../stateUtils';
import type { HandlerRegistry } from '../messageDispatcher';

export const syncHandlers: HandlerRegistry = {
  [PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT]: (data, ctx) => {
    if (!data.stream || data.action === 'clear') return;

    const hasRunData =
      data.activeRunId !== undefined ||
      data.runInstructions !== undefined ||
      data.runUsage !== undefined ||
      data.runFiles !== undefined ||
      data.runMissingOutputs !== undefined ||
      data.contextState !== undefined;
    const hasTaskData =
      data.todos !== undefined ||
      data.plan !== undefined ||
      data.queuedFollowUps !== undefined;
    const hasInstruction = data.instruction !== undefined && !!data.runId;
    const hasMeta =
      data.conversationProgress !== undefined || data.badges !== undefined;

    if (hasRunData || hasTaskData || hasInstruction || hasMeta) {
      ctx.setStreamState(data.stream, (prev) =>
        create(prev, (draft) => {
          if (hasRunData) {
            if (isWorkflowState(prev)) {
              const d = draft as WorkflowStreamState;
              if (data.activeRunId !== undefined)
                d.activeRunId = data.activeRunId;
              if (data.runInstructions) {
                Object.assign(d.runInstructions, data.runInstructions);
              }
              if (data.runFiles) Object.assign(d.runFiles, data.runFiles);
              if (data.runMissingOutputs) {
                Object.assign(d.runMissingOutputs, data.runMissingOutputs);
              }
            }
            if (data.runUsage) {
              Object.assign(draft.runUsage, data.runUsage);
              if (isToolUseState(prev)) {
                (draft as ToolUseStreamState).sessionUsage = sumUsageStats(
                  Object.values((draft as ToolUseStreamState).runUsage),
                );
              }
            }
            if (data.contextState) {
              draft.contextState = data.contextState;
            }
          }

          if (isToolUseState(prev) && hasTaskData) {
            const d = draft as ToolUseStreamState;
            if (data.todos) d.todos = data.todos;
            if (data.todoSummary !== undefined)
              d.todoSummary = data.todoSummary;
            if (data.plan !== undefined) d.plan = data.plan;
            if (data.queuedFollowUps) d.queuedFollowUps = data.queuedFollowUps;
          }

          // Hydrate toggle bypass state on tab switch
          if (isToolUseState(prev)) {
            const d = draft as ToolUseStreamState;
            if (data.toolEditBypass !== undefined)
              d.toolEditBypass = data.toolEditBypass;
            if (data.superYoloBypass !== undefined)
              d.superYoloBypass = data.superYoloBypass;
          }
          if (isWorkflowState(prev) && hasInstruction) {
            const d = draft as WorkflowStreamState;
            if (data.instruction && data.runId) {
              d.runInstructions[data.runId] = data.instruction;
            } else if (data.runId) {
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

    if (data.parentStreamId !== undefined) {
      updateParentStreamId(ctx, data.stream as string, data.parentStreamId);
    }
  },
};
