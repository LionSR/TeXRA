import { textDisplayWidth } from '@cli/runtime/terminalText';
import { clampCursor } from './textInputEditing';

interface TextInputDisplayWindow {
  readonly value: string;
  readonly cursor: number;
  readonly clipped: boolean;
}

interface TextInputDisplayRow {
  readonly start: number;
  readonly end: number;
  readonly breakKind: 'soft' | 'hard' | 'end';
}

interface LeadingEllipsisDisplay {
  readonly text: string;
  readonly removedPrefixCodeUnits: number;
}

function codePointAtIndex(
  value: string,
  index: number,
): { readonly char: string; readonly nextIndex: number } | undefined {
  const codePoint = value.codePointAt(index);
  if (codePoint === undefined) return undefined;
  const char = String.fromCodePoint(codePoint);
  return { char, nextIndex: index + char.length };
}

function isSoftBreakChar(char: string): boolean {
  return char !== '\n' && /\s/u.test(char);
}

function shouldWrapAtPreviousSoftBreak(
  width: number,
  column: number,
  lastSoftBreakColumn: number | undefined,
): boolean {
  if (lastSoftBreakColumn === undefined) return false;
  return column - lastSoftBreakColumn <= Math.max(8, Math.floor(width / 4));
}

function softBreakRunEnd(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const point = codePointAtIndex(value, index);
    if (point === undefined || !isSoftBreakChar(point.char)) break;
    index = point.nextIndex;
  }
  return index;
}

function appendSoftDisplayRow(
  rows: TextInputDisplayRow[],
  value: string,
  start: number,
  end: number,
): void {
  if (value.slice(start, end).trimEnd().length === 0) return;
  rows.push({ start, end, breakKind: 'soft' });
}

function textInputDisplayRows(
  value: string,
  width: number,
): TextInputDisplayRow[] {
  const rows: TextInputDisplayRow[] = [];
  let rowStart = 0;
  let column = 0;
  let lastSoftBreakIndex: number | undefined;
  let lastSoftBreakColumn: number | undefined;

  let index = 0;
  while (index < value.length) {
    const point = codePointAtIndex(value, index);
    if (point === undefined) break;

    if (point.char === '\n') {
      rows.push({ start: rowStart, end: index, breakKind: 'hard' });
      rowStart = point.nextIndex;
      index = point.nextIndex;
      column = 0;
      lastSoftBreakIndex = undefined;
      lastSoftBreakColumn = undefined;
      continue;
    }

    const charWidth = textDisplayWidth(point.char);
    if (column + charWidth > width && column > 0) {
      let wrapIndex = index;
      if (isSoftBreakChar(point.char)) {
        wrapIndex = softBreakRunEnd(value, index);
      } else if (
        lastSoftBreakIndex !== undefined &&
        lastSoftBreakIndex > rowStart &&
        shouldWrapAtPreviousSoftBreak(width, column, lastSoftBreakColumn)
      ) {
        wrapIndex = lastSoftBreakIndex;
      }
      appendSoftDisplayRow(rows, value, rowStart, wrapIndex);
      rowStart = wrapIndex;
      index = wrapIndex;
      column = 0;
      lastSoftBreakIndex = undefined;
      lastSoftBreakColumn = undefined;
      continue;
    }

    column += charWidth;
    if (isSoftBreakChar(point.char)) {
      lastSoftBreakIndex = point.nextIndex;
      lastSoftBreakColumn = column;
    }
    index = point.nextIndex;
  }

  if (rowStart < value.length || rows.at(-1)?.breakKind !== 'soft') {
    rows.push({ start: rowStart, end: value.length, breakKind: 'end' });
  }
  return rows;
}

function textInputDisplayRowValue(
  value: string,
  row: TextInputDisplayRow,
): string {
  const text = value.slice(row.start, row.end);
  return row.breakKind === 'soft' ? text.trimEnd() : text;
}

function cursorDisplayRowIndex(
  rows: readonly TextInputDisplayRow[],
  cursor: number,
): number {
  const rowIndex = rows.findIndex((row, index) => {
    if (cursor < row.start || cursor > row.end) return false;
    if (cursor === row.end && row.breakKind === 'soft') {
      return index === rows.length - 1;
    }
    return true;
  });
  return rowIndex < 0 ? Math.max(0, rows.length - 1) : rowIndex;
}

function leadingEllipsisDisplay(
  text: string,
  width: number,
): LeadingEllipsisDisplay {
  if (width <= 1) {
    return { text: '…', removedPrefixCodeUnits: text.length };
  }
  if (textDisplayWidth(text) < width) {
    return { text: `…${text}`, removedPrefixCodeUnits: 0 };
  }

  let suffix = '';
  for (const char of [...text].toReversed()) {
    const candidate = `${char}${suffix}`;
    if (textDisplayWidth(candidate) > width - textDisplayWidth('…')) break;
    suffix = candidate;
  }
  return {
    text: `…${suffix}`,
    removedPrefixCodeUnits: text.length - suffix.length,
  };
}

