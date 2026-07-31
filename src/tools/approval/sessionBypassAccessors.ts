import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import type { StreamApprovalBypass } from '@agent/runtime/streamApprovalQueue';
import type { StreamTabId } from '@shared/schemas';

/**
 * Build the get/set session-bypass accessor pair shared by every approval
 * kind (bash, tool-edit, …): each kind only differs in which
 * `StreamApprovalBypass` it reads off `session.approvals`.
 */
export function createSessionBypassAccessors(
  selectBypass: (session: SessionHandle) => StreamApprovalBypass,
): {
  setSessionBypass: (
    streamId: StreamTabId,
    enabled: boolean,
    options?: { silent?: boolean; session?: SessionHandle },
  ) => void;
  isBypassedForStream: (
    streamId: StreamTabId,
    session?: SessionHandle,
  ) => boolean;
} {
  return {
    setSessionBypass(streamId, enabled, options) {
      selectBypass(options?.session ?? currentSession()).setBypass(
        streamId,
        enabled,
        options,
      );
    },
    isBypassedForStream(streamId, session = currentSession()) {
      return selectBypass(session).isBypassed(streamId);
    },
  };
}
