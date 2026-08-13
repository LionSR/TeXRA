import { Text } from 'ink';
import { useState } from 'react';

import {
  API_PROVIDERS,
  type ApiKeyStatus,
  type ApiProvider,
} from '@model/apiProviders';
import { providerDisplayName } from '@shared/constants/providers';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { ApiKeyEntryForm } from './ApiKeyEntryForm';
import { ListForm } from './_shared/ListForm';

type ProviderApiKeyStatuses = Partial<
  Readonly<Record<ApiProvider, ApiKeyStatus>>
>;

export interface ProviderApiKeyStatusView {
  readonly statuses?: ProviderApiKeyStatuses;
  readonly loading: boolean;
  readonly error: boolean;
}

function providerApiKeyStatusLabel(
  status: ApiKeyStatus | undefined,
  view: ProviderApiKeyStatusView,
): string {
  if (status === 'set') return 'Key set';
  if (status === 'env') return 'Env';
  if (status === 'not-set') return 'Not set';
  if (view.loading && !view.error) return 'Checking status';
  return 'Status unavailable';
}

export function buildProviderApiKeyItems(view: ProviderApiKeyStatusView) {
  return API_PROVIDERS.map((provider) => ({
    value: provider,
    label: providerDisplayName(provider),
    description: providerApiKeyStatusLabel(view.statuses?.[provider], view),
  }));
}

function configuredProviderApiKeySummary(
  statuses: ProviderApiKeyStatuses,
): string {
  const configured = API_PROVIDERS.filter((provider) => {
    const status = statuses[provider];
    return status === 'set' || status === 'env';
  }).map((provider) => providerDisplayName(provider));
  return configured.length > 0
    ? `Configured: ${configured.join(', ')}`
    : 'No provider keys set';
}

export function formatProviderApiKeySummary(
  view: ProviderApiKeyStatusView,
): string {
  if (!view.statuses) {
    if (view.loading && !view.error) return 'Checking configured keys';
    return 'Status unavailable';
  }
  const summary = configuredProviderApiKeySummary(view.statuses);
  if (view.error) return `${summary} · status unavailable`;
  return view.loading ? `${summary} · refreshing` : summary;
}

export interface ProviderApiKeyFormProps {
  readonly availableRows?: number;
  readonly statusView?: ProviderApiKeyStatusView;
  readonly onSave: (
    provider: ApiProvider,
    key: string,
  ) => Promise<string | void>;
  readonly onDone: (provider: ApiProvider, modelNotice?: string) => void;
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
        items={
          props.statusView
            ? buildProviderApiKeyItems(props.statusView)
            : API_PROVIDERS.map((provider) => ({
                value: provider,
                label: providerDisplayName(provider),
              }))
        }
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
          .then((modelNotice) =>
            props.onDone(provider, modelNotice || undefined),
          )
          .catch((saveError: unknown) => {
            setSaving(false);
            setError(toErrorMessage(saveError));
          });
      }}
    />
  );
}
