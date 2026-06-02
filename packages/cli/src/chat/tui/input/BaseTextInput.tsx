// Native Ink 7 text input.
//
// Built directly on `useInput` + `usePaste` — no `ink-text-input` dependency.
// usePaste auto-enables bracketed paste mode so multi-line pastes arrive as
// a single string and never trigger `onSubmit` on the first embedded `\n`.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, useInput, usePaste } from 'ink';

import {
  clampCursor,
  deleteAtCursor,
  deleteBeforeCursor,
  deletePreviousWord,
  deleteToEnd,
  deleteToStart,
  applyTerminalInputChunk,
  insertText,
  maskDisplayValue,
  type TextEdit,
} from './textInputEditing';
import {
  isPlainReturnInput,
  isShiftReturnInput,
  isCtrlInput,
  isEscapeInput,
  isUnhandledControlInput,
  metaChordInput,
} from './inputKeys';

export interface BaseTextInputProps {
  readonly value: string;
  readonly placeholder?: string;
  readonly focus?: boolean;
  /** Clamp the rendered value to this many terminal rows while preserving
   *  the full editable value passed to onChange/onSubmit. */
  readonly maxDisplayRows?: number;
  readonly displayWidth?: number;
  /** Pin the caret externally. When omitted, the component tracks the caret
   *  internally so arrow keys / Home/End / Ctrl-A,E,U,K,W work out of the box. */
  readonly cursor?: number;
  readonly onCursorChange?: (cursor: number) => void;
  readonly onSubmit: (value: string) => void;
  readonly onInputChunkSubmit?: (value: string) => void;
  readonly onChange: (value: string) => void;
  /** Render the value as bullets (secret entry, e.g. an API key). Display-only:
   *  the captured value, edits, and paste are unaffected. */
  readonly masked?: boolean;
}

export interface TextInputDisplayWindow {
  readonly value: string;
  readonly cursor: number;
  readonly clipped: boolean;
}

interface TextInputDisplayRow {
  readonly start: number;
  readonly end: number;
  readonly breakKind: 'soft' | 'hard' | 'end';
}

function textInputDisplayRows(
  value: string,
  width: number,
): TextInputDisplayRow[] {
  const rows: TextInputDisplayRow[] = [];
  let rowStart = 0;
  let column = 0;

  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (ch === '\n') {
      rows.push({ start: rowStart, end: index, breakKind: 'hard' });
      rowStart = index + 1;
      column = 0;
      continue;
    }
    if (column === width) {
      rows.push({ start: rowStart, end: index, breakKind: 'soft' });
      rowStart = index;
      column = 0;
    }
    column += 1;
  }

  rows.push({ start: rowStart, end: value.length, breakKind: 'end' });
  return rows;
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

