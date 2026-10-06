import { Text } from 'ink';
import { useState } from 'react';

import {
  API_KEY_PROVIDER_IDS,
  type ApiKeyStatus,
  type ApiKeyProviderId,
  providerDisplayName,
} from '@texra-ai/llm';
import type { ProcessRuntime } from '@platform/processRuntime';
import { codingPlanForApiProvider } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { ApiKeyEntryForm } from './ApiKeyEntryForm';
import { formatStatusViewSummary } from './_shared/formatStatusViewSummary';
import { ListForm } from './_shared/ListForm';
import { runFormWrite } from './_shared/useAsyncListForm';
import type { Effect } from 'effect';

type ProviderApiKeyStatuses = Partial<
  Readonly<Record<ApiKeyProviderId, ApiKeyStatus>>
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

function providerApiKeyFormLabel(provider: ApiKeyProviderId): string {
  const providerName = providerDisplayName(provider);
  const codingPlan = codingPlanForApiProvider(provider);
  return codingPlan && !codingPlan.exclusiveCredential
    ? `${providerName} API/${codingPlan.displayName}`
    : providerName;
}

function buildProviderApiKeyItems(
  view: ProviderApiKeyStatusView,
): Array<{ value: ApiKeyProviderId; label: string; description: string }> {
  return API_KEY_PROVIDER_IDS.map((provider) => ({
    value: provider,
    label: providerApiKeyFormLabel(provider),
    description: providerApiKeyStatusLabel(view.statuses?.[provider], view),
  }));
}

function configuredProviderApiKeySummary(
  statuses: ProviderApiKeyStatuses,
): string {
  const configured = API_KEY_PROVIDER_IDS.filter((provider) => {
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
  /** The key write as a program; this form owns its one run. It yields the
   *  extra notice a provider needs, if any. */
  readonly onSave: (
    provider: ApiKeyProviderId,
    key: string,
  ) => Effect.Effect<string | void, Error>;
  /** The runtime that program settles on, from the surface that mounted this
   *  form — Ink components run no Effect of their own. */
  readonly runtime: ProcessRuntime;
  readonly onDone: (provider: ApiKeyProviderId, modelNotice?: string) => void;
  readonly onCancel: () => void;
}

/** Keep provider selection and masked key entry inside the CLI process. */
export function ProviderApiKeyForm(
  props: ProviderApiKeyFormProps,
): React.JSX.Element {
  const [provider, setProvider] = useState<ApiKeyProviderId>();
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
            : API_KEY_PROVIDER_IDS.map((candidate) => ({
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
        runFormWrite(props.runtime, () => props.onSave(provider, key), {
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
