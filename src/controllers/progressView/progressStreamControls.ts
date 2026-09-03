import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ApprovalBypassKind } from '@shared/approvalBypassKind';
import type { GoalState, StreamTabId } from '@shared/schemas';
import {
  isApprovalBypassedForStream,
  isBashApprovalBypassedForStream,
  proposalApprovals,
} from '@tools/approval';
import { GoalStore } from '@tools/goal';

/**
 * Per-stream control flags pushed to the progress view: approval bypass state
 * plus the goal chip state. A progress-view domain concept, owned here next to
 * the producer rather than inside the Lit renderer. `goal` is the same
 * canonical {@link GoalState} used by the wire projection
 * (`ControlsSectionSchema`) and tool-use stream state, so the one production
 * consumer (`LitSessionRenderer`) can forward this return value as-is.
 */
interface ProgressStreamControls {
  bypasses: Record<ApprovalBypassKind, boolean>;
  goal: GoalState;
}

export type GetProgressStreamControls = (
  stream: StreamTabId,
) => ProgressStreamControls;

export function getProgressStreamControls(
  streamId: StreamTabId,
  session?: SessionHandle,
): ProgressStreamControls {
  const goal = GoalStore.getForStream(streamId);
  return {
    bypasses: {
      bash: isBashApprovalBypassedForStream(streamId, session),
      toolEdit: isApprovalBypassedForStream(streamId, session),
      superYolo: proposalApprovals(session).isBypassed(streamId),
    },
    goal: goal
      ? { active: true, status: goal.status, objective: goal.objective }
      : { active: false },
  };
}
