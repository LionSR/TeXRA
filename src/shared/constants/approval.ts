/**
 * Approval action constants shared between extension and webview.
 *
 * @module @shared/constants/approval
 */

/** All valid approval actions for tool edit prompts */
export const APPROVAL_ACTIONS = [
  'approve',
  'reject',
  'openDiff',
  'approveAll',
  'rejectAll',
] as const;

export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];
