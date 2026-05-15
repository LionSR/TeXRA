/**
 * Unified approval system exports.
 *
 * This module is the coordination point for approval cleanup so that
 * bash and tool-edit modules don't form a circular dependency.
 *
 * Import cleanup helpers from here, not from individual modules.
 */

import {
  cleanupAllCoordinatorRequests,
  cleanupCoordinatorRequestsForStream,
} from '@agent/runtime/runCoordinators';
import type { StreamTabId } from '@shared/schemas';
import {
  _rejectAllPendingInquiries,
  _rejectPendingInquiriesForStream,
} from '@tools/inquiry';
import {
  _rejectAllPendingUserQuestions,
  _rejectPendingUserQuestionsForStream,
} from '@tools/userQuestion';

import { bashApprovalController } from './bashApproval';
import {
  _clearAllProposalBypass,
  _clearProposalBypassForStream,
} from './proposalApproval';
import {
  toolEditApprovalController,
  enableYoloOnChildStream,
} from './toolEditApproval';

/**
 * Clean up all approval state for a deleted stream.
 * Handles pending approvals (tool edits + bash), plan approvals, and YOLO mode state.
 */
export function cleanupApprovalsForStream(streamId: StreamTabId): void {
  toolEditApprovalController.rejectPendingForStream(streamId);
  bashApprovalController.rejectPendingForStream(streamId);
  _rejectPendingInquiriesForStream(streamId);
  _rejectPendingUserQuestionsForStream(streamId);
  toolEditApprovalController.clearBypassForStream(streamId);
  _clearProposalBypassForStream(streamId);
  cleanupCoordinatorRequestsForStream(streamId);
}

/**
 * Clean up all approval state when deleting all streams.
 * Handles pending approvals (tool edits + bash), plan approvals, and YOLO mode state.
 */
export function cleanupAllApprovals(): void {
  toolEditApprovalController.rejectAllPending();
  bashApprovalController.rejectAllPending();
  _rejectAllPendingInquiries();
  _rejectAllPendingUserQuestions();
  toolEditApprovalController.clearAllBypass();
  _clearAllProposalBypass();
  cleanupAllCoordinatorRequests();
}

export { enableYoloOnChildStream };

// Re-export commonly used functions from individual modules
export {
  // Bash approval
  requestBashApproval,
  buildBashApprovalRejectedResult,
  handleProgressViewBashApprovalAction,
  BASH_APPROVAL_CONFIG_KEY,
  BASH_APPROVAL_ACTIONS,
  type BashApprovalAction,
  type BashApprovalRequest,
  type BashApprovalResult,
} from './bashApproval';

export {
  // Proposal approval
  toggleProposalBypass,
  isProposalBypassedForStream,
} from './proposalApproval';

export {
  // Tool edit approval
  requestToolEditApproval,
  buildApprovalRejectedResult,
  setToolEditApprovalHandler,
  setToolEditApprovalSessionBypass,
  toggleToolEditApprovalSessionBypass,
  isApprovalBypassedForStream,
  getApprovedContent,
  writeApprovedContent,
  formatUnifiedApprovalUserDiff,
  TOOL_EDIT_APPROVAL_CONFIG_KEY,
  TOOL_EDIT_APPROVAL_ACTIONS,
  type ToolEditApprovalAction,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
  type WriteApprovedContentResult,
} from './toolEditApproval';
