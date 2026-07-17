import { Text } from 'ink';
import { useState } from 'react';

import { API_PROVIDERS, type ApiProvider } from '@model/apiProviders';
import { PROVIDER_DISPLAY_NAMES } from '@shared/constants/providers';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { ApiKeyEntryForm } from './ApiKeyEntryForm';
import { ListForm } from './_shared/ListForm';

export interface ProviderApiKeyFormProps {
  readonly availableRows?: number;
  readonly onSave: (provider: ApiProvider, key: string) => Promise<void>;
  readonly onDone: (provider: ApiProvider) => void;
  readonly onCancel: () => void;
}

/** Keep provider selection and masked key entry inside the CLI process. */
export function ProviderApiKeyForm(
  props: ProviderApiKeyFormProps,
): React.JSX.Element {
  const [provider, setProvider] = useState<ApiProvider>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  if (provider === undefined) {
    return (
      <ListForm
        title="Add provider API key"
        availableRows={props.availableRows}
        items={API_PROVIDERS.map((candidate) => ({
          value: candidate,
          label: PROVIDER_DISPLAY_NAMES[candidate] ?? candidate,
        }))}
        description={
          <Text dimColor>Choose the service that issued the key.</Text>
        }
        action="select"
        escapeAction="close"
        onSelect={(candidate) => {
          setError(undefined);
          setProvider(candidate);
        }}
        onCancel={props.onCancel}
      />
    );
  }

  return (
    <ApiKeyEntryForm
      provider={provider}
      error={error}
      saving={saving}
      onCancel={() => {
        setError(undefined);
        setProvider(undefined);
      }}
      onSubmit={(key) => {
        setSaving(true);
        void props
          .onSave(provider, key)
          .then(() => props.onDone(provider))
          .catch((saveError: unknown) => {
            setSaving(false);
            setError(toErrorMessage(saveError));
          });
      }}
    />
  );
}
