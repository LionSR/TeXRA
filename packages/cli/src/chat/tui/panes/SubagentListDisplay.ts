// Local imports - shared formatting
import {
  COLOR_BORDER,
  COLOR_ERROR,
  COLOR_HINT,
  COLOR_SUCCESS,
  COLOR_WARNING,
} from '@cli/tui/ui/colors';
import { STATUS_DOT, TOKENS_GENERATED } from '@cli/tui/ui/glyphs';
import { fillRows } from '@cli/runtime/terminalText';
import { STREAM_PHASE, type WorkflowCallProgress } from '@shared/schemas';
import { workflowCallTally } from '@shared/copy/workflowCall';
import { filterNotNullish, formatCompactTokenCount } from '@utils/core';
import { formatResultCount } from '@utils/text/stringUtils';

// Local imports - TUI state and presentation
import { WORKFLOW_TASK_STATUS_STYLE } from './transcriptEntryLayout';
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

/** Display columns the workflow dashboard reserves for a row's status marker,
 *  counting the space that separates it from the focus pointer. */
const DASHBOARD_MARKER_COLUMNS = 3;

/**
 * The marker cell every workflow-dashboard row shares. The cell is filled to a
 * fixed column count by measured display width, so a marker the width helper
 * counts as two columns takes its own cell instead of shoving the label right
 * and leaving that row one column out of line with its neighbours.
 *
 * (A terminal whose East-Asian-Ambiguous table disagrees with the width helper
 * — `□`, `●` and `·` are Ambiguous — still draws such a glyph double-wide; no
 * padding computed on this side can see that, so glyph choice, not padding, is
 * the lever there.)
 */
export function dashboardMarkerCell(marker: string): string {
  return fillRows(` ${marker}`, DASHBOARD_MARKER_COLUMNS);
}

/**
 * `done/total · N running · N failed` for one phase's calls — the same fold the
 * progress view's phase headers render (`TaskGroupList.renderWorkflowCallTally`),
 * so the terminal and the board can never disagree on what a phase has done.
 */
export function workflowPhaseTallyText(
  calls: readonly WorkflowCallProgress[],
): string {
  const { done, total, running, failed } = workflowCallTally(calls);
  return [
    `${done}/${total}`,
    running > 0 ? `${running} running` : undefined,
    failed > 0 ? `${failed} failed` : undefined,
  ]
    .filter(filterNotNullish)
    .join(' · ');
}

/**
 * One glyph per issued call, in issue order — the terminal's counterpart to the
 * board's per-call status dots. The glyphs are the very markers the task rows
 * paint (`WORKFLOW_TASK_STATUS_STYLE`), so the strip and the rows below it can
 * never tell different stories. Past `maxCells` the strip ends in a `+N`
 * count rather than wrapping, so it stays one row at any width.
 */
export function workflowPhaseStatusStrip(
  calls: readonly WorkflowCallProgress[],
  maxCells: number,
): string | undefined {
  if (calls.length === 0) return undefined;
  const budget = Math.max(1, maxCells);
  if (calls.length <= budget) {
    return calls
      .map((call) => WORKFLOW_TASK_STATUS_STYLE[call.status].marker)
      .join('');
  }
  // Reserve the widest `+N` the hidden count can need, so the strip never
  // exceeds `maxCells` at a digit rollover.
  const shownCount = Math.max(1, budget - (1 + String(calls.length).length));
  const shown = calls
    .slice(0, shownCount)
    .map((call) => WORKFLOW_TASK_STATUS_STYLE[call.status].marker)
    .join('');
  return `${shown}+${calls.length - shownCount}`;
}
