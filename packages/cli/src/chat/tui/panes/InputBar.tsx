import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { BaseTextInput } from '../input/BaseTextInput';
import { ReverseSearch } from '../input/ReverseSearch';
import { SlashPalette } from '../commands/SlashPalette';
import { matchSlashCommands, parseSlashInput } from '../commands/slashRegistry';
import type { InputHistory } from '../history/inputHistory';
import { writeTextStderr } from '../../../runtime/logSinks';
import { cliState } from '../state/cliState';

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
  const { disabled, history, onSubmit, prompt } = props;
  const [value, setValue] = useState('');
  const [reverseSearchOpen, setReverseSearchOpen] = useState(false);
  const historyRef = useRef(history);
  historyRef.current = history;

  // Listen for Ctrl-R *outside* the text input — Ink emits the keystroke
  // to every `useInput` consumer, and BaseTextInput drops unhandled ctrl
  // chords so this handler still fires.
  useInput((input, key) => {
    if (disabled) return;
    if (key.ctrl && input.toLowerCase() === 'r' && historyRef.current) {
      setReverseSearchOpen(true);
    }
  });

  const handleSubmit = useCallback(
    (submitted: string) => {
      const trimmed = submitted.trim();
      if (trimmed.length === 0) return;
      setValue('');
      // Persisting history is best-effort — a disk failure (read-only fs,
      // ENOSPC) must not block the submit. Surface the failure through the
      // shared log sink so it isn't completely silent.
      const historyPersist = historyRef.current?.push(trimmed);
      historyPersist?.catch((err: unknown) => {
        writeTextStderr(
          `texra: failed to persist input history: ${String(err)}`,
        );
      });
      onSubmit(trimmed);
    },
    [onSubmit],
  );

  // Slash palette pops up while typing /…
  const parsed = parseSlashInput(value);
  const isTypingSlashCommandName =
    parsed !== undefined && !/\s/.test(value.slice(1));
  const hasPaletteMatches =
    parsed !== undefined && matchSlashCommands(parsed.name).length > 0;
  const showPalette =
    parsed !== undefined &&
    isTypingSlashCommandName &&
    hasPaletteMatches &&
    !reverseSearchOpen &&
    !disabled;

  useEffect(() => {
    // Auto-close the reverse-search overlay when the input is disabled —
    // an approval modal taking focus shouldn't trap the user in the
    // search prompt.
    if (disabled && reverseSearchOpen) setReverseSearchOpen(false);
  }, [disabled, reverseSearchOpen]);

  return (
    <Box flexDirection="column">
      {showPalette ? (
        <SlashPalette
          query={parsed.name}
          onPick={(cmd) => {
            if (cmd.formComponent) {
              // Structured forms own the screen — clear the input and let
              // the active-form signal mount the component (see App.tsx).
              const Form = cmd.formComponent;
              setValue('');
              cliState.activeForm.set({
                commandName: cmd.name,
                render: (close) => (
                  <Form
                    remainder={parsed.remainder.trimStart()}
                    onDone={() => close()}
                  />
                ),
              });
              return;
            }
            setValue(
              `/${cmd.name}${
                parsed.remainder ? ` ${parsed.remainder.trimStart()}` : ' '
              }`,
            );
          }}
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
      <Box paddingX={1}>
        <Text color="cyan">{prompt ?? '›'} </Text>
        <BaseTextInput
          value={value}
          focus={!disabled && !reverseSearchOpen}
          onChange={setValue}
          onSubmit={showPalette ? () => undefined : handleSubmit}
        />
      </Box>
    </Box>
  );
}
