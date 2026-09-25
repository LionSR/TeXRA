// Masked provider-key entry shared by first-run onboarding and `/key`.

import { Text } from 'ink';

import { apiKeyEnvName, type ApiProvider } from '@model/apiProviders';
import {
  PROVIDER_URLS,
  providerDisplayName,
} from '@shared/constants/providers';

import { TextEntryForm } from './_shared/TextEntryForm';

interface ApiKeyEntryFormProps {
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
  const label = providerDisplayName(props.provider);
  const keyUrl = PROVIDER_URLS[props.provider];

  return (
    <TextEntryForm
      title="Use my own provider API key"
      helper={
        <>
          <Text dimColor>Provider: {label}</Text>
          {keyUrl ? <Text dimColor>Get a key: {keyUrl}</Text> : null}
        </>
      }
      placeholder="enter your API key (hidden)"
      hint={
        <>
          Stored in TeXRA secrets on Enter — or set{' '}
          {apiKeyEnvName(props.provider)} in your environment.
        </>
      }
      {...props}
    />
  );
}
