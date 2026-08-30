import type { SessionHandle } from '@agent/runtime/SessionHandle';
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
 * canonical {@link GoalState} the wire projection (`ControlsSectionSchema`)
 * and `deriveGoalState` use, so the one production consumer
 * (`LitSessionRenderer`) can forward this return value as-is instead of
 * re-flattening and re-deriving it.
 */
interface ProgressStreamControls {
  bashBypass: boolean;
  toolEditBypass: boolean;
  superYoloBypass: boolean;
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
    bashBypass: isBashApprovalBypassedForStream(streamId, session),
    toolEditBypass: isApprovalBypassedForStream(streamId, session),
    superYoloBypass: proposalApprovals(session).isBypassed(streamId),
    goal: goal
      ? { active: true, status: goal.status, objective: goal.objective }
      : { active: false },
  };
}
