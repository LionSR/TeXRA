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
import { isPlainReturnInput, metaChordInput } from './inputKeys';

export interface BaseTextInputProps {
  readonly value: string;
  readonly placeholder?: string;
  readonly focus?: boolean;
  /** Pin the caret externally. When omitted, the component tracks the caret
   *  internally so arrow keys / Home/End / Ctrl-A,E,U,K,W work out of the box. */
  readonly cursor?: number;
  readonly onCursorChange?: (cursor: number) => void;
  readonly onSubmit: (value: string) => void;
  readonly onChange: (value: string) => void;
}

export function BaseTextInput(props: BaseTextInputProps): React.JSX.Element {
  const {
    value,
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

  const replaceText = useCallback(
    (nextValue: string, nextCursor: number) => {
      const c = clampCursor(nextCursor, nextValue.length);
      lastEmittedValueRef.current = nextValue;
      onChange(nextValue);
      if (!isControlled) setInternalCursor(c);
      onCursorChange?.(c);
    },
    [isControlled, onChange, onCursorChange],
  );

  const applyEdit = useCallback(
    (edit: TextEdit) => replaceText(edit.value, edit.cursor),
    [replaceText],
  );

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'j') {
        // Ctrl-J → literal newline (kills the legacy `/multi` ceremony).
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

  if (!focus) return <Text>{value}</Text>;

  const before = value.slice(0, cursor);
  const ch = value[cursor];
  const after = value.slice(cursor + 1);
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
