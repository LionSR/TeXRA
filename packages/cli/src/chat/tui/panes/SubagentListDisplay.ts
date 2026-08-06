// Local imports - shared formatting
import {
  COLOR_BORDER,
  COLOR_ERROR,
  COLOR_HINT,
  COLOR_SUCCESS,
  COLOR_WARNING,
} from '@cli/tui/ui/colors';
import { STATUS_DOT, TOKENS_GENERATED } from '@cli/tui/ui/glyphs';
import { STREAM_PHASE } from '@shared/schemas';
import { formatCompactTokenCount } from '@utils/core';
import { formatResultCount } from '@utils/text/stringUtils';

// Local imports - TUI state and presentation
import type { PendingApprovalKind } from '../state/approvalQueue';

/** Row-dot color for a child stream's phase.
 *
 * Failed (red) and cancelled (neutral) read the same here and in the webview
 * status dot; completed and waiting deliberately do not. A terminal row scrolls
 * away and carries no other affordance, so the CLI spends color on "this one
 * finished" (green) and "this one wants you" (yellow), where the webview keeps
 * both quiet and lets its own chrome carry that. Running is cyan — the same
 * color the workflow-task rows and transcript task markers use for in-flight
 * work — so a still-running child never reads as finished. A user stop is
 * neither success nor error, so it stays neutral in both. */
export function childStatusColor(status: string | undefined): string {
  if (status === STREAM_PHASE.WAITING) {
    return COLOR_WARNING;
  }
  if (status === STREAM_PHASE.FAILED) return COLOR_ERROR;
  if (status === STREAM_PHASE.RUNNING) return COLOR_HINT;
  if (status === STREAM_PHASE.COMPLETED) return COLOR_SUCCESS;
  // Everything else is neutral: a user stop, a stream that has not reported a
  // phase yet, and any phase a future build adds. Green would report success
  // for a state nobody established.
  return COLOR_BORDER;
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
  planApproval: 'plan',
  proposal: 'proposal',
  retry: 'retry',
  externalInquiry: 'inquiry',
  userQuestion: 'question',
};

/** Terminal width below which the right-aligned metadata column is dropped
 *  and rows keep their inline elapsed, so identity is not crowded out. */
export const CHILD_ROW_METADATA_MIN_COLUMNS = 60;

/** At this width the workflow dashboard has room for independently navigable
 * phase and task panes; below it, source-ordered tasks use the full row. */
export const WORKFLOW_DASHBOARD_WIDE_MIN_COLUMNS = 100;

/** Right-aligned metadata column for a child row: elapsed time, the number of
 *  tool calls the child has made, and its generated tokens so far (e.g.
 *  `2m 30s · 5 tool calls · ↓40k`). This is the per-agent stats summary a
 *  workflow-script run's `agent()` grandchildren surface when the run is
 *  focused; a plain subagent with no tool calls yet just shows elapsed/tokens.
 *  Output tokens are the "work produced" figure — deliberately not the
 *  context-fill number the status bar reports for the focused stream. */
export function childRowMetadataText({
  elapsed,
  outputTokens,
  toolCallCount,
}: {
  readonly elapsed: string | null | undefined;
  readonly outputTokens: number | undefined;
  readonly toolCallCount?: number | undefined;
}): string | undefined {
  const toolCalls =
    toolCallCount !== undefined && toolCallCount > 0
      ? formatResultCount(toolCallCount, 'tool call')
      : undefined;
  const tokens =
    outputTokens !== undefined && outputTokens > 0
      ? `${TOKENS_GENERATED}${formatCompactTokenCount(outputTokens)}`
      : undefined;
  const parts = [elapsed, toolCalls, tokens].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

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
