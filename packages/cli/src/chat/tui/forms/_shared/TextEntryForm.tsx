// One-line text entry for `/` forms: credentials (masked), `/config` string
// and number settings, and the TUI prompt host's `input`. A masked value lives
// in local state and is never rendered (BaseTextInput `masked`) or logged.

import { Box, Text, useInput, type Key } from 'ink';
import { useState, type ReactNode } from 'react';

import { COLOR_ERROR } from '@cli/tui/ui/colors';
import { KeyHints, type KeyHint } from '@cli/tui/ui/KeyHints';
import { CROSS, POINTER } from '@cli/tui/ui/glyphs';

import { BaseTextInput } from '@cli/chat/tui/input/BaseTextInput';
import { FormFrame } from './FormFrame';

interface TextEntryFormProps {
  readonly title: string;
  readonly helper?: ReactNode;
  readonly initialValue?: string;
  readonly placeholder: string;
  /** Hide the typed value. Defaults to on: most entries here are secrets. */
  readonly masked?: boolean;
  /** Submit the buffer as typed, empty included. By default the value is
   *  trimmed and an empty entry is ignored. */
  readonly rawSubmit?: boolean;
  /** Shown under the input while there is no error. */
  readonly hint?: ReactNode;
  /** An error from a failed save, shown so the user can retry in place. */
  readonly error?: string;
  /** Whether a save is in flight (input stays mounted but a hint shows). */
  readonly saving?: boolean;
  readonly extraHints?: readonly KeyHint[];
  /** Keys the form handles beyond Enter and Esc (e.g. Ctrl-R reset). */
  readonly onKey?: (input: string, key: Key) => void;
  /** Returns an error message to keep the entry open with it. */
  readonly onSubmit: (value: string) => string | void;
  readonly onCancel: () => void;
}

export function TextEntryForm(props: TextEntryFormProps): React.JSX.Element {
  const [value, setValue] = useState(props.initialValue ?? '');
  const [submitError, setSubmitError] = useState<string>();
  const error = props.error ?? submitError;

  // BaseTextInput owns Enter (onSubmit) and ignores Escape, so handle Escape
  // here to back out. Ignore it while a save is in flight: the save closure
  // isn't tied to this component's lifecycle, so backing out mid-save would
  // still persist the value and exit.
  useInput((input, key) => {
    props.onKey?.(input, key);
    if (key.escape && !props.saving) props.onCancel();
  });

  const status = error ? (
    <Text color={COLOR_ERROR}>{`${CROSS} ${error}`}</Text>
  ) : (
    props.hint && <Text dimColor>{props.hint}</Text>
  );
  return (
    <FormFrame title={props.title} showCloseHint={false}>
      {props.helper}
      <Box marginTop={props.helper === undefined ? 0 : 1}>
        <Text>{`${POINTER} `}</Text>
        <BaseTextInput
          value={value}
          masked={props.masked ?? true}
          placeholder={props.placeholder}
          onChange={(next) => {
            setValue(next);
            setSubmitError(undefined);
          }}
          onSubmit={(raw) => {
            const submitted = props.rawSubmit ? raw : raw.trim();
            if (props.saving || (!props.rawSubmit && !submitted)) return;
            setSubmitError(props.onSubmit(submitted) ?? undefined);
          }}
        />
      </Box>
      {status || props.saving ? (
        <Box marginTop={1} flexDirection="column">
          {status}
          {props.saving ? <Text dimColor>Saving…</Text> : null}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'Enter', action: 'save' },
            ...(props.extraHints ?? []),
            { key: 'Esc', action: 'back' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </FormFrame>
  );
}
