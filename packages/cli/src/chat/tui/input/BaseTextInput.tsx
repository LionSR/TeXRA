// Native Ink 7 text input.
//
// Built directly on `useInput` + `usePaste` — no `ink-text-input` dependency.
// usePaste auto-enables bracketed paste mode so multi-line pastes arrive as
// a single string and never trigger `onSubmit` on the first embedded `\n`.

import { useCallback, useState } from 'react';
import { Text, useInput, usePaste } from 'ink';

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

function clamp(n: number, max: number): number {
  return Math.max(0, Math.min(n, max));
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
  const cursor = clamp(
    isControlled ? (props.cursor as number) : internalCursor,
    value.length,
  );

  const moveCursor = useCallback(
    (next: number) => {
      const c = clamp(next, value.length);
      if (!isControlled) setInternalCursor(c);
      onCursorChange?.(c);
    },
    [isControlled, value.length, onCursorChange],
  );

  const replaceText = useCallback(
    (nextValue: string, nextCursor: number) => {
      const c = clamp(nextCursor, nextValue.length);
      onChange(nextValue);
      if (!isControlled) setInternalCursor(c);
      onCursorChange?.(c);
    },
    [isControlled, onChange, onCursorChange],
  );

  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit(value);
        return;
      }
      if (key.ctrl && input === 'j') {
        // Ctrl-J → literal newline (kills the legacy `/multi` ceremony).
        replaceText(
          value.slice(0, cursor) + '\n' + value.slice(cursor),
          cursor + 1,
        );
        return;
      }
      if (key.backspace) {
        if (cursor === 0) return;
        replaceText(
          value.slice(0, cursor - 1) + value.slice(cursor),
          cursor - 1,
        );
        return;
      }
      if (key.delete) {
        if (cursor >= value.length) return;
        replaceText(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
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
        replaceText(value.slice(cursor), 0);
        return;
      }
      if (key.ctrl && input === 'k') {
        replaceText(value.slice(0, cursor), cursor);
        return;
      }
      if (key.ctrl && input === 'w') {
        const left = value.slice(0, cursor);
        const trimmed = left.replace(/\S*\s*$/, '');
        replaceText(trimmed + value.slice(cursor), trimmed.length);
        return;
      }
      // Drop unhandled control/meta combos; pass printable input through.
      if (key.ctrl || key.meta || !input) return;
      replaceText(
        value.slice(0, cursor) + input + value.slice(cursor),
        cursor + input.length,
      );
    },
    { isActive: focus },
  );

  // Bracketed paste arrives as ONE string and is not forwarded to useInput,
  // so newlines in the paste are preserved literally instead of firing Enter.
  usePaste(
    (text) => {
      replaceText(
        value.slice(0, cursor) + text + value.slice(cursor),
        cursor + text.length,
      );
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
