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
  insertText,
  type TextEdit,
} from './textInputEditing';
import {
  isPlainReturnInput,
  isShiftReturnInput,
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
  readonly onChange: (value: string) => void;
}

export interface TextInputDisplayWindow {
  readonly value: string;
  readonly cursor: number;
  readonly clipped: boolean;
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

  // Reserve one cell for the leading ellipsis so clipped text never exceeds
  // the requested terminal row/column window.
  const budget = Math.max(1, rowCount * columnCount - 1);
  if (value.length <= budget) {
    return { value, cursor: clampCursor(cursor, value.length), clipped: false };
  }

  const sourceCursor = clampCursor(cursor, value.length);
  const keepAfterCursor = Math.min(
    value.length - sourceCursor,
    Math.floor(budget / 4),
  );
  const end = Math.min(value.length, sourceCursor + keepAfterCursor);
  const start = Math.max(0, end - budget);
  const prefix = start > 0 ? '…' : '';
  const displayValue = `${prefix}${value.slice(start, end)}`;
  return {
    value: displayValue,
    cursor: clampCursor(
      sourceCursor - start + prefix.length,
      displayValue.length,
    ),
    clipped: true,
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
      if ((key.ctrl && input === 'j') || isShiftReturnInput(input, key)) {
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
      if (key.home || (key.ctrl && input === 'a')) {
        moveCursor(0);
        return;
      }
      if (key.end || (key.ctrl && input === 'e')) {
        moveCursor(value.length);
        return;
      }
      if (key.ctrl && input === 'u') {
        applyEdit(deleteToStart(value, cursor));
        return;
      }
      if (key.ctrl && input === 'k') {
        applyEdit(deleteToEnd(value, cursor));
        return;
      }
      if (key.ctrl && input === 'w') {
        applyEdit(deletePreviousWord(value, cursor));
        return;
      }
      // Drop unhandled control/meta combos; pass printable input through.
      if (key.ctrl || key.meta || metaChordInput(input, key) || !input) return;
      applyEdit(insertText(value, cursor, input));
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

  if (!focus) return <Text>{display.value}</Text>;

  const before = display.value.slice(0, display.cursor);
  const ch = display.value[display.cursor];
  const after = display.value.slice(display.cursor + 1);
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
