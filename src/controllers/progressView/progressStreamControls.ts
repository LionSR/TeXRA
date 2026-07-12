import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';
import { isGoalInFlight } from '@shared/schemas/goal';
import {
  isApprovalBypassedForStream,
  proposalApprovals,
} from '@tools/approval';
import { GoalStore } from '@tools/goal';
import type { ProgressStreamControls } from '@controllers/progressView/backend/events/ProgressFactApplier';

export function getProgressStreamControls(
  streamId: StreamTabId,
  session?: SessionHandle,
): ProgressStreamControls {
  const goal = GoalStore.getForStream(streamId);
  const goalActive = isGoalInFlight(goal);
  return {
    toolEditBypass: isApprovalBypassedForStream(streamId, session),
    superYoloBypass: proposalApprovals(session).isBypassed(streamId),
    goalActive,
    ...(goalActive && goal
      ? { goalStatus: goal.status, goalObjective: goal.objective }
      : {}),
  };
}
