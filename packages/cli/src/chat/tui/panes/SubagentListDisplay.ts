// Local imports - shared formatting
import {
  COLOR_BORDER,
  COLOR_ERROR,
  COLOR_HINT,
  COLOR_SUCCESS,
  COLOR_WARNING,
} from '@cli/tui/ui/colors';
import { STATUS_DOT } from '@cli/tui/ui/glyphs';
import type { StreamView } from '@shared/session/sessionView';
import { TOKENS_GENERATED } from '@shared/copy/workflowCall';
import { formatCompactTokenCount } from '@utils/core';
import { formatResultCount } from '@utils/text/stringUtils';

// Local imports - TUI state
import type { PendingApprovalKind } from '../state/approvalQueue';

/** The fold owns status meaning; terminal colors express only its tone. */
export const CHILD_TONE_COLOR: Readonly<Record<StreamView['tone'], string>> =
  Object.freeze({
    running: COLOR_HINT,
    warning: COLOR_WARNING,
    danger: COLOR_ERROR,
    success: COLOR_SUCCESS,
    neutral: COLOR_BORDER,
  });

/** A steady marker, so list updates never animate the whole live region. */
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

/** Compact "waiting on what" display for a row. The first kind and overflow
 * count are separate so narrow layouts can preserve the actionable kind while
 * allowing the informational count to yield. */
export function pendingApprovalRowDisplay(
  kinds: readonly PendingApprovalKind[] | undefined,
):
  | { readonly label: string; readonly overflow: string | undefined }
  | undefined {
  const first = kinds?.[0];
  if (kinds === undefined || first === undefined) return undefined;
  return {
    label: PENDING_APPROVAL_ROW_LABELS[first],
    overflow: kinds.length > 1 ? `+${kinds.length - 1}` : undefined,
  };
}
