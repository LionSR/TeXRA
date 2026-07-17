// Scroll/tail state machine for TaskDetailView.
//
// This can't reuse `useScrollableOffset.ts`: task-detail output wraps each tail
// line to the available columns, so the visible window is expressed in wrapped
// rows while a resize reflows line-to-row counts underneath a raw offset.
// The `anchor` (logical line index + wrapped-row-within-line) is what lets a
// mid-scroll position survive that reflow instead of drifting.

import { clamp } from '@utils/core';
import { wrapAnsiToWidth } from '../render/ansiWrap';

export interface TaskDetailScrollState {
  readonly anchor?: TaskDetailScrollAnchor;
  readonly executionId: string;
  readonly followsTail: boolean;
  readonly offset: number;
}

interface TaskDetailScrollAnchor {
  readonly lineIndex: number;
  readonly wrappedRowOffset: number;
}

export interface TaskDetailScrollContext {
  readonly availableColumns?: number;
  readonly compact: boolean;
  readonly tailLines: readonly string[];
}

const TASK_DETAIL_HORIZONTAL_CHROME_COLUMNS = 4;

function taskDetailOutputColumnCount(
  availableColumns: number | undefined,
): number | undefined {
  return availableColumns === undefined
    ? undefined
    : Math.max(1, availableColumns - TASK_DETAIL_HORIZONTAL_CHROME_COLUMNS);
}

function taskDetailWrappedRowCount(
  line: string,
  outputColumns: number | undefined,
): number {
  if (outputColumns === undefined) return 1;
  return Math.max(1, wrapAnsiToWidth(line, outputColumns).split('\n').length);
}

export function taskDetailScrollableOutputRowCountForColumns({
  availableColumns,
  compact,
  tailLines,
}: {
  readonly availableColumns?: number;
  readonly compact: boolean;
  readonly tailLines: readonly string[];
}): number {
  if (!compact) return tailLines.length;

  const outputColumns = taskDetailOutputColumnCount(availableColumns);
  if (outputColumns === undefined) return tailLines.length;

  return tailLines.reduce(
    (total, line) => total + taskDetailWrappedRowCount(line, outputColumns),
    0,
  );
}

export function taskDetailFollowTailScrollOffsetForColumns({
  availableColumns,
  compact,
  tailLines,
  visibleRowBudget,
}: {
  readonly availableColumns?: number;
  readonly compact: boolean;
  readonly tailLines: readonly string[];
  readonly visibleRowBudget: number;
}): number {
  const scrollableRows = taskDetailScrollableOutputRowCountForColumns({
    availableColumns,
    compact,
    tailLines,
  });
  return taskDetailInitialScrollOffset(scrollableRows, visibleRowBudget);
}

export function taskDetailVisibleOutputRowsFromOffsetForColumns({
  availableColumns,
  compact,
  offset,
  tailLines,
  visibleRowBudget,
}: {
  readonly availableColumns?: number;
  readonly compact: boolean;
  readonly offset: number;
  readonly tailLines: readonly string[];
  readonly visibleRowBudget: number;
}): readonly string[] {
  if (visibleRowBudget <= 0) return [];
  if (!compact) return tailLines.slice(offset, offset + visibleRowBudget);

  const outputColumns = taskDetailOutputColumnCount(availableColumns);
  const start = Math.max(0, offset);
  if (outputColumns === undefined) {
    return tailLines.slice(start, start + visibleRowBudget);
  }

  const rows = tailLines.flatMap((line) =>
    wrapAnsiToWidth(line, outputColumns).split('\n'),
  );
  return rows.slice(start, start + visibleRowBudget);
}

export function taskDetailInitialScrollOffset(
  tailLineCount: number,
  visibleLineCount: number,
): number {
  return Math.max(0, tailLineCount - Math.max(0, visibleLineCount));
}

function taskDetailLineRowCount(
  context: TaskDetailScrollContext,
  lineIndex: number,
): number {
  if (!context.compact) return 1;
  return taskDetailWrappedRowCount(
    context.tailLines[lineIndex] ?? '',
    taskDetailOutputColumnCount(context.availableColumns),
  );
}

function taskDetailScrollAnchorFromOffset(
  context: TaskDetailScrollContext,
  offset: number,
): TaskDetailScrollAnchor | undefined {
  if (context.tailLines.length === 0) return undefined;

  let remainingRows = Math.max(0, offset);
  for (
    let lineIndex = 0;
    lineIndex < context.tailLines.length;
    lineIndex += 1
  ) {
    const rowCount = taskDetailLineRowCount(context, lineIndex);
    if (remainingRows < rowCount) {
      return { lineIndex, wrappedRowOffset: remainingRows };
    }
    remainingRows -= rowCount;
  }

  const lineIndex = context.tailLines.length - 1;
  return {
    lineIndex,
    wrappedRowOffset: Math.max(
      0,
      taskDetailLineRowCount(context, lineIndex) - 1,
    ),
  };
}

