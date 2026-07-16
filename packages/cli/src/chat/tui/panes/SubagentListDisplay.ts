// Local imports - TUI state and presentation
import { isChildExecutionErrorStatus } from '../state/childExecutionStatus';
import {
  COLOR_BORDER,
  COLOR_ERROR,
  COLOR_SUCCESS,
  COLOR_WARNING,
} from '../ui/colors';
import { STATUS_DOT } from '../ui/glyphs';
import type { PendingApprovalKind } from '../state/approvalQueue';

export function childStatusColor(status: string | undefined): string {
  if (!status) return COLOR_SUCCESS;
  if (status === 'waiting' || status === 'idle') return COLOR_WARNING;
  if (isChildExecutionErrorStatus(status)) return COLOR_ERROR;
  // A user stop is neither success nor error — show it neutral, matching the
  // progress view / webview (gray), not green (which reads as completed).
  // `stopped` remains accepted for historical snapshots.
  if (status === 'cancelled' || status === 'stopped') return COLOR_BORDER;
  return COLOR_SUCCESS;
}

// A steady marker — intentionally NOT animated. A blinking dot forced the whole
// live region (including the stable Todos/Plan panel below it) to repaint twice
// a second for the entire lifetime of a long-running async subagent, and Ink's
// non-alt-screen repaint can leave stale glyphs behind on those reprints. Status
// is conveyed by `childStatusColor`, and liveness by the `running · Ns` text, so
// the animation bought churn without information.
export const CHILD_STATUS_MARKER = `${STATUS_DOT} `;

const PENDING_APPROVAL_ROW_LABELS: Record<PendingApprovalKind, string> = {
  bash: 'bash',
  toolEdit: 'edit',
  plan: 'plan',
  proposal: 'proposal',
  retry: 'retry',
  externalInquiry: 'inquiry',
  userQuestion: 'question',
};

/** One-word "waiting on what" suffix for a session row: the row's first
 *  pending approval kind, plus a `+N` overflow when more are queued. */
export function pendingApprovalRowSuffix(
  kinds: readonly PendingApprovalKind[] | undefined,
): string | undefined {
  const first = kinds?.[0];
  if (kinds === undefined || first === undefined) return undefined;
  const label = PENDING_APPROVAL_ROW_LABELS[first];
  return kinds.length > 1 ? `${label} +${kinds.length - 1}` : label;
}
