// Local imports - shared formatting
import { formatCompactTokenCount } from '@utils/core';
import { formatResultCount } from '@utils/text/stringUtils';

// Local imports - TUI rendering and state
import { truncateSummaryToWidth } from '../render/terminalText';

// Local imports - TUI state and presentation
import { isChildExecutionErrorStatus } from '../state/childExecutionStatus';
import {
  COLOR_BORDER,
  COLOR_ERROR,
  COLOR_SUCCESS,
  COLOR_WARNING,
} from '../ui/colors';
import { STATUS_DOT, TOKENS_GENERATED } from '../ui/glyphs';
import type { PendingApprovalKind } from '../state/approvalQueue';
import type { StreamFileMetadata } from '../state/cliState';

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

const FILE_CATEGORIES = [
  ['input', 'in', 'Input'],
  ['context', 'ctx', 'Context'],
  ['media', 'media', 'Media'],
  ['output', 'out', 'Output'],
] as const satisfies readonly (readonly [
  keyof StreamFileMetadata,
  string,
  string,
])[];

/** Derive both file surfaces from one role ordering. Row callers omit
 *  `detailMaxColumns` and therefore pay only for the compact badge; the
 *  expanded panel requests its bounded detail lines from the same API. */
export function childFileDisplay(
  files: StreamFileMetadata | undefined,
  detailMaxColumns?: number,
): {
  readonly badge: string | undefined;
  readonly detailLines: readonly string[];
} {
  if (!files) return { badge: undefined, detailLines: [] };
  const populated = FILE_CATEGORIES.filter(([key]) => files[key].length > 0);
  const badge = populated.map(
    ([key, label]) => `${label}:${files[key].length}`,
  );
  const detailLines =
    detailMaxColumns === undefined
      ? []
      : populated.map(([key, , label]) =>
          truncateSummaryToWidth(
            `${label}  ${files[key].join(', ')}`,
            detailMaxColumns,
          ),
        );
  return {
    badge: badge.length > 0 ? badge.join(' ') : undefined,
    detailLines,
  };
}
