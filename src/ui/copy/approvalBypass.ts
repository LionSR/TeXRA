import type { ApprovalBypassKind } from '@shared/approvalBypassKind';

/**
 * Host-visible labels for per-stream approval-bypass grants. CLI status-bar
 * badges and the extension/desktop run-toolbar toggles share these so the
 * three kinds stay named the same way: AUTO-TASK, AUTO-BASH, AUTO-EDIT.
 */
export const APPROVAL_BYPASS_BADGE = Object.freeze({
  superYolo: 'AUTO-TASK',
  bash: 'AUTO-BASH',
  toolEdit: 'AUTO-EDIT',
} as const satisfies Record<ApprovalBypassKind, string>);
