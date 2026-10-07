/**
 * Unified approval system exports.
 *
 * Approval lanes are owned per session (`session.approvals`, #8144); a run's
 * grants are its `approval.policy` rows.
 */

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  NO_APPROVAL_GRANTS,
  type ApprovalGrants,
} from '@shared/approvalBypassKind';
import type { RunId } from '@shared/schemas';

/** How a delegation was approved, as the child's own grants record it:
 *  by the user's one-off answer (`inherit`), or by the run's proposal
 *  bypass, a human's (`auto-approved`) or an autonomous goal's. */
export type DelegatedChildApproval =
  'inherit' | 'auto-approved' | 'goal-approved';

/**
 * The grants a delegated child is registered with, stamped on its
 * `run.start`. Beyond them it inherits its parent's live grants through the
 * parent edge, kind by kind, so the CLI's distinct AUTO-BASH and
 * AUTO-APPROVE grants reach it exactly as set, and a toggle on the parent
 * after the child started reaches it too. A child a goal's grant approved
 * gets a goal grant of its own, never a human value, so a resume leaves it
 * off until a human re-arms the goal.
 */
export function delegatedChildGrants(
  approval: DelegatedChildApproval,
): ApprovalGrants {
  switch (approval) {
    case 'inherit':
      return NO_APPROVAL_GRANTS;
    case 'auto-approved':
      return { own: { toolEdit: 'on' }, goal: [] };
    case 'goal-approved':
      return { own: {}, goal: ['toolEdit'] };
  }
}

/**
 * Release what this process holds for a deleted run: its follow-up queue.
 * Its grants go with its rows, and its open requests with the fold's
 * tombstone. Host-specific teardown (webview state, backup files, goal
 * store, etc.) remains the caller's responsibility after this returns.
 */
export function releaseRunResources(
  runId: RunId,
  session: SessionHandle,
): void {
  session.followUps.forget(runId);
}
