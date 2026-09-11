/**
 * Unified approval system exports.
 *
 * Approval queues, pending registries, and bypass state are owned per session
 * (`session.approvals`, #8144). The cleanup helpers here sweep exactly one
 * session's state; hosts pass their own session (desktop windows), while the
 * single-session hosts (extension, CLI) rely on the default session.
 */

import {
  currentSession,
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import type { RunApprovalBypass } from '@agent/runtime/runApprovalQueue';
import type { RunId } from '@shared/schemas';

/**
 * Per-stream bypass state for agent delegation proposals, owned by the
 * session (`session.approvals.proposal`).
 *
 * Proposals settle through the run coordinators rather than a stream approval
 * queue, so unlike bash / tool-edit there is no controller here — only the
 * session's bypass state. Resolves the calling context's session by default
 * (run session inside a run, otherwise the process default session);
 * multi-session hosts pass their own session explicitly.
 */
export function proposalApprovals(
  session: SessionHandle = currentSession(),
): RunApprovalBypass {
  return session.approvals.proposal;
}

/**
 * Link a freshly resolved child subagent stream to its parent for approval
 * bypass resolution.
 *
 * A child delegated by a parent that auto-runs bash or auto-approves edits
 * should do the same — and should keep following the parent when either
 * bypass is toggled *after* the child stream already started, since this
 * registers live ancestry links rather than copying the parent's values once
 * at child creation (see `registerRunParent`). Each bypass kind keeps its
 * own value, so the CLI's distinct AUTO-BASH / AUTO-APPROVE grants are
 * respected: a parent with AUTO-BASH but edits still gated propagates only
 * bash, and fresh runs default to gated either way. Delegation-proposal
 * bypass is inherited as well, so complete delegated-task approval remains
 * effective when an orchestrator delegates to another orchestrator. A child
 * may still override any inherited approval explicitly.
 */
export function configureDelegatedChildApprovals(
  childRunId: RunId,
  parentRunId?: RunId,
  policy: 'inherit' | 'auto-approved' = 'inherit',
  session: SessionHandle = currentSession(),
): void {
  if (parentRunId) {
    session.approvals.registerRunParent(childRunId, parentRunId);
  }
  // The child's `run.start` is published by the time this runs, so the
  // write is not pre-activation setup: it notifies the host and publishes
  // the child's `approval.policy` like any other bypass change.
  if (policy === 'auto-approved') {
    session.approvals.toolEdit.bypass.setBypass(childRunId, true);
  }
}

/**
 * Release all agent resources held for a deleted stream: approval state AND
 * the follow-up queue. Cancels pending host interactions;
 * `forgetRunAncestry` clears the stream's ancestry edges and its explicit
 * bypass values; `followUps.terminalize` drops the queue. These always need to
 * be cleared together when a stream is removed, so this is the single function
 * hosts should call.
 *
 * Host-specific teardown (webview state, backup files, goal store, etc.)
 * remains the caller's responsibility after this returns.
 */
export function releaseRunResources(
  runId: RunId,
  session: SessionHandle = defaultSession(),
): void {
  session.interactions.cancel({
    runId,
    cause: 'Stream resources released.',
  });
  session.approvals.forgetRunAncestry(runId);
  session.followUps.terminalize(runId);
}
