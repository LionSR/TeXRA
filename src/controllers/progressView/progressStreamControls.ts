import type { StreamTabId } from '@shared/schemas';
import { isGoalInFlight } from '@shared/schemas/goal';
import {
  isApprovalBypassedForStream,
  proposalApprovalState,
} from '@tools/approval';
import { GoalStore } from '@tools/goal';
import type { ProgressStreamControls } from '@controllers/progressView/backend/events/ProgressFactApplier';

export function getProgressStreamControls(
  streamId: StreamTabId,
): ProgressStreamControls {
  const goal = GoalStore.getForStream(streamId);
  const goalActive = isGoalInFlight(goal);
  return {
    toolEditBypass: isApprovalBypassedForStream(streamId),
    superYoloBypass: proposalApprovalState.isBypassed(streamId),
    goalActive,
    ...(goalActive && goal
      ? { goalStatus: goal.status, goalObjective: goal.objective }
      : {}),
  };
}