function leadingEllipsisText(text: string, width: number): string {
  if (width <= 1) return '…';
  return text.length >= width ? `…${text.slice(1)}` : `…${text}`;
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
  const rowCount = Math.max(1, maxDisplayRows ?? 0);
  const columnCount = Math.max(1, width ?? 0);
  if (maxDisplayRows === undefined || width === undefined) {
    return { value, cursor: clampCursor(cursor, value.length), clipped: false };
  }

  const sourceCursor = clampCursor(cursor, value.length);
  const rows = textInputDisplayRows(value, columnCount);
  const cursorRowIndex = cursorDisplayRowIndex(rows, sourceCursor);
  const keepRowsAfterCursor =
    rows.length <= rowCount
      ? rows.length - cursorRowIndex - 1
      : Math.min(rows.length - cursorRowIndex - 1, Math.floor(rowCount / 4));
  const endRow =
    rows.length <= rowCount
      ? rows.length
      : Math.min(rows.length, cursorRowIndex + keepRowsAfterCursor + 1);
  const startRow = rows.length <= rowCount ? 0 : Math.max(0, endRow - rowCount);
  const visibleRows = rows.slice(startRow, endRow);
  const clipped = startRow > 0 || endRow < rows.length;
  const firstRowOriginalLength =
    visibleRows[0] === undefined
      ? 0
      : visibleRows[0].end - visibleRows[0].start;
  const rowTexts = visibleRows.map((row) => value.slice(row.start, row.end));
  if (clipped && startRow > 0) {
    rowTexts[0] = leadingEllipsisText(rowTexts[0] ?? '', columnCount);
  }
  const displayValue = rowTexts.join('\n');
  const displayCursorRow = Math.max(0, cursorRowIndex - startRow);
  const cursorRow = visibleRows[displayCursorRow] ?? visibleRows.at(-1);
  const cursorColumn =
    cursorRow === undefined
      ? 0
      : clampCursor(
          sourceCursor - cursorRow.start,
          rowTexts[displayCursorRow]?.length ?? 0,
        );
  const ellipsisCursorColumn =
    clipped && startRow > 0 && displayCursorRow === 0
      ? firstRowOriginalLength >= columnCount
        ? Math.max(1, cursorColumn)
        : cursorColumn + 1
      : cursorColumn;
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

export function BaseTextInput(props: BaseTextInputProps): React.JSX.Element {
  const {
    displayWidth,
    value,
    maxDisplayRows,
    placeholder,
    focus = true,
    onChange,
    onInputChunkSubmit,
    onSubmit,
    onCursorChange,
  } = props;

  const isControlled = props.cursor !== undefined;
  const [internalCursor, setInternalCursor] = useState<number>(value.length);
  const cursor = clampCursor(
    isControlled ? (props.cursor as number) : internalCursor,
    value.length,
  );

  // Track the last value we ourselves emitted via onChange. If the prop's
  // `value` diverges from this, the parent swapped the text out from under
  // us (slash-palette accept, reverse-search recall, programmatic clear) —
  // snap the caret to the end so the next keystroke lands at the intuitive
  // spot, not whatever cursor index happened to be valid before.
  const lastEmittedValueRef = useRef<string>(value);
  useEffect(() => {
    if (lastEmittedValueRef.current === value) return;
    lastEmittedValueRef.current = value;
    if (!isControlled) setInternalCursor(value.length);
    onCursorChange?.(value.length);
  }, [value, isControlled, onCursorChange]);

  const moveCursor = useCallback(
    (next: number) => {
      const c = clampCursor(next, value.length);
      if (!isControlled) setInternalCursor(c);
      onCursorChange?.(c);
    },
    [isControlled, value.length, onCursorChange],
  );

  const applyEdit = useCallback(
    (edit: TextEdit) => {
      const c = clampCursor(edit.cursor, edit.value.length);
      lastEmittedValueRef.current = edit.value;
      onChange(edit.value);
      if (!isControlled) setInternalCursor(c);
      onCursorChange?.(c);
    },
    [isControlled, onChange, onCursorChange],
  );

  useInput(
    (input, key) => {
      if (isEscapeInput(input, key)) return;

      if (isCtrlInput(input, key, 'j') || isShiftReturnInput(input, key)) {
        // Ctrl-J (universal) or Shift+Enter (Kitty-protocol terminals) →
        // literal newline. Kills the legacy `/multi` ceremony.
        applyEdit(insertText(value, cursor, '\n'));
        return;
      }
      if (isPlainReturnInput(input, key)) {
        onSubmit(value);
        return;
      }
      if (key.backspace) {
        applyEdit(deleteBeforeCursor(value, cursor));
        return;
      }
      if (key.delete) {
        applyEdit(deleteAtCursor(value, cursor));
        return;
      }
      if (key.leftArrow) {
        moveCursor(cursor - 1);
        return;
      }
      if (key.rightArrow) {
        moveCursor(cursor + 1);
        return;
      }
      if (key.home || isCtrlInput(input, key, 'a')) {
        moveCursor(0);
        return;
      }
      if (key.end || isCtrlInput(input, key, 'e')) {
        moveCursor(value.length);
        return;
      }
      if (isCtrlInput(input, key, 'u')) {
        applyEdit(deleteToStart(value, cursor));
        return;
      }
      if (isCtrlInput(input, key, 'k')) {
        applyEdit(deleteToEnd(value, cursor));
        return;
      }
      if (isCtrlInput(input, key, 'w')) {
        applyEdit(deletePreviousWord(value, cursor));
        return;
      }
      // Drop unhandled control/meta combos; pass printable input through.
      if (
        key.meta ||
        metaChordInput(input, key) ||
        (key.ctrl && input.length === 1) ||
        isUnhandledControlInput(input) ||
        !input
      ) {
        return;
      }
      const edit = applyTerminalInputChunk(value, cursor, input);
      if (edit.submit) {
        (onInputChunkSubmit ?? onSubmit)(edit.value);
        return;
      }
      if (edit.value === value && edit.cursor === cursor) return;
      applyEdit(edit);
    },
    { isActive: focus },
  );

  // Bracketed paste arrives as ONE string and is not forwarded to useInput,
  // so newlines in the paste are preserved literally instead of firing Enter.
  usePaste(
    (text) => {
      applyEdit(insertText(value, cursor, text));
    },
    { isActive: focus },
  );

  if (value.length === 0) {
    if (!focus) {
      return placeholder ? <Text dimColor>{placeholder}</Text> : <Text> </Text>;
    }
    return (
      <Text>
        <Text inverse> </Text>
        {placeholder ? <Text dimColor>{placeholder}</Text> : null}
      </Text>
    );
  }

  const display = textInputDisplayWindow({
    cursor,
    maxDisplayRows,
    value,
    width: displayWidth,
  });
  // Mask only at the render layer. maskDisplayValue preserves length, so the
  // caret index from textInputDisplayWindow stays valid against the masked text.
  const shownValue = props.masked
    ? maskDisplayValue(display.value)
    : display.value;

  if (!focus) return <Text>{shownValue}</Text>;

  const before = shownValue.slice(0, display.cursor);
  const ch = shownValue[display.cursor];
  const after = shownValue.slice(display.cursor + 1);
  // Inverse-on-newline collapses to nothing visible; render the caret as a
  // leading space and let the literal newline carry the line break.
  if (ch === '\n') {
    return (
      <Text>
        {before}
        <Text inverse> </Text>
        {'\n'}
        {after}
      </Text>
    );
  }
  return (
    <Text>
      {before}
      <Text inverse>{ch ?? ' '}</Text>
      {after}
    </Text>
  );
}
