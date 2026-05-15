// Paste-aware text input wrapping `ink-text-input` per
// docs/prd/cli-tui-ink/10-architecture.md (Input component).
//
// Phase 1 ships the paste-aware Enter behaviour and the Ctrl-J → newline
// shortcut. The full horizontal-viewport implementation (PRD: "viewport
// offsets exposed for overlay positioning") is deferred to Phase 5 alongside
// the palette / @-mention overlays — slicing `props.value` before handing it
// to a controlled `ink-text-input` drops characters once the value exceeds
// the viewport width, because the input's `onChange` returns the modified
// *slice* and `handleChange` writes that back as the full draft.
//
// Until Phase 5 lands a proper viewport↔full-string reconciliation, Phase 1
// passes the full value through. Long lines wrap visually (ink's default
// `<TextInput>` does not horizontally scroll); paste-aware submit still
// fires correctly.

import { useCallback } from 'react';
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
}

export function BaseTextInput(props: BaseTextInputProps): React.JSX.Element {
  const { isPasted, currentPaste } = usePasteHandler();

  const handleSubmit = useCallback(
    (next: string) => {
      // Suppress Enter-as-submit while a paste is mid-flight. The paste
      // handler clears `isPasted` on the next microtask, so legitimate
      // submits right after a paste still go through.
      if (isPasted) {
        props.onChange(`${next}\n${currentPaste}`);
        return;
      }
      props.onSubmit(next);
    },
    [isPasted, currentPaste, props],
  );

  // Ctrl-J = literal newline. Ink's `useInput` fires *before* TextInput
  // sees the keypress, so intercepting Ctrl-J here lets us splice a `\n`
  // into the value without TextInput interpreting it as submit.
  useInput((input, key) => {
    if (props.focus === false) return;
    if (key.ctrl && input === 'j') {
      props.onChange(`${props.value}\n`);
    }
  });

  return (
    <Box>
      <TextInput
        value={props.value}
        placeholder={props.placeholder}
        focus={props.focus ?? true}
        showCursor
        onChange={props.onChange}
        onSubmit={handleSubmit}
      />
    </Box>
  );
}
