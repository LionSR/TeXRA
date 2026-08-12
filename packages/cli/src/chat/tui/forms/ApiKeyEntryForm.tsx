// Masked provider-key entry shared by first-run onboarding and `/key`.
// Props-in -> JSX-out: the captured key lives in
// local state and is never rendered (BaseTextInput `masked`) or logged.

import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

import { COLOR_ERROR } from '@cli/tui/ui/colors';
import { KeyHints } from '@cli/tui/ui/KeyHints';
import { CROSS, POINTER } from '@cli/tui/ui/glyphs';
import { apiKeyEnvName, type ApiProvider } from '@model/apiProviders';
import {
  PROVIDER_URLS,
  providerDisplayName,
} from '@shared/constants/providers';

import { BaseTextInput } from '../input/BaseTextInput';
import { FormFrame } from './_shared/FormFrame';

export interface ApiKeyEntryFormProps {
  readonly provider: ApiProvider;
  /** Optional error from a failed save, shown so the user can retry in place. */
  readonly error?: string;
  /** Whether a save is in flight (input stays mounted but a hint shows). */
  readonly saving?: boolean;
  readonly onSubmit: (key: string) => void;
  readonly onCancel: () => void;
}

export function ApiKeyEntryForm(
  props: ApiKeyEntryFormProps,
): React.JSX.Element {
  const [key, setKey] = useState('');
  const label = providerDisplayName(props.provider);
  const keyUrl = PROVIDER_URLS[props.provider];

  // BaseTextInput ignores Escape (returns early in its own useInput), so handle
  // it here to back out of key entry. Enter is owned by BaseTextInput's
  // onSubmit; we only act on Escape to avoid double-handling. Ignore Escape
  // while a save is in flight: the save closure isn't tied to this component's
  // lifecycle, so backing out mid-save would still persist the key and exit.
  useInput((_input, k) => {
    if (k.escape && !props.saving) props.onCancel();
  });

  return (
    <FormFrame title="Use my own provider API key" showCloseHint={false}>
      <Text dimColor>Provider: {label}</Text>
      {keyUrl ? <Text dimColor>Get a key: {keyUrl}</Text> : null}
      <Box marginTop={1}>
        <Text>{`${POINTER} `}</Text>
        <BaseTextInput
          value={key}
          masked
          placeholder="enter your API key (hidden)"
          onChange={setKey}
          onSubmit={(value) => {
            const trimmed = value.trim();
            if (trimmed && !props.saving) props.onSubmit(trimmed);
          }}
        />
      </Box>
      <Box marginTop={1} flexDirection="column">
        {props.error ? (
          <Text color={COLOR_ERROR}>{`${CROSS} ${props.error}`}</Text>
        ) : (
          <Text dimColor>
            Stored in TeXRA secrets on Enter — or set{' '}
            {apiKeyEnvName(props.provider)} in your environment.
          </Text>
        )}
        {props.saving ? <Text dimColor>Saving…</Text> : null}
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'Enter', action: 'save' },
            { key: 'Esc', action: 'back' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </FormFrame>
  );
}
