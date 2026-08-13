// Shared imports
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  AgentCategory,
  type ProgressViewOutboundHandlerRegistry,
  type StreamContentRenderPayload,
} from '@shared/schemas';
// Local imports
import {
  goalToStateFields,
  updateToolUseState,
  updateWorkflowState,
} from '../stateUtils';

function activeStateFields(data: StreamContentRenderPayload) {
  if (!data.activeState) return {};
  const { conversationProgress, stage, badges } = data.activeState;
  return {
    conversationProgress,
    stage: stage ?? undefined,
    subagents: badges.subagents,
  };
}

// The composed registry is exhaustive across the assembled dispatcher. This
// slice owns only stream-content synchronization.
export const syncHandlers = {
  [PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT]: (data) => {
    if (data.action === 'clear') return;

    const runUsage = { ...data.runUsage };

    if (data.category === AgentCategory.Workflow) {
      updateWorkflowState(data.stream, (prev) => ({
        ...prev,
        ...activeStateFields(data),
        runUsage,
        files: { ...data.outputs.files },
        missingOutputs: { ...data.outputs.missing },
        compileFailures: { ...data.outputs.compileFailures },
      }));
    } else {
      const { workPlan, controls } = data;
      // `controls.goal` already matches GoalStateSchema (the wire schema
      // imports it directly from `@shared/schemas/goal`) — no need to
      // round-trip it through deriveGoalState.
      const goal = controls.goal;
      updateToolUseState(data.stream, (prev) => ({
        ...prev,
        ...activeStateFields(data),
        runUsage,
        todos: workPlan.todos,
        plan: workPlan.plan,
        queuedFollowUps: workPlan.queuedFollowUps,
        bashBypass: controls.bashBypass,
        toolEditBypass: controls.toolEditBypass,
        superYoloBypass: controls.superYoloBypass,
        ...goalToStateFields(goal),
      }));
    }
  },
} satisfies Partial<ProgressViewOutboundHandlerRegistry>;
