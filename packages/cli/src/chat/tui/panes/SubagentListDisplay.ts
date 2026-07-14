// Local imports - shared stream identity
import type { StreamTabId } from '@shared/schemas';

// Local imports - TUI state and presentation
import { isChildExecutionErrorStatus } from '../state/childExecutionStatus';
import {
  COLOR_BORDER,
  COLOR_ERROR,
  COLOR_SUCCESS,
  COLOR_WARNING,
} from '../ui/colors';
import { STATUS_DOT } from '../ui/glyphs';
import type { StreamView } from '../state/streamViews';

export function resolveSessionSelectionId(
  sessions: readonly StreamView[],
  selectedStreamId: StreamTabId | undefined,
  activeStreamId: StreamTabId | undefined,
): StreamTabId | undefined {
  if (sessions.some((session) => session.id === selectedStreamId)) {
    return selectedStreamId;
  }
  if (sessions.some((session) => session.id === activeStreamId)) {
    return activeStreamId;
  }
  return sessions[0]?.id;
}

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
