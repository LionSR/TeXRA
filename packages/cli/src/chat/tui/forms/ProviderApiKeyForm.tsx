import { Text } from 'ink';
import { useState } from 'react';

import {
  API_PROVIDERS,
  type ApiKeyStatus,
  type ApiProvider,
} from '@model/apiProviders';
import { codingPlanForApiProvider } from '@shared/codingPlanSubscriptions';
import { providerDisplayName } from '@shared/constants/providers';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { ApiKeyEntryForm } from './ApiKeyEntryForm';
import { formatStatusViewSummary } from './_shared/formatStatusViewSummary';
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

function providerApiKeyFormLabel(provider: ApiProvider): string {
  const providerName = providerDisplayName(provider);
  const codingPlan = codingPlanForApiProvider(provider);
  return codingPlan && !codingPlan.exclusiveCredential
    ? `${providerName} API/${codingPlan.displayName}`
    : providerName;
}

export function buildProviderApiKeyItems(
  view: ProviderApiKeyStatusView,
): Array<{ value: ApiProvider; label: string; description: string }> {
  return API_PROVIDERS.map((provider) => ({
    value: provider,
    label: providerApiKeyFormLabel(provider),
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
  return formatStatusViewSummary(
    view,
    'Checking configured keys',
    view.statuses === undefined
      ? undefined
      : configuredProviderApiKeySummary(view.statuses),
  );
}

interface ProviderApiKeyFormProps {
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
            : API_PROVIDERS.map((candidate) => ({
                value: candidate,
                label: providerApiKeyFormLabel(candidate),
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
