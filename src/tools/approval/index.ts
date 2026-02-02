/**
 * Unified approval system exports.
 *
 * This module serves as the coordination point for approval cleanup,
 * breaking the circular dependency between bashApproval and toolEditApproval.
 *
 * Import cleanup functions from here, not from individual modules.
 */

// Local imports - agent types

// Local file imports - individual approval modules
import {
  _rejectAllPendingBashApprovals,
  _rejectPendingBashApprovalsForStream,
} from './bashApproval';
import {
  _clearAllApprovalBypass,
  _clearApprovalBypassForStream,
  _rejectAllPendingToolEditApprovals,
  _rejectPendingToolEditApprovalsForStream,
} from './toolEditApproval';
import type { StreamTabId } from '@shared/schemas';

/**
 * Clean up all approval state for a deleted stream.
 * Handles pending approvals (tool edits + bash) and YOLO mode state.
 */
export function cleanupApprovalsForStream(streamId: StreamTabId): void {
  _rejectPendingToolEditApprovalsForStream(streamId);
  _rejectPendingBashApprovalsForStream(streamId);
  _clearApprovalBypassForStream(streamId);
}

/**
 * Clean up all approval state when deleting all streams.
 * Handles pending approvals (tool edits + bash) and YOLO mode state.
 */
export function cleanupAllApprovals(): void {
  _rejectAllPendingToolEditApprovals();
  _rejectAllPendingBashApprovals();
  _clearAllApprovalBypass();
}

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
  // Tool edit approval
  requestToolEditApproval,
  buildApprovalRejectedResult,
  handleProgressViewToolEditApprovalAction,
  initializeToolEditApproval,
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
