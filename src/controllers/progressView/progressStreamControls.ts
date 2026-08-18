import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { GoalStatus, StreamTabId } from '@shared/schemas';
import {
  isApprovalBypassedForStream,
  isBashApprovalBypassedForStream,
  proposalApprovals,
} from '@tools/approval';
import { GoalStore } from '@tools/goal';

/**
 * Per-stream control flags pushed to the progress view: approval bypass state
 * plus the goal chip state. A progress-view domain concept, owned here next to
 * the producer rather than inside the Lit renderer.
 */
interface ProgressStreamBypassControls {
  bashBypass: boolean;
  toolEditBypass: boolean;
  superYoloBypass: boolean;
}

export type ProgressStreamControls = ProgressStreamBypassControls &
  (
    | { goalActive: false }
    | { goalActive: true; goalStatus: GoalStatus; goalObjective: string }
  );

export type GetProgressStreamControls = (
  stream: StreamTabId,
) => ProgressStreamControls;

export function getProgressStreamControls(
  streamId: StreamTabId,
  session?: SessionHandle,
): ProgressStreamControls {
  const goal = GoalStore.getForStream(streamId);
  const bypasses = {
    bashBypass: isBashApprovalBypassedForStream(streamId, session),
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
