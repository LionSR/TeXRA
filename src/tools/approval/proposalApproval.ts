import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import type { StreamApprovalBypass } from '@agent/runtime/streamApprovalQueue';

/**
 * Per-stream bypass state for agent delegation proposals (super-YOLO), owned
 * by the session (`session.approvals.proposal`).
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
