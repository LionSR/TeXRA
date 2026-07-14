import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  currentSession,
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
 * Set the complete delegated-task approval mode for one stream.
 *
 * This is the shared meaning of the extension's legacy "Super Yolo" control:
 * later delegation proposals, file edits, and commands are all approved for
 * the same stream. The owning session is explicit so the grant cannot leak to
 * another CLI, extension, or desktop session.
 */
export function setDelegatedWorkApprovalBypasses(
  streamId: StreamTabId,
  enabled: boolean,
  runtimeHost: AgentRuntimeHost,
  session: SessionHandle = currentSession(),
): void {
  const { proposal, toolEdit, bash } = session.approvals;

  proposal.setBypass(streamId, enabled, runtimeHost);
  if (!enabled || !toolEdit.bypass.isBypassed(streamId)) {
    toolEdit.bypass.setBypass(streamId, enabled, runtimeHost);
  }
  bash.bypass.setBypass(streamId, enabled, runtimeHost, { silent: true });
}

/** Toggle the complete delegated-work approval mode for one stream. */
export function toggleDelegatedWorkApprovalBypasses(
  streamId: StreamTabId,
  runtimeHost: AgentRuntimeHost,
  session: SessionHandle = currentSession(),
): boolean {
  const enabled = !session.approvals.proposal.isBypassed(streamId);
  setDelegatedWorkApprovalBypasses(streamId, enabled, runtimeHost, session);
  return enabled;
}
