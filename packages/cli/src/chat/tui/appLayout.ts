/** Pure row allocation and visibility policy for the root CLI TUI layout. */

import {
  TODO_STATUS,
  type StreamPhase,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import { isActivePhase } from '@shared/streams/streamStatus';
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
  queuedFollowUpPanelRows = 0,
  reverseSearchOpen,
  slashPaletteOpen,
  staticTranscriptRows = 0,
}: {
  readonly inputVisible?: boolean;
  readonly queuedFollowUpPanelRows?: number;
  readonly reverseSearchOpen: boolean;
  readonly slashPaletteOpen: boolean;
  readonly staticTranscriptRows?: number;
}): number {
  const baseRows =
    PINNED_CHROME_ROWS.status +
    (inputVisible ? PINNED_CHROME_ROWS.input : 0) +
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
  queuedFollowUpPanelRows = 0,
  reverseSearchOpen,
  reserveTranscriptRows = true,
  rows,
  slashPaletteOpen,
  staticTranscriptRows = 0,
}: {
  readonly foregroundMaxRows?: number;
  readonly foregroundOpen: boolean;
  readonly inputVisible?: boolean;
  readonly queuedFollowUpPanelRows?: number;
  readonly reverseSearchOpen: boolean;
  readonly reserveTranscriptRows?: boolean;
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
    reserveTranscriptRows &&
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

export function allocateConversationBottomPanelRows({
  maxRows,
  processCount = 0,
  sessionCount,
  sessionListFocused,
  todosPlanContentRows,
  transcriptRows,
}: {
  readonly maxRows: number;
  readonly processCount?: number;
  readonly sessionCount: number;
  readonly sessionListFocused: boolean;
  readonly todosPlanContentRows: number;
  readonly transcriptRows: number;
}): {
  readonly bottomPanelRows: number;
  readonly sessionPanelRows: number;
  /** One blank row rendered above the panel so it doesn't sit flush against
   *  the footer chrome. Counted inside `bottomPanelRows` so the input bar
   *  can never be pushed off-screen by the spacer. */
  readonly spacerRows: number;
  readonly todosPlanRows: number;
} {
  const sessionPanelContentRows = sessionCount + processCount;
  const minimumSessionRows = sessionCount > 1 ? 1 : 0;
  const availableTranscriptRows = Math.max(0, transcriptRows);
  let panelTranscriptLimit: number;
  if (sessionListFocused) {
    panelTranscriptLimit = availableTranscriptRows;
  } else if (availableTranscriptRows === 0) {
    panelTranscriptLimit = 0;
  } else {
    panelTranscriptLimit = Math.max(
      minimumSessionRows,
      Math.floor(availableTranscriptRows / 2),
    );
  }
  const contentPanelRows = Math.min(
    maxRows,
    sessionPanelContentRows + todosPlanContentRows,
    panelTranscriptLimit,
  );
  // The breathing row is spent only when the panel has content AND the
  // transcript limit leaves room beyond the content itself — a tight budget
  // keeps every row for real content.
  const spacerRows =
    contentPanelRows > 0 && panelTranscriptLimit > contentPanelRows ? 1 : 0;
  const allocated = allocateSidePanelRows({
    subagentContentRows: sessionPanelContentRows,
    todosPlanContentRows,
    rows: contentPanelRows,
  });
  const sessionPanelRows =
    (sessionCount > 1 || sessionListFocused) &&
    sessionPanelContentRows > 0 &&
    contentPanelRows > 0
      ? Math.max(1, allocated.subagentRows)
      : allocated.subagentRows;
  return {
    bottomPanelRows: contentPanelRows + spacerRows,
    sessionPanelRows,
    spacerRows,
    todosPlanRows: contentPanelRows - sessionPanelRows,
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
  status,
  todos,
}: {
  readonly foregroundOpen: boolean;
  readonly hasPlan: boolean;
  readonly status: StreamPhase | undefined;
  readonly todos: readonly TodoItem[];
}): boolean {
  if (foregroundOpen) return false;
  const hasTodos = todos.length > 0;
  if (!hasTodos && !hasPlan) return false;
  if (
    hasTodos &&
    todos.every((todo) => todo.status === TODO_STATUS.COMPLETED)
  ) {
    return false;
  }
  return isActivePhase(status);
}
