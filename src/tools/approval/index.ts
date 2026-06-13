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
import type { StreamTabId } from '@shared/schemas';
import {
  _rejectAllPendingUserQuestions,
  _rejectPendingUserQuestionsForStream,
} from '@tools/userQuestion';

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
  _rejectPendingUserQuestionsForStream(streamId);
  toolEditApprovalController.bypass.clearForStream(streamId);
  bashApprovalController.bypass.clearForStream(streamId);
  proposalApprovalState.clearForStream(streamId);
  session.coordinators.cleanupRequestsForStream(streamId);
}

/**
 * PROCESS-WIDE reset of all approval state — rejects every pending tool-edit /
 * bash / user-question approval, clears all bypass + proposal state, and clears
 * `session`'s coordinator requests.
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
  _rejectAllPendingUserQuestions();
  toolEditApprovalController.bypass.clearAll();
  bashApprovalController.bypass.clearAll();
  proposalApprovalState.clearAll();
  session.coordinators.cleanupAllRequests();
}

export { enableYoloOnChildStream, inheritBashBypassOnChildStream };

// Re-export commonly used functions from individual modules
export {
  // Bash approval
  handleProgressViewBashApprovalAction,
  setBashApprovalSessionBypass,
  toggleBashApprovalSessionBypass,
  isBashApprovalBypassedForStream,
  type BashApprovalAction,
  type BashApprovalRequest,
  type BashApprovalResult,
} from './bashApproval';

export {
  // Proposal approval
  proposalApprovalState,
} from './proposalApproval';

export {
  // Tool edit approval
  setToolEditApprovalHandler,
  setToolEditApprovalSessionBypass,
  toggleToolEditApprovalSessionBypass,
  isApprovalBypassedForStream,
  type ToolEditApprovalAction,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
  type WriteApprovedContentResult,
} from './toolEditApproval';
