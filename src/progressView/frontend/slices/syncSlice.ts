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

    const hasWorkflowData =
      data.workflowUsage !== undefined ||
      data.workflowFiles !== undefined ||
      data.workflowMissingOutputs !== undefined;
    const hasTaskData =
      data.todos !== undefined ||
      data.plan !== undefined ||
      data.queuedFollowUps !== undefined;
    const hasMeta =
      data.conversationProgress !== undefined || data.badges !== undefined;
    const hasToolUseUsage = data.runUsage !== undefined;
    const hasContext = data.contextState !== undefined;

    if (
      hasWorkflowData ||
      hasTaskData ||
      hasMeta ||
      hasToolUseUsage ||
      hasContext
    ) {
      ctx.setStreamState(data.stream, (prev) =>
        create(prev, (draft) => {
          // contextState is a base field shared by workflow and tool-use.
          if (hasContext) {
            draft.contextState = data.contextState;
          }

          if (hasWorkflowData && isWorkflowState(prev)) {
            const d = draft as WorkflowStreamState;
            if (data.workflowUsage !== undefined)
              d.usage = data.workflowUsage;
            if (data.workflowFiles)
              Object.assign(d.files, data.workflowFiles);
            if (data.workflowMissingOutputs) {
              Object.assign(d.missingOutputs, data.workflowMissingOutputs);
            }
          }

          if (hasToolUseUsage && isToolUseState(prev) && data.runUsage) {
            const d = draft as ToolUseStreamState;
            Object.assign(d.runUsage, data.runUsage);
            d.sessionUsage = sumUsageStats(Object.values(d.runUsage));
          }

          if (isToolUseState(prev) && hasTaskData) {
            const d = draft as ToolUseStreamState;
            if (data.todos) d.todos = data.todos;
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
