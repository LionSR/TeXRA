import { Text } from 'ink';
import { useState } from 'react';

import {
  API_KEY_PROVIDER_IDS,
  type CredentialOrigin,
  type ApiKeyProviderId,
  providerDisplayName,
} from '@texra-ai/llm';
import { toErrorMessage } from '@texra-ai/worldline/schemas';
import { CODING_PLAN_BY_API_PROVIDER } from '@texra/shared/model/codingPlans';
import { credentialOriginLabel } from '@ui/copy/credentials';

import { ApiKeyEntryForm } from './ApiKeyEntryForm';
import { ListForm } from './_shared/ListForm';
import {
  resourceStatusSummary,
  runFormWrite,
  type ResourceStatus,
} from './_shared/useAsyncListForm';
import type { Secrets } from '@texra-ai/worldline/plugins';
import type { Effect } from 'effect';
import { useChatProcess } from '../chatProcess';

type ProviderApiKeyStatuses = Partial<
  Readonly<Record<ApiKeyProviderId, CredentialOrigin>>
>;

function providerApiKeyStatusLabel(
  status: CredentialOrigin | undefined,
  view: ResourceStatus<ProviderApiKeyStatuses>,
): string {
  if (status !== undefined) return credentialOriginLabel(status, 'key');
  if (view.loading && view.error === undefined) return 'Checking status';
  return 'Status unavailable';
}

function providerApiKeyFormLabel(provider: ApiKeyProviderId): string {
  const providerName = providerDisplayName(provider);
  const codingPlan = CODING_PLAN_BY_API_PROVIDER.get(provider);
  return codingPlan && !codingPlan.exclusiveCredential
    ? `${providerName} API/${codingPlan.displayName}`
    : providerName;
}

function buildProviderApiKeyItems(
  view: ResourceStatus<ProviderApiKeyStatuses>,
): Array<{ value: ApiKeyProviderId; label: string; description: string }> {
  return API_KEY_PROVIDER_IDS.map((provider) => ({
    value: provider,
    label: providerApiKeyFormLabel(provider),
    description: providerApiKeyStatusLabel(view.data?.[provider], view),
  }));
}

function configuredProviderApiKeySummary(
  statuses: ProviderApiKeyStatuses,
): string {
  const configured = API_KEY_PROVIDER_IDS.filter((provider) => {
    const status = statuses[provider];
    return status === 'secret' || status === 'env';
  }).map((provider) => providerDisplayName(provider));
  return configured.length > 0
    ? `Configured: ${configured.join(', ')}`
    : 'No provider keys set';
}

export function formatProviderApiKeySummary(
  view: ResourceStatus<ProviderApiKeyStatuses>,
): string {
  return resourceStatusSummary(
    view,
    'Checking configured keys',
    configuredProviderApiKeySummary,
  );
}

interface ProviderApiKeyFormProps {
  readonly availableRows: number;
  /** Each provider's key status, shown beside its row; never the key. */
  readonly status: ResourceStatus<ProviderApiKeyStatuses>;
  /** The key write as a program; this form owns its one run. It yields the
   *  extra notice a provider needs, if any. */
  readonly onSave: (
    provider: ApiKeyProviderId,
    key: string,
  ) => Effect.Effect<string | void, Error, Secrets>;
  readonly onDone: (provider: ApiKeyProviderId, modelNotice?: string) => void;
  readonly onCancel: () => void;
}

/** Keep provider selection and masked key entry inside the CLI process. */
export function ProviderApiKeyForm(
  props: ProviderApiKeyFormProps,
): React.JSX.Element {
  const { chat } = useChatProcess();
  const [provider, setProvider] = useState<ApiKeyProviderId>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  if (provider === undefined) {
    return (
      <ListForm
        title="Add provider API key"
        availableRows={props.availableRows}
        items={buildProviderApiKeyItems(props.status)}
        description={
          <Text dimColor>Choose the service that issued the key.</Text>
        }
        action="select"
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
        runFormWrite(chat, () => props.onSave(provider, key), {
          onSuccess: (modelNotice) =>
            props.onDone(provider, modelNotice || undefined),
          onError: (cause) => {
            setSaving(false);
            setError(toErrorMessage(cause));
          },
        });
      }}
    />
  );
}
