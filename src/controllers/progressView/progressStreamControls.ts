import { getRuntimeApprovalBypassStatus } from '@agent/runtime/approvalCommands';
import { getRuntimeGoalControlState } from '@agent/runtime/goalCommands';
import type { StreamTabId } from '@shared/schemas';
import type { ProgressStreamControls } from '@shared/progressView/backend/events/ProgressEventHandler';

export function getProgressStreamControls(
  streamId: StreamTabId,
): ProgressStreamControls {
  const goal = getRuntimeGoalControlState(streamId);
  const approvalBypass = getRuntimeApprovalBypassStatus(streamId);
  return {
    toolEditBypass: approvalBypass.toolEditBypass,
    superYoloBypass: approvalBypass.delegatedTaskBypass,
    goalActive: goal.active,
    ...(goal.active
      ? { goalStatus: goal.status, goalObjective: goal.objective }
      : {}),
  };
}
