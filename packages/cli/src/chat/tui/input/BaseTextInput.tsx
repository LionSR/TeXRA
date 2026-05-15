// Paste-aware text input wrapping `ink-text-input`.
//
// Phase 1 ships paste-aware Enter and Ctrl-J → newline. Phase 5 will pick
// up the horizontal viewport once the palette / @-mention overlays need it.

import { useCallback } from 'react';
import { useInput } from 'ink';
import TextInput from 'ink-text-input';

import { usePasteHandler } from './usePasteHandler';

export interface BaseTextInputProps {
  readonly value: string;
  readonly placeholder?: string;
  readonly focus?: boolean;
  readonly onSubmit: (value: string) => void;
  readonly onChange: (value: string) => void;
}

export function BaseTextInput(props: BaseTextInputProps): React.JSX.Element {
  const { isPasted, currentPaste } = usePasteHandler();

  const handleSubmit = useCallback(
    (next: string) => {
      if (isPasted) {
        // Inside a bracketed paste: Enter is a literal newline, not "submit".
        // Avoids pasting a 50-line block firing 50 submits (PRD criterion).
        props.onChange(`${next}\n${currentPaste}`);
        return;
      }
      props.onSubmit(next);
    },
    [isPasted, currentPaste, props],
  );

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'j') {
        // Ctrl-J → literal newline (kills the legacy `/multi` ceremony).
        props.onChange(`${props.value}\n`);
      }
    },
    { isActive: props.focus !== false },
  );

  return (
    <TextInput
      value={props.value}
      placeholder={props.placeholder}
      focus={props.focus ?? true}
      showCursor
      onChange={props.onChange}
      onSubmit={handleSubmit}
    />
  );
}
