/** Pure row allocation and visibility policy for the root CLI TUI layout. */

import { TODO_STATUS, type StreamTabId, type TodoItem } from '@shared/schemas';
import { clamp } from '@utils/core';
import { SLASH_PALETTE_ROWS } from './commands/SlashPalette';
import { REVERSE_SEARCH_ROWS } from './input/ReverseSearch';

const FOREGROUND_TRANSCRIPT_ROWS = 1;
const MIN_FOREGROUND_ROWS_WITH_TRANSCRIPT = 6;
const COMPACT_STATIC_TRANSCRIPT_MAX_ROWS = 14;
const COMPACT_LIVE_TRANSCRIPT_RESERVE_ROWS = 2;

export const PINNED_CHROME_ROWS = {
  input: 3,
  status: 2,
} as const;

function pinnedChromeRows({
  inputVisible = true,
  inputRows = PINNED_CHROME_ROWS.input,
  queuedFollowUpPanelRows = 0,
  reverseSearchOpen,
  slashPaletteOpen,
  staticTranscriptRows = 0,
}: {
  readonly inputVisible?: boolean;
  /** Measured input-bar height (borders + windowed draft rows). Defaults to
   *  the single-line height; a multi-line draft reports its real height so
   *  the transcript shrinks instead of the frame outgrowing the terminal. */
  readonly inputRows?: number;
  readonly queuedFollowUpPanelRows?: number;
  readonly reverseSearchOpen: boolean;
  readonly slashPaletteOpen: boolean;
  readonly staticTranscriptRows?: number;
}): number {
  const baseRows =
    PINNED_CHROME_ROWS.status +
    (inputVisible ? inputRows : 0) +
    queuedFollowUpPanelRows +
    staticTranscriptRows;
  return (
    baseRows +
    (slashPaletteOpen ? SLASH_PALETTE_ROWS : 0) +
    (reverseSearchOpen ? REVERSE_SEARCH_ROWS : 0)
  );
}

export function allocateMiddleRows({
  foregroundMaxRows,
  foregroundOpen,
  inputVisible = true,
  inputRows,
  queuedFollowUpPanelRows = 0,
  reverseSearchOpen,
  rows,
  slashPaletteOpen,
  staticTranscriptRows = 0,
}: {
  readonly foregroundMaxRows?: number;
  readonly foregroundOpen: boolean;
  readonly inputVisible?: boolean;
  readonly inputRows?: number;
  readonly queuedFollowUpPanelRows?: number;
  readonly reverseSearchOpen: boolean;
  readonly rows: number;
  readonly slashPaletteOpen: boolean;
  readonly staticTranscriptRows?: number;
}): {
  readonly foregroundRows: number;
  readonly transcriptRows: number;
} {
  const availableRows = Math.max(
    0,
    rows -
      pinnedChromeRows({
        inputVisible,
        inputRows,
        queuedFollowUpPanelRows,
        reverseSearchOpen,
        slashPaletteOpen,
        staticTranscriptRows,
      }),
  );
  if (!foregroundOpen) {
    return { foregroundRows: 0, transcriptRows: availableRows };
  }
  if (availableRows === 0) {
    return { foregroundRows: 0, transcriptRows: 0 };
  }
  if (availableRows === 1) {
    return { foregroundRows: 1, transcriptRows: 0 };
  }

  const transcriptRows =
    availableRows >= MIN_FOREGROUND_ROWS_WITH_TRANSCRIPT
      ? Math.min(FOREGROUND_TRANSCRIPT_ROWS, availableRows - 1)
      : 0;
  const foregroundRows = availableRows - transcriptRows;
  return {
    // The early returns above and transcript reservation keep this at least 1,
    // so the lower clamp bound cannot inflate an empty foreground.
    foregroundRows:
      foregroundMaxRows === undefined
        ? foregroundRows
        : clamp(foregroundMaxRows, 1, foregroundRows),
    transcriptRows,
  };
}

