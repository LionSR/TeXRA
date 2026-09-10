import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunId } from '@shared/schemas';

export type GoalAutoApprovalScope = 'commands' | 'allAgentWork';

/**
 * Apply one goal's selected approval scope, or clear every goal grant.
 * Commands-only remains the default: an approved plan is not consent to edit
 * files or launch delegated work unless the user explicitly enables the
 * broader scope. Descendants inherit each bypass through session ancestry.
 */
export async function setGoalSessionAutoApproval(
  runId: RunId,
  scope: GoalAutoApprovalScope | false,
  options?: { session?: SessionHandle },
): Promise<void> {
  // Keep this lazy: a static SessionHandle import pulls host runtime into the
  // host-neutral goal graph and breaks tests that install partial logger mocks.
  const session =
    options?.session ??
    (await import('@agent/runtime/SessionHandle')).currentSession();
  if (scope === 'allAgentWork') {
    session.approvals.setDelegatedWorkBypasses(runId, true);
  } else if (scope === 'commands') {
    // Retargeting from all-agent-work must revoke the broad grants without
    // publishing a transient command revocation immediately before re-enable.
    session.approvals.toolEdit.bypass.setBypass(runId, false);
    session.approvals.proposal.setBypass(runId, false);
    session.approvals.bash.bypass.setBypass(runId, true);
  } else {
    session.approvals.setDelegatedWorkBypasses(runId, false);
  }
}