function taskDetailScrollOffsetFromAnchor(
  context: TaskDetailScrollContext,
  anchor: TaskDetailScrollAnchor,
  maxOffset: number,
): number {
  if (context.tailLines.length === 0) return 0;

  const lineIndex = Math.min(
    Math.max(0, anchor.lineIndex),
    context.tailLines.length - 1,
  );
  let offset = 0;
  for (let index = 0; index < lineIndex; index += 1) {
    offset += taskDetailLineRowCount(context, index);
  }
  const rowCount = taskDetailLineRowCount(context, lineIndex);
  offset += clamp(anchor.wrappedRowOffset, 0, rowCount - 1);
  return Math.min(offset, maxOffset);
}

export function taskDetailScrollContextKey(
  context: TaskDetailScrollContext,
): string {
  return [
    context.availableColumns,
    context.compact ? 1 : 0,
    ...context.tailLines.map((_, lineIndex) =>
      taskDetailLineRowCount(context, lineIndex),
    ),
  ].join(':');
}

export function syncTaskDetailScrollState(
  state: TaskDetailScrollState,
  executionId: string,
  maxOffset: number,
  followOffset = maxOffset,
  context?: TaskDetailScrollContext,
): TaskDetailScrollState {
  const clampedFollowOffset = Math.min(followOffset, maxOffset);
  if (state.executionId !== executionId) {
    return { executionId, followsTail: true, offset: clampedFollowOffset };
  }
  if (state.followsTail) {
    return {
      executionId: state.executionId,
      followsTail: state.followsTail,
      offset: clampedFollowOffset,
    };
  }
  if (context && state.anchor) {
    return {
      ...state,
      offset: taskDetailScrollOffsetFromAnchor(
        context,
        state.anchor,
        maxOffset,
      ),
    };
  }
  return { ...state, offset: Math.min(state.offset, maxOffset) };
}

export function taskDetailVisibleScrollOffset(
  state: TaskDetailScrollState,
  maxOffset: number,
  followOffset = maxOffset,
  context?: TaskDetailScrollContext,
): number {
  if (state.followsTail) return Math.min(followOffset, maxOffset);
  if (context && state.anchor) {
    return taskDetailScrollOffsetFromAnchor(context, state.anchor, maxOffset);
  }
  return Math.min(state.offset, maxOffset);
}

function taskDetailScrollOffsetFollowsTail(
  offset: number,
  maxOffset: number,
  followOffset = maxOffset,
): boolean {
  return offset === Math.min(followOffset, maxOffset);
}

function taskDetailScrollStateAtOffset(
  state: TaskDetailScrollState,
  maxOffset: number,
  nextOffset: number,
  followOffset = maxOffset,
  context?: TaskDetailScrollContext,
): TaskDetailScrollState {
  const clampedOffset = clamp(nextOffset, 0, maxOffset);
  const followsTail = taskDetailScrollOffsetFollowsTail(
    clampedOffset,
    maxOffset,
    followOffset,
  );
  let anchor: TaskDetailScrollAnchor | undefined;
  if (followsTail) {
    anchor = undefined;
  } else if (context) {
    anchor = taskDetailScrollAnchorFromOffset(context, clampedOffset);
  } else {
    anchor = state.anchor;
  }
  return {
    executionId: state.executionId,
    followsTail,
    offset: clampedOffset,
    ...(anchor ? { anchor } : {}),
  };
}

export function moveTaskDetailScrollState(
  state: TaskDetailScrollState,
  maxOffset: number,
  direction: 'down' | 'up',
  followOffset = maxOffset,
  context?: TaskDetailScrollContext,
): TaskDetailScrollState {
  const offset = taskDetailVisibleScrollOffset(
    state,
    maxOffset,
    followOffset,
    context,
  );
  const nextOffset = direction === 'up' ? offset - 1 : offset + 1;
  return taskDetailScrollStateAtOffset(
    state,
    maxOffset,
    nextOffset,
    followOffset,
    context,
  );
}

/** PgUp/PgDn: move by a page (the visible row budget) instead of a single
 *  row. Mirrors `moveTaskDetailScrollState`, just with a configurable step. */
export function pageTaskDetailScrollState(
  state: TaskDetailScrollState,
  maxOffset: number,
  direction: 'down' | 'up',
  pageSize: number,
  followOffset = maxOffset,
  context?: TaskDetailScrollContext,
): TaskDetailScrollState {
  const offset = taskDetailVisibleScrollOffset(
    state,
    maxOffset,
    followOffset,
    context,
  );
  const step = Math.max(1, pageSize);
  const nextOffset = direction === 'up' ? offset - step : offset + step;
  return taskDetailScrollStateAtOffset(
    state,
    maxOffset,
    nextOffset,
    followOffset,
    context,
  );
}

/** g/G: jump straight to the top or back to the tail. */
export function jumpTaskDetailScrollState(
  state: TaskDetailScrollState,
  maxOffset: number,
  target: 'bottom' | 'top',
  followOffset = maxOffset,
  context?: TaskDetailScrollContext,
): TaskDetailScrollState {
  const nextOffset = target === 'top' ? 0 : followOffset;
  return taskDetailScrollStateAtOffset(
    state,
    maxOffset,
    nextOffset,
    followOffset,
    context,
  );
}
