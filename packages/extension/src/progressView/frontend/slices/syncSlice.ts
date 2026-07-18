// Shared imports
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  AgentCategory,
  sumUsageStats,
  type ProgressViewOutboundHandlerRegistry,
  type StreamContentRenderPayload,
} from '@shared/schemas';

// Local imports
import {
  updateParentStreamId,
  updateToolUseState,
  updateWorkflowState,
} from '../stateUtils';

function activeStateFields(data: StreamContentRenderPayload) {
  if (!data.activeState) return {};
  const { conversationProgress, roundStage, badges } = data.activeState;
  return {
    conversationProgress,
    roundStage: roundStage ?? undefined,
    activeSubagents: badges.activeSubagents,
    finishedSubagentCount: badges.finishedSubagentCount,
    activeProcesses: badges.activeProcesses,
    finishedProcessCount: badges.finishedProcessCount,
  };
}

// The composed registry is exhaustive across the assembled dispatcher. This
// slice owns only stream-content synchronization.
export const syncHandlers = {
  [PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT]: (data) => {
    if (data.action === 'clear') return;

    const runUsage = { ...data.runUsage };
    const sessionUsage = sumUsageStats(Object.values(runUsage));

    if (data.kind === AgentCategory.Workflow) {
      updateWorkflowState(data.stream, (prev) => ({
        ...prev,
        ...activeStateFields(data),
        runUsage,
        sessionUsage,
        files: { ...data.outputs.files },
        missingOutputs: { ...data.outputs.missing },
        compileFailures: { ...data.outputs.compileFailures },
      }));
    } else {
      const { workPlan, controls } = data;
      updateToolUseState(data.stream, (prev) => ({
        ...prev,
        ...activeStateFields(data),
        runUsage,
        sessionUsage,
        todos: workPlan.todos,
        plan: workPlan.plan,
        queuedFollowUps: workPlan.queuedFollowUps,
        toolEditBypass: controls.toolEditBypass,
        superYoloBypass: controls.superYoloBypass,
        goalActive: controls.goal.active,
        goalStatus: controls.goal.active ? controls.goal.status : undefined,
        goalObjective: controls.goal.active
          ? controls.goal.objective
          : undefined,
      }));
    }

    if (data.activeState) {
      updateParentStreamId(data.stream, data.activeState.parentStreamId);
    }
  },
} satisfies Partial<ProgressViewOutboundHandlerRegistry>;
