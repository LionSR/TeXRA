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
import type { StreamApprovalBypass } from '@agent/runtime/streamApprovalQueue';
import type { StreamTabId } from '@shared/schemas';

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
): StreamApprovalBypass {
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
 * at child creation (see `registerStreamParent`). Bypass values stay
 * independent per kind, so the CLI's distinct AUTO-BASH / AUTO-APPROVE grants
 * are respected: a parent with AUTO-BASH but edits still gated propagates
 * only bash, and fresh streams default to gated either way. Delegation-proposal
 * bypass is linked as well, so complete delegated-task approval remains
 * effective when an orchestrator delegates to another orchestrator. A child
 * may still override any inherited approval explicitly.
 */
export function configureDelegatedChildApprovals(
  childStreamId: StreamTabId,
  parentStreamId?: StreamTabId,
  policy: 'inherit' | 'auto-approved' = 'inherit',
  session: SessionHandle = currentSession(),
): void {
  if (parentStreamId) {
    session.approvals.registerStreamParent(childStreamId, parentStreamId);
  }
  if (policy === 'auto-approved') {
    session.approvals.toolEdit.bypass.setBypass(childStreamId, true, {
      silent: true,
    });
  }
}

/**
 * Clean up all approval state for a deleted stream in the owning session.
 * Cancels pending host interactions and clears stream-scoped bypass state.
 */
export function cleanupApprovalsForStream(
  streamId: StreamTabId,
  session: SessionHandle = defaultSession(),
): void {
  const { toolEdit, bash, proposal } = session.approvals;
  session.interactions.cancel({
    streamId,
    cause: 'Stream resources released.',
  });
  session.approvals.forgetStreamAncestry(streamId);
  toolEdit.bypass.clearForStream(streamId);
  bash.bypass.clearForStream(streamId);
  proposal.clearForStream(streamId);
}

/**
 * Release all agent resources held for a deleted stream: approval state
 * (bypass flags and pending host interactions) AND the follow-up queue. These
 * two always need to be cleared together when a stream is removed, so this is
 * the single function hosts should call instead of
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
  session.followUps.terminalize(streamId);
}

/**
 * Cancel pending host interactions in `session` that have no concrete stream
 * context (streamId is undefined or empty). These would otherwise survive a
 * per-stream {@link cleanupApprovalsForStream} loop because they do not equal
 * any concrete StreamTabId. Bypass and proposal state are always
 * streamId-keyed and are not affected here.
 *
 * Desktop `deleteAllStreams` calls this after the per-stream sweep so that
 * an approval emitted without a concrete stream is rejected rather than left
 * pending with no UI prompt to answer. Interaction state is session-owned, so
 * sibling windows' streamless approvals stay intact.
 */
export function cleanupUnscopedApprovals(
  session: SessionHandle = defaultSession(),
): void {
  session.interactions.cancel({
    streamId: null,
    cause: 'Streamless approval cleanup.',
  });
}

// Re-export commonly used functions from individual modules
export {
  // Bash approval
  setBashApprovalSessionBypass,
  isBashApprovalBypassedForStream,
} from './bashApproval';

export {
  // Tool edit approval
  setToolEditApprovalSessionBypass,
  isApprovalBypassedForStream,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from './toolEditApproval';
