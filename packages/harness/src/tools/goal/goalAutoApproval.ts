import {
  goalGrant,
  type GrantWriteError,
} from '@agent/runtime/runApprovalQueue';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ApprovalBypassKind } from '@shared/approvalBypassKind';
import type { RunId } from '@shared/schemas';
import type { Effect } from 'effect';

export type GoalAutoApprovalScope = 'commands' | 'allAgentWork';

const SCOPE_KINDS: Record<
  GoalAutoApprovalScope,
  readonly ApprovalBypassKind[]
> = {
  commands: ['bash'],
  allAgentWork: ['superYolo', 'toolEdit', 'bash'],
};

/**
 * Apply one goal's selected approval scope, or end its grant, as the run's
 * next grants. The goal's grant sits over the run's human values without
 * replacing them, so ending it
 * leaves the latest human choice standing, and a human decision on a kind
 * during the goal ends that kind's grant. Commands-only remains the default:
 * an approved plan is not consent to edit files or launch delegated work
 * unless the user explicitly enables the broader scope. Descendants inherit
 * each bypass through session ancestry.
 */
export const setGoalSessionAutoApproval = (
  session: SessionHandle,
  runId: RunId,
  scope: GoalAutoApprovalScope | false,
): Effect.Effect<void, GrantWriteError> =>
  session.approvals.change(
    runId,
    goalGrant(scope === false ? [] : SCOPE_KINDS[scope]),
  );
