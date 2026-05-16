import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { BaseTextInput } from '../input/BaseTextInput';
import { ReverseSearch } from '../input/ReverseSearch';
import { SlashPalette } from '../commands/SlashPalette';
import { parseSlashInput } from '../commands/slashRegistry';
import type { InputHistory } from '../history/inputHistory';

export interface InputBarProps {
  /** Forwarded to BaseTextInput; called only on real (non-paste) Enter. */
  readonly onSubmit: (value: string) => void;
  /** Disable the input while an approval modal is owning the screen. */
  readonly disabled?: boolean;
  /** Prompt prefix (e.g. `>`). */
  readonly prompt?: string;
  /** Persistent input history (optional — undefined disables Ctrl-R). */
  readonly history?: InputHistory;
}

export function InputBar(props: InputBarProps): React.JSX.Element {
  const [value, setValue] = useState('');
  const [reverseSearchOpen, setReverseSearchOpen] = useState(false);
  const historyRef = useRef(props.history);
  historyRef.current = props.history;

  // Listen for Ctrl-R *outside* the text input — Ink emits the keystroke
  // to every `useInput` consumer, but ink-text-input ignores ctrl chords.
  useInput((input, key) => {
    if (props.disabled) return;
    if (key.ctrl && input.toLowerCase() === 'r' && historyRef.current) {
      setReverseSearchOpen(true);
    }
  });

  const handleSubmit = useCallback(
    (submitted: string) => {
      const trimmed = submitted.trim();
      if (trimmed.length === 0) return;
      setValue('');
      void historyRef.current?.push(trimmed);
      props.onSubmit(trimmed);
    },
    [props],
  );

  // Slash palette pops up while typing /…
  const parsed = parseSlashInput(value);
  const showPalette =
    parsed !== undefined && !reverseSearchOpen && !props.disabled;

  useEffect(() => {
    // Auto-close the reverse-search overlay when the input is disabled —
    // an approval modal taking focus shouldn't trap the user in the
    // search prompt.
    if (props.disabled && reverseSearchOpen) setReverseSearchOpen(false);
  }, [props.disabled, reverseSearchOpen]);

  return (
    <Box flexDirection="column">
      {showPalette ? (
        <SlashPalette
          query={parsed.name}
          onPick={(cmd) =>
            setValue(
              `/${cmd.name}${parsed.remainder ? ` ${parsed.remainder}` : ' '}`,
            )
          }
          onCancel={() => {
            /* Esc clears the slash — caller can re-open by typing again. */
            setValue('');
          }}
        />
      ) : null}
      {reverseSearchOpen && historyRef.current ? (
        <ReverseSearch
          history={historyRef.current}
          onCommit={(line) => {
            setValue(line);
            setReverseSearchOpen(false);
          }}
          onCancel={() => setReverseSearchOpen(false)}
        />
      ) : null}
      <Box borderStyle="round" paddingX={1}>
        <Text>{props.prompt ?? '>'} </Text>
        <BaseTextInput
          value={value}
          focus={!props.disabled && !reverseSearchOpen}
          onChange={setValue}
          onSubmit={handleSubmit}
        />
      </Box>
    </Box>
  );
}