/** True when the soft-break last row already fills `columns`, so an
 *  end-of-value caret wraps onto its own visual line. Shared by the height
 *  estimator and the display window so the two cannot disagree. */
function lastDisplayRowIsFull(
  value: string,
  rows: readonly TextInputDisplayRow[],
  columns: number,
): boolean {
  const last = rows.at(-1);
  return (
    last !== undefined &&
    textDisplayWidth(textInputDisplayRowValue(value, last)) >= columns
  );
}

/** Wrapped text rows at `width`, without reserving space for a caret. */
export function textInputWrappedRowCount(value: string, width: number): number {
  return textInputDisplayRows(value, Math.max(1, width)).length;
}

/** Rows the input will occupy at `width`, using the same soft-break algorithm
 *  as {@link textInputDisplayWindow}. When the last row is exactly full, the
 *  end-of-value caret wraps to its own row. */
export function textInputDisplayRowCount(value: string, width: number): number {
  const columns = Math.max(1, width);
  const rows = textInputDisplayRows(value, columns);
  return rows.length + (lastDisplayRowIsFull(value, rows, columns) ? 1 : 0);
}

/**
 * Height to allocate for a height-capped text input (e.g. InputBar). Includes
 * the end-of-value caret wrap when it fits under `maxRows`.
 *
 * When the uncapped need exceeds `maxRows`, returns `maxRows` — callers must
 * pass the **same** value as `maxDisplayRows` so {@link textInputDisplayWindow}
 * can reserve one of those rows for the caret instead of painting five full
 * content rows and clipping the wrap under `overflowY="hidden"`.
 */
export function textInputCappedRowCount(
  value: string,
  width: number,
  maxRows: number,
): number {
  return Math.min(Math.max(1, maxRows), textInputDisplayRowCount(value, width));
}

export function textInputDisplayWindow({
  cursor,
  maxDisplayRows,
  value,
  width,
}: {
  readonly cursor: number;
  readonly maxDisplayRows?: number;
  readonly value: string;
  readonly width?: number;
}): TextInputDisplayWindow {
  if (maxDisplayRows === undefined || width === undefined) {
    return { value, cursor: clampCursor(cursor, value.length), clipped: false };
  }
  const rowCount = Math.max(1, maxDisplayRows);
  const columnCount = Math.max(1, width);

  const sourceCursor = clampCursor(cursor, value.length);
  const rows = textInputDisplayRows(value, columnCount);
  const cursorRowIndex = cursorDisplayRowIndex(rows, sourceCursor);
  // Height-capped callers must leave room for the EOF caret wrap on a full last row.
  const caretNeedsExtraRow =
    sourceCursor >= value.length &&
    lastDisplayRowIsFull(value, rows, columnCount);
  const contentRowBudget =
    caretNeedsExtraRow && rows.length >= rowCount
      ? Math.max(1, rowCount - 1)
      : rowCount;
  let startRow = 0;
  let endRow = rows.length;
  if (rows.length > contentRowBudget) {
    const keepRowsAfterCursor = Math.min(
      rows.length - cursorRowIndex - 1,
      Math.floor(contentRowBudget / 4),
    );
    endRow = Math.min(rows.length, cursorRowIndex + keepRowsAfterCursor + 1);
    startRow = Math.max(0, endRow - contentRowBudget);
  }
  const visibleRows = rows.slice(startRow, endRow);
  const clipped = startRow > 0 || endRow < rows.length;
  const rowTexts = visibleRows.map((row) =>
    textInputDisplayRowValue(value, row),
  );
  const displayCursorRow = Math.max(0, cursorRowIndex - startRow);
  const cursorRowTextLength = rowTexts[displayCursorRow]?.length ?? 0;
  let firstRowEllipsisRemovedPrefixCodeUnits = 0;
  if (startRow > 0) {
    const firstRow = leadingEllipsisDisplay(rowTexts[0] ?? '', columnCount);
    firstRowEllipsisRemovedPrefixCodeUnits = firstRow.removedPrefixCodeUnits;
    rowTexts[0] = firstRow.text;
  }
  const displayValue = rowTexts.join('\n');
  const cursorRow = visibleRows[displayCursorRow] ?? visibleRows.at(-1);
  const cursorColumn =
    cursorRow === undefined
      ? 0
      : clampCursor(sourceCursor - cursorRow.start, cursorRowTextLength);
  let ellipsisCursorColumn = cursorColumn;
  if (startRow > 0 && displayCursorRow === 0) {
    ellipsisCursorColumn =
      firstRowEllipsisRemovedPrefixCodeUnits > 0
        ? Math.max(1, cursorColumn - firstRowEllipsisRemovedPrefixCodeUnits + 1)
        : cursorColumn + 1;
  }
  const cursorPrefixLength = rowTexts
    .slice(0, displayCursorRow)
    .reduce((sum, row) => sum + row.length + 1, 0);

  return {
    value: displayValue,
    cursor: clampCursor(
      cursorPrefixLength + ellipsisCursorColumn,
      displayValue.length,
    ),
    clipped,
  };
}
