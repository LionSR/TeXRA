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

    const hasWorkflowFiles =
      data.workflowFiles !== undefined ||
      data.workflowMissingOutputs !== undefined ||
      data.workflowCompileFailures !== undefined;
    const hasTaskData =
      data.todos !== undefined ||
      data.plan !== undefined ||
      data.queuedFollowUps !== undefined;
    const hasMeta =
      data.conversationProgress !== undefined || data.badges !== undefined;
    const hasRunUsage = data.runUsage !== undefined;
    const hasContext = data.contextState !== undefined;

    if (
      hasWorkflowFiles ||
      hasTaskData ||
      hasMeta ||
      hasRunUsage ||
      hasContext
    ) {
      ctx.setStreamState(data.stream, (prev) =>
        create(prev, (draft) => {
          // contextState is a base field shared by workflow and tool-use.
          if (hasContext) {
            draft.contextState = data.contextState;
          }

          if (hasWorkflowFiles && isWorkflowState(prev)) {
            const d = draft as WorkflowStreamState;
            // Replace (not merge) so a clean operation that shrinks the
            // backend's set is reflected after a tab switch — Object.assign
            // would leak stale rounds.
            if (data.workflowFiles) d.files = { ...data.workflowFiles };
            if (data.workflowMissingOutputs) {
              d.missingOutputs = { ...data.workflowMissingOutputs };
            }
            if (data.workflowCompileFailures) {
              d.compileFailures = { ...data.workflowCompileFailures };
            }
          }

          // runUsage is per-run for both workflow and tool-use; derive the
          // sum into sessionUsage so the UI always shows cumulative totals.
          // Replace (not merge) so a clean operation that shrinks the backend's
          // run set is reflected — Object.assign would leak stale entries and
          // over-count sessionUsage.
          if (
            hasRunUsage &&
            data.runUsage &&
            (isToolUseState(prev) || isWorkflowState(prev))
          ) {
            const d = draft as ToolUseStreamState | WorkflowStreamState;
            d.runUsage = { ...data.runUsage };
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
            if (data.odysseyActive !== undefined)
              d.odysseyActive = data.odysseyActive;
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
