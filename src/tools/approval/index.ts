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
import type { StreamTabId } from '@shared/schemas';

/**
 * Link a freshly resolved child subagent stream to its parent for bash and
 * tool-edit bypass resolution.
 *
 * A child delegated by a parent that auto-runs bash or auto-approves edits
 * should do the same — and should keep following the parent when either
 * bypass is toggled *after* the child stream already started, since this
 * registers live ancestry links rather than copying the parent's values once
 * at child creation (see `registerStreamParent`). Ancestry is tracked per
 * bypass kind, so the CLI's distinct AUTO-BASH / AUTO-APPROVE grants are
 * respected: a parent with AUTO-BASH but edits still gated propagates only
 * bash, and fresh streams default to gated either way. Delegation-proposal
 * (super-YOLO) bypass is deliberately NOT linked — a child's own delegations
 * still prompt unless granted on the child explicitly (and
 * `setDelegatedWorkApprovalBypasses` pins the child's own explicit entries,
 * so that grant survives the parent later re-gating).
 */
export function inheritApprovalBypassesOnChildStream(
  childStreamId: StreamTabId,
  parentStreamId?: StreamTabId,
  session: SessionHandle = currentSession(),
): void {
  if (parentStreamId) {
    session.approvals.registerStreamParent(childStreamId, parentStreamId, [
      'bash',
      'toolEdit',
    ]);
  }
}

/**
 * Clean up all approval state for a deleted stream in the owning session.
 * Handles pending approvals (tool edits + bash), plan approvals, and YOLO mode state.
 */
export function cleanupApprovalsForStream(
  streamId: StreamTabId,
  session: SessionHandle = defaultSession(),
): void {
  const { toolEdit, bash, proposal } = session.approvals;
  toolEdit.rejectPendingForStream(streamId);
  bash.rejectPendingForStream(streamId);
  toolEdit.bypass.clearForStream(streamId);
  bash.bypass.clearForStream(streamId);
  proposal.clearForStream(streamId);
  session.approvals.forgetStreamAncestry(streamId);
  session.interactions.cancel({
    streamId,
    cause: 'Stream resources released.',
  });
}

/**
 * Release all agent resources held for a deleted stream: approval state
 * (pending approvals, bypass flags, pending host interactions) AND the
 * follow-up queue. These two always need to be cleared together when a stream is
 * removed, so this is the single function hosts should call instead of
 * combining {@link cleanupApprovalsForStream} + `session.followUps.release`
 * manually.
 *
 * Host-specific teardown (webview state, backup files, goal store, etc.)
 * remains the caller's responsibility after this returns.
 */
export function releaseStreamResources(
  streamId: StreamTabId,
  session: SessionHandle = defaultSession(),
): void {
  cleanupApprovalsForStream(streamId, session);
  session.followUps.release(streamId);
}

/**
 * Reject pending tool-edit, bash, and user-question approvals in `session`
 * that have no concrete stream context (streamId is undefined or empty).
 * These would otherwise survive a per-stream
 * {@link cleanupApprovalsForStream} loop because they do not equal any
 * concrete StreamTabId. Bypass and proposal state are always streamId-keyed
 * and are not affected here.
 *
 * Desktop `deleteAllStreams` calls this after the per-stream sweep so that
 * an approval emitted without a concrete stream is rejected rather than left
 * pending with no UI prompt to answer. Approval registries are session-owned,
 * so sibling windows' streamless approvals stay intact.
 */
export function cleanupUnscopedApprovals(
  session: SessionHandle = defaultSession(),
): void {
  session.approvals.toolEdit.rejectUnscopedPending();
  session.approvals.bash.rejectUnscopedPending();
  session.interactions.cancel({
    streamId: null,
    cause: 'Streamless approval cleanup.',
  });
}

/**
 * Session-wide reset of approval state — rejects every pending tool-edit /
 * bash / user-question approval in `session`, clears all of its bypass +
 * proposal state, and cancels its pending host interactions.
 *
 * Approval state is session-owned, so this never touches another session:
 * one desktop window's reset cannot wipe a sibling window's pending
 * approvals. For the extension and CLI the default session covers the whole
 * process.
 */
export function cleanupAllApprovals(
  session: SessionHandle = defaultSession(),
): void {
  session.approvals.rejectAndClearAll();
  session.interactions.cancel({ cause: 'All approvals cleared.' });
}

// Re-export commonly used functions from individual modules
export {
  // Bash approval
  setBashApprovalSessionBypass,
  toggleBashApprovalSessionBypass,
  isBashApprovalBypassedForStream,
  type BashApprovalRequest,
  type BashApprovalResult,
} from './bashApproval';

export {
  // Proposal approval
  proposalApprovals,
  setDelegatedWorkApprovalBypasses,
} from './proposalApproval';

export {
  // Tool edit approval
  setToolEditApprovalSessionBypass,
  toggleToolEditApprovalSessionBypass,
  isApprovalBypassedForStream,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
  type WriteApprovedContentResult,
} from './toolEditApproval';