export function allocateConversationBottomPanelRows({
  maxRows,
  sessionCount,
  childListFocused,
  minimumSessionPanelRows = 2,
  todosPlanContentRows,
  transcriptRows,
}: {
  readonly maxRows: number;
  readonly sessionCount: number;
  readonly childListFocused: boolean;
  readonly minimumSessionPanelRows?: number;
  readonly todosPlanContentRows: number;
  readonly transcriptRows: number;
}): {
  readonly bottomPanelRows: number;
  readonly sessionPanelRows: number;
  readonly todosPlanRows: number;
} {
  const availableTranscriptRows = Math.max(0, transcriptRows);
  const none = { bottomPanelRows: 0, sessionPanelRows: 0, todosPlanRows: 0 };
  // Exactly one bottom panel exists at a time. Child sessions already have a
  // compact count and navigation affordance in the status bar, so their list
  // stays collapsed until the user focuses it — a large workflow must not take
  // transcript space merely because it is running in the background — and the
  // todos/plan panel hides while the list has focus
  // (`shouldShowTodosPlanPanel`). Each panel owns one separator row above its
  // content, and a lone row cannot hold separator plus content.
  if (childListFocused) {
    if (sessionCount === 0) return none;
    const rows = Math.min(maxRows, sessionCount + 1, availableTranscriptRows);
    if (rows < minimumSessionPanelRows) return none;
    return { bottomPanelRows: rows, sessionPanelRows: rows, todosPlanRows: 0 };
  }
  if (todosPlanContentRows === 0) return none;
  const rows = Math.min(
    maxRows,
    todosPlanContentRows + 1,
    Math.floor(availableTranscriptRows / 2),
  );
  if (rows < 2) return none;
  return { bottomPanelRows: rows, sessionPanelRows: 0, todosPlanRows: rows };
}

export function allocateConversationPanelRows({
  maxRows,
  sessionCount,
  childListFocused,
  minimumSessionPanelRows = 2,
  todosPlanContentRows,
  transcriptRows,
}: {
  readonly maxRows: number;
  readonly sessionCount: number;
  readonly childListFocused: boolean;
  readonly minimumSessionPanelRows?: number;
  readonly todosPlanContentRows: number;
  readonly transcriptRows: number;
}): {
  readonly bottomPanelRows: number;
  readonly conversationRows: number;
  readonly sessionPanelRows: number;
  readonly todosPlanRows: number;
} {
  const availableTranscriptRows = Math.max(0, transcriptRows);
  const bottomPanels = allocateConversationBottomPanelRows({
    maxRows,
    sessionCount,
    childListFocused,
    minimumSessionPanelRows,
    todosPlanContentRows,
    transcriptRows: Math.max(0, availableTranscriptRows - 1),
  });
  return {
    ...bottomPanels,
    conversationRows: availableTranscriptRows - bottomPanels.bottomPanelRows,
  };
}

export function staticTranscriptRowBudget({
  footerRows,
  foregroundOpen,
  queuedFollowUpPanelRows = 0,
  rows,
}: {
  readonly footerRows: number;
  readonly foregroundOpen: boolean;
  readonly queuedFollowUpPanelRows?: number;
  readonly rows: number;
}): number | undefined {
  if (foregroundOpen || rows > COMPACT_STATIC_TRANSCRIPT_MAX_ROWS) {
    return undefined;
  }
  const optionalRows = rows - footerRows - queuedFollowUpPanelRows;
  const liveTranscriptReserveRows = Math.min(
    COMPACT_LIVE_TRANSCRIPT_RESERVE_ROWS,
    Math.max(0, optionalRows),
  );
  return Math.max(0, optionalRows - liveTranscriptReserveRows);
}

export interface StaticScrollbackTarget {
  readonly ownerKey: string;
  readonly streamId: StreamTabId | undefined;
}

export function staticScrollbackTarget({
  activeStreamId,
  rootStreamId,
  scopedTranscript = false,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly rootStreamId: StreamTabId | undefined;
  readonly scopedTranscript?: boolean;
}): StaticScrollbackTarget {
  if (scopedTranscript) {
    return {
      ownerKey: activeStreamId ? `stream:${activeStreamId}` : 'scoped:none',
      streamId: activeStreamId,
    };
  }
  // Before a root run resolves, local helper output and harness-built root
  // streams still need static scrollback. The root owner key is deliberately
  // stable across the later rootStreamId resolution so Ink's append-only
  // <Static> cache does not remount and reprint pre-run root entries.
  return {
    ownerKey: 'root',
    streamId: rootStreamId ?? activeStreamId,
  };
}

export function shouldShowTodosPlanPanel({
  childListFocused,
  foregroundOpen,
  hasPlan,
  todos,
}: {
  /** The focused child list is the only bottom panel; todos yield to it. */
  readonly childListFocused: boolean;
  readonly foregroundOpen: boolean;
  readonly hasPlan: boolean;
  readonly todos: readonly TodoItem[];
}): boolean {
  if (foregroundOpen || childListFocused) return false;
  if (hasPlan) return true;
  return todos.some((todo) => todo.status !== TODO_STATUS.COMPLETED);
}
