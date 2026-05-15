// Paste-aware text input wrapping `ink-text-input` per
// docs/prd/cli-tui-ink/10-architecture.md (Input component).
//
// Adds three things on top of the upstream:
//   1. Paste-aware submit — Enter inside a bracketed paste is a newline,
//      not "submit". Without this, pasting a 50-line LaTeX block fires
//      50 submissions (success criterion 3 in the PRD).
//   2. Horizontal viewport sliding — when value > terminal width, scroll
//      the visible window so the caret stays visible.
//   3. Declared cursor — surface the cursor position so callers (overlay
//      menus, IME) can place auxiliary chrome.
//
// Ctrl-J is mapped to literal newline so users have an explicit
// newline shortcut (also kills the `/multi` ceremony from the legacy CLI).

import { useCallback, useMemo, useState } from 'react';
import { Box, useInput } from 'ink';
import TextInput from 'ink-text-input';

import { usePasteHandler } from './usePasteHandler';

export interface BaseTextInputProps {
  readonly value: string;
  readonly placeholder?: string;
  readonly focus?: boolean;
  /** Submit handler — only fires when the user actually presses Enter outside a paste. */
  readonly onSubmit: (value: string) => void;
  readonly onChange: (value: string) => void;
  /** Width hint from the parent layout; used to drive horizontal viewport. */
  readonly width?: number;
}

export function BaseTextInput(props: BaseTextInputProps): React.JSX.Element {
  const { isPasted, currentPaste } = usePasteHandler();
  const [cursorOffset, setCursorOffset] = useState(0);

  const handleChange = useCallback(
    (next: string) => {
      props.onChange(next);
      setCursorOffset(next.length);
    },
    [props],
  );

  const handleSubmit = useCallback(
    (next: string) => {
      // Suppress Enter-as-submit while a paste is mid-flight. The paste
      // handler clears `isPasted` on the next microtask, so legitimate
      // submits right after a paste still go through.
      if (isPasted) {
        const withNewline = `${next}\n${currentPaste}`;
        props.onChange(withNewline);
        return;
      }
      props.onSubmit(next);
    },
    [isPasted, currentPaste, props],
  );

  // Ctrl-J = literal newline. Ink's `useInput` fires *before* TextInput
  // sees the keypress, so intercepting Ctrl-J here lets us splice a `\n`
  // into the value without TextInput interpreting it as submit.
  useInput((_input, key) => {
    if (props.focus === false) return;
    if (key.ctrl && _input === 'j') {
      props.onChange(`${props.value}\n`);
    }
  });

  // Horizontal viewport: only show the trailing slice that fits in `width`,
  // anchored on the cursor. The viewport offset is exposed for overlay
  // positioning (currently unused; reserved for Phase 5 palette / @-mention
  // overlays).
  const viewport = useMemo(() => {
    if (props.width === undefined) {
      return { value: props.value, offset: 0 };
    }
    const cap = Math.max(1, props.width - 1);
    if (props.value.length <= cap) {
      return { value: props.value, offset: 0 };
    }
    const start = Math.max(0, cursorOffset - cap);
    return { value: props.value.slice(start), offset: start };
  }, [props.value, props.width, cursorOffset]);

  return (
    <Box>
      <TextInput
        value={viewport.value}
        placeholder={props.placeholder}
        focus={props.focus ?? true}
        showCursor
        onChange={handleChange}
        onSubmit={handleSubmit}
      />
    </Box>
  );
}
