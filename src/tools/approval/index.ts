/**
 * Unified approval system exports.
 *
 * This module is the coordination point for approval cleanup so that
 * bash and tool-edit modules don't form a circular dependency.
 *
 * Import cleanup helpers from here, not from individual modules.
 */

import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';

import { bashApprovalController } from './bashApproval';
import { proposalApprovalState } from './proposalApproval';
import {
  toolEditApprovalController,
  enableYoloOnChildStream,
  inheritBashBypassOnChildStream,
} from './toolEditApproval';

/**
 * Clean up all approval state for a deleted stream.
 * Handles pending approvals (tool edits + bash), plan approvals, and YOLO mode state.
 */
export function cleanupApprovalsForStream(
  streamId: StreamTabId,
  session: SessionHandle = defaultSession(),
): void {
  toolEditApprovalController.rejectPendingForStream(streamId);
  bashApprovalController.rejectPendingForStream(streamId);
  toolEditApprovalController.bypass.clearForStream(streamId);
  bashApprovalController.bypass.clearForStream(streamId);
  proposalApprovalState.clearForStream(streamId);
  session.interactions.cancelForStream(streamId, 'Stream resources released.');
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
 * Reject pending tool-edit, bash, and user-question approvals that have no
 * concrete stream context (streamId is undefined or empty). These would
 * otherwise survive a per-stream {@link cleanupApprovalsForStream} loop
 * because they do not equal any concrete StreamTabId, only
 * {@link cleanupAllApprovals} catches them. Bypass and proposal state are
 * always streamId-keyed and are not affected here.
 *
 * Desktop `deleteAllStreams` calls this after the per-stream sweep so that
 * an approval emitted without a concrete stream is rejected rather than left
 * pending with no UI prompt to answer. Multi-session hosts pass their own
 * `runtimeHost` so sibling windows' streamless approvals stay intact.
 */
export function cleanupUnscopedApprovals(
  runtimeHost?: AgentRuntimeHost,
  session: SessionHandle = defaultSession(),
): void {
  toolEditApprovalController.rejectUnscopedPending(runtimeHost);
  bashApprovalController.rejectUnscopedPending(runtimeHost);
  session.interactions.cancelUnscoped?.('Streamless approval cleanup.');
}

/**
 * PROCESS-WIDE reset of all approval state — rejects every pending tool-edit /
 * bash / user-question approval, clears all bypass + proposal state, and
 * cancels `session`'s pending host interactions.
 *
 * The tool/bypass controllers are process-global and streamId-keyed, so this
 * `clearAll` touches EVERY session's streams. Safe only for single-session
 * hosts (the extension's default session), test reset, and process shutdown.
 * A MULTI-SESSION host (e.g. a desktop window) must NOT use this to delete its
 * own streams — it would wipe sibling windows' pending approvals; it scopes the
 * sweep to its own streams by looping {@link cleanupApprovalsForStream} instead.
 */
export function cleanupAllApprovals(
  session: SessionHandle = defaultSession(),
): void {
  toolEditApprovalController.rejectAllPending();
  bashApprovalController.rejectAllPending();
  toolEditApprovalController.bypass.clearAll();
  bashApprovalController.bypass.clearAll();
  proposalApprovalState.clearAll();
  session.interactions.cancelAll?.('All approvals cleared.');
}

export { enableYoloOnChildStream, inheritBashBypassOnChildStream };

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
  proposalApprovalState,
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
