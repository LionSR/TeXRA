import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ProgressStreamControls } from '@controllers/progressView/backend/events/ProgressFactApplier';
import type { StreamTabId } from '@shared/schemas';
import {
  isApprovalBypassedForStream,
  proposalApprovals,
} from '@tools/approval';
import { GoalStore } from '@tools/goal';

export function getProgressStreamControls(
  streamId: StreamTabId,
  session?: SessionHandle,
): ProgressStreamControls {
  const goal = GoalStore.getForStream(streamId);
  const bypasses = {
    toolEditBypass: isApprovalBypassedForStream(streamId, session),
    superYoloBypass: proposalApprovals(session).isBypassed(streamId),
  };
  if (!goal) {
    return { ...bypasses, goalActive: false };
  }
  return {
    ...bypasses,
    goalActive: true,
    goalStatus: goal.status,
    goalObjective: goal.objective,
  };
}
