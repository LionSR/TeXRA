// Native Ink 7 text input.
//
// Built directly on `useInput` + `usePaste` — no `ink-text-input` dependency.
// usePaste auto-enables bracketed paste mode so multi-line pastes arrive as
// a single string and never trigger `onSubmit` on the first embedded `\n`.

import { useCallback } from 'react';
import { Text, useInput, usePaste } from 'ink';

export interface BaseTextInputProps {
  readonly value: string;
  readonly placeholder?: string;
  readonly focus?: boolean;
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

  // Caret is uncontrolled by default: caller may pin it with `cursor` +
  // `onCursorChange`, otherwise it tracks the end of `value`.
  const cursor =
    props.cursor !== undefined
      ? Math.max(0, Math.min(props.cursor, value.length))
      : value.length;

  const setBoth = useCallback(
    (nextValue: string, nextCursor: number) => {
      onChange(nextValue);
      onCursorChange?.(Math.max(0, Math.min(nextCursor, nextValue.length)));
    },
    [onChange, onCursorChange],
  );

  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit(value);
        return;
      }
      if (key.ctrl && input === 'j') {
        // Ctrl-J → literal newline (kills the legacy `/multi` ceremony).
        setBoth(
          value.slice(0, cursor) + '\n' + value.slice(cursor),
          cursor + 1,
        );
        return;
      }
      if (key.backspace) {
        if (cursor === 0) return;
        setBoth(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
        return;
      }
      if (key.delete) {
        if (cursor >= value.length) return;
        setBoth(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
        return;
      }
      if (key.leftArrow) {
        onCursorChange?.(Math.max(0, cursor - 1));
        return;
      }
      if (key.rightArrow) {
        onCursorChange?.(Math.min(value.length, cursor + 1));
        return;
      }
      if (key.home || (key.ctrl && input === 'a')) {
        onCursorChange?.(0);
        return;
      }
      if (key.end || (key.ctrl && input === 'e')) {
        onCursorChange?.(value.length);
        return;
      }
      if (key.ctrl && input === 'u') {
        setBoth(value.slice(cursor), 0);
        return;
      }
      if (key.ctrl && input === 'k') {
        setBoth(value.slice(0, cursor), cursor);
        return;
      }
      if (key.ctrl && input === 'w') {
        const left = value.slice(0, cursor);
        const trimmed = left.replace(/\S*\s*$/, '');
        setBoth(trimmed + value.slice(cursor), trimmed.length);
        return;
      }
      // Drop control/meta combos we don't handle; pass printable input through.
      if (key.ctrl || key.meta || !input) return;
      setBoth(
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
      setBoth(
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
    const head = placeholder?.[0] ?? ' ';
    const tail = placeholder ? placeholder.slice(1) : '';
    return (
      <Text>
        <Text inverse>{head}</Text>
        {tail ? <Text dimColor>{tail}</Text> : null}
      </Text>
    );
  }

  if (!focus) return <Text>{value}</Text>;

  const before = value.slice(0, cursor);
  const at = value[cursor] ?? ' ';
  const after = value.slice(cursor + 1);
  return (
    <Text>
      {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
  );
}
