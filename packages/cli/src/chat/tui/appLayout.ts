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

export function allocateSidePanelRows({
  subagentContentRows,
  todosPlanContentRows,
  rows,
}: {
  readonly subagentContentRows: number;
  readonly todosPlanContentRows: number;
  readonly rows: number;
}): {
  readonly subagentRows: number;
  readonly todosPlanRows: number;
} {
  const available = Math.max(0, rows);
  const subagentNeed = Math.max(0, subagentContentRows);
  const todosNeed = Math.max(0, todosPlanContentRows);
  if (available === 0 || subagentNeed + todosNeed === 0) {
    return { subagentRows: 0, todosPlanRows: 0 };
  }
  // Everything fits: each panel gets exactly what its content needs.
  if (subagentNeed + todosNeed <= available) {
    return { subagentRows: subagentNeed, todosPlanRows: todosNeed };
  }
  // Over budget: a panel with no content gets nothing, a lone panel takes all.
  if (subagentNeed === 0) return { subagentRows: 0, todosPlanRows: available };
  if (todosNeed === 0) return { subagentRows: available, todosPlanRows: 0 };
  // Both present and over budget: keep at least one row each, split the rest
  // proportionally to need. At a single row the todo/plan panel wins.
  if (available === 1) return { subagentRows: 0, todosPlanRows: 1 };
  const subagentRows = Math.min(
    available - 1,
    Math.max(
      1,
      Math.round((subagentNeed / (subagentNeed + todosNeed)) * available),
    ),
  );
  return { subagentRows, todosPlanRows: available - subagentRows };
}

/**
 * Reserve one live conversation row before skills and other bottom panels
 * divide the remaining transcript budget.
 */
export function allocateConversationAuxiliaryRows({
  desiredSkillsRows,
  transcriptRows,
}: {
  readonly desiredSkillsRows: number;
  readonly transcriptRows: number;
}): { readonly skillsRows: number; readonly otherPanelRows: number } {
  const available = Math.max(0, transcriptRows);
  const auxiliaryRows = Math.max(0, available - 1);
  const skillsRows = Math.min(Math.max(0, desiredSkillsRows), auxiliaryRows);
  return {
    skillsRows,
    otherPanelRows: auxiliaryRows - skillsRows,
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
  // Child sessions already have a compact count and navigation affordance in
  // the status bar. Keep their rows collapsed until the user focuses the
  // list; a large workflow must not take transcript space merely because it
  // is running in the background.
  const childListRowCount = childListFocused ? sessionCount : 0;
  // The expanded child list owns one blank separator row above its Select.
  const sessionPanelContentRows =
    childListRowCount > 0 ? childListRowCount + 1 : 0;
  // The todos/plan panel likewise owns a separator row above its checklist.
  const todosPanelContentRows =
    todosPlanContentRows > 0 ? todosPlanContentRows + 1 : 0;
  const minimumSessionRows =
    childListRowCount > 0 ? minimumSessionPanelRows : 0;
  const availableTranscriptRows = Math.max(0, transcriptRows);
  let panelTranscriptLimit: number;
  if (childListFocused) {
    panelTranscriptLimit = availableTranscriptRows;
  } else if (availableTranscriptRows === 0) {
    panelTranscriptLimit = 0;
  } else {
    const unfocusedLimit = Math.floor(availableTranscriptRows / 2);
    panelTranscriptLimit =
      availableTranscriptRows >= minimumSessionRows
        ? Math.max(minimumSessionRows, unfocusedLimit)
        : unfocusedLimit;
  }
  if (
    sessionPanelContentRows > 0 &&
    todosPanelContentRows === 0 &&
    panelTranscriptLimit < minimumSessionRows
  ) {
    return {
      bottomPanelRows: 0,
      sessionPanelRows: 0,
      todosPlanRows: 0,
    };
  }
  const bottomPanelRows = Math.min(
    maxRows,
    sessionPanelContentRows + todosPanelContentRows,
    panelTranscriptLimit,
  );
  const allocated = allocateSidePanelRows({
    subagentContentRows: sessionPanelContentRows,
    todosPlanContentRows: todosPanelContentRows,
    rows: bottomPanelRows,
  });
  const sessionPanelRows =
    allocated.subagentRows > 0 &&
    bottomPanelRows >= minimumSessionRows &&
    (childListRowCount > 0 || childListFocused) &&
    sessionPanelContentRows > 0
      ? Math.max(minimumSessionRows, allocated.subagentRows)
      : 0;
  let finalBottomPanelRows = bottomPanelRows;
  let finalSessionPanelRows = sessionPanelRows;
  let todosPlanRows = bottomPanelRows - sessionPanelRows;
  // A lone row cannot hold the separator plus content; hand it back instead
  // of rendering a dead blank line under the child list. When the child list
  // has rows above its own minimum, transfer one first so both panels remain
  // useful under a proportional split.
  if (todosPanelContentRows > 0 && todosPlanRows === 1) {
    if (sessionPanelRows > minimumSessionRows) {
      finalSessionPanelRows -= 1;
      todosPlanRows = 2;
    } else {
      finalBottomPanelRows -= 1;
      todosPlanRows = 0;
    }
  }
  return {
    bottomPanelRows: finalBottomPanelRows,
    sessionPanelRows: finalSessionPanelRows,
    todosPlanRows,
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
  foregroundOpen,
  hasPlan,
  todos,
}: {
  readonly foregroundOpen: boolean;
  readonly hasPlan: boolean;
  readonly todos: readonly TodoItem[];
}): boolean {
  if (foregroundOpen) return false;
  if (hasPlan) return true;
  return todos.some((todo) => todo.status !== TODO_STATUS.COMPLETED);
}
