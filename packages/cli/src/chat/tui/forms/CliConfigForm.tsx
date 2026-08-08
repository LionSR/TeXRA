import { useCallback, useEffect, useRef, useState } from 'react';

import { cliSettingsStores } from '@cli/runtime/settingsStores';
import { applyCliGitAuthorConfig } from '@cli/runtime/gitAuthor';
import {
  loadProviderApiKeyStatuses,
  saveProviderApiKey,
} from '@cli/runtime/providerApiKey';
import type { ApiProvider } from '@model/apiProviders';
import {
  readSetting,
  resetSetting,
  writeSetting,
  type SettingsStores,
} from '@shared/config/settingsAccess';
import {
  CLI_STATE_SETTINGS,
  stateSettingByKey,
} from '@shared/schemas/stateSettings';
import { GlobalStateKey } from '@shared/state/stateKeys';

import { refreshSubscriptionPreferenceViews } from '../state/codexSubscription';
import { AgentRosterForm } from './AgentRosterForm';
import { ConfigForm, type ConfigFormProps } from './ConfigForm';
import {
  formatProviderApiKeySummary,
  ProviderApiKeyForm,
  type ProviderApiKeyStatusView,
} from './ProviderApiKeyForm';
import { ToolsListForm } from './ToolsListForm';

export interface CliConfigFormProps {
  readonly availableRows?: number;
  readonly stores?: SettingsStores;
  readonly onClose: () => void;
  readonly onError?: (error: unknown) => void;
  readonly openExternalForm?: (formName: string) => void;
  readonly onApiModePersonal?: () => void | Promise<void>;
}

export interface CreateCliConfigFormPropsInput extends CliConfigFormProps {
  readonly stores: SettingsStores;
  readonly apiKeyStatusView?: ProviderApiKeyStatusView;
  readonly markProviderApiKeySet?: (provider: ApiProvider) => void;
  readonly refreshApiKeyStatuses?: () => void | Promise<void>;
}

/**
 * Settings whose change alters model routing or picker availability, so the
 * cached model options must be recomputed (computeModelOptions reads both
 * toggles when resolving per-model routes).
 */
const MODEL_ROUTING_SETTING_KEYS: ReadonlySet<string> = new Set([
  GlobalStateKey.USE_OPENROUTER,
  GlobalStateKey.KIMI_CODE_PREFER,
  GlobalStateKey.GLM_CODING_PLAN,
]);

const INITIAL_API_KEY_STATUS_VIEW: ProviderApiKeyStatusView = {
  loading: true,
  error: false,
};

/**
 * Construct the canonical CLI configuration interface. Both the standalone
 * command and the in-chat form use this function, so persistence and runtime
 * side effects cannot diverge between entry points.
 */
export function createCliConfigFormProps(
  props: CreateCliConfigFormPropsInput,
): ConfigFormProps {
  const { stores } = props;
  const apiKeyStatusView =
    props.apiKeyStatusView ?? INITIAL_API_KEY_STATUS_VIEW;
  return {
    availableRows: props.availableRows,
    entries: CLI_STATE_SETTINGS,
    readValue: (entry) => readSetting(entry, stores, 'cli'),
    writeValue: async (entry, value) => {
      await writeSetting(entry, value, stores, 'cli');
      if (entry.category === 'git') applyCliGitAuthorConfig(stores.config);
      if (MODEL_ROUTING_SETTING_KEYS.has(entry.key)) {
        if (entry.key === GlobalStateKey.KIMI_CODE_PREFER && value === true) {
          // Dual-backend Kimi routing refuses the OpenRouter toggle, so enabling
          // the preference here turns that toggle off like `/api kimi-code`.
          const openRouter = stateSettingByKey(GlobalStateKey.USE_OPENROUTER);
          if (openRouter) await writeSetting(openRouter, false, stores, 'cli');
        }
        refreshSubscriptionPreferenceViews();
        if (entry.key === GlobalStateKey.USE_OPENROUTER && value === true) {
          await props.onApiModePersonal?.();
        }
      }
    },
    resetValue: async (entry) => {
      await resetSetting(entry, stores, 'cli');
      if (entry.category === 'git') applyCliGitAuthorConfig(stores.config);
      if (MODEL_ROUTING_SETTING_KEYS.has(entry.key)) {
        refreshSubscriptionPreferenceViews();
      }
    },
    formLinks: [
      {
        name: 'agents',
        label: 'Agents',
        description: 'workspace roster and user default team',
      },
      {
        name: 'api-keys',
        label: 'API keys',
        description: formatProviderApiKeySummary(apiKeyStatusView),
      },
    ],
    formRenderers: {
      agents: (onBack) => (
        <AgentRosterForm
          availableRows={props.availableRows}
          onClose={onBack}
          onError={props.onError}
        />
      ),
      'api-keys': (onBack) => (
        <ProviderApiKeyForm
          availableRows={props.availableRows}
          statusView={apiKeyStatusView}
          onSave={async (provider, key) => {
            await saveProviderApiKey(provider, key);
            props.markProviderApiKeySet?.(provider);
            await props.refreshApiKeyStatuses?.();
            await props.onApiModePersonal?.();
          }}
          onDone={onBack}
          onCancel={onBack}
        />
      ),
      tools: (onBack) => (
        <ToolsListForm availableRows={props.availableRows} onClose={onBack} />
      ),
    },
    openForm: props.openExternalForm,
    onClose: props.onClose,
    onError: props.onError,
  };
}

/** Canonical CLI configuration form, shared by `texra config` and `/config`. */
export function CliConfigForm(props: CliConfigFormProps): React.JSX.Element {
  const [stores] = useState(() => props.stores ?? cliSettingsStores());
  const [apiKeyStatusView, setApiKeyStatusView] =
    useState<ProviderApiKeyStatusView>(INITIAL_API_KEY_STATUS_VIEW);
  const mounted = useRef(false);
  const requestSequence = useRef(0);
  const onError = useRef(props.onError);
  onError.current = props.onError;

  const markProviderApiKeySet = useCallback((provider: ApiProvider) => {
    if (!mounted.current) return;
    setApiKeyStatusView((current) => ({
      statuses: { ...current.statuses, [provider]: 'set' },
      loading: current.loading,
      error: false,
    }));
  }, []);

  const refreshApiKeyStatuses = useCallback(async () => {
    const request = ++requestSequence.current;
    if (mounted.current) {
      setApiKeyStatusView((current) => ({
        ...current,
        loading: true,
        error: false,
      }));
    }
    try {
      const statuses = await loadProviderApiKeyStatuses();
      if (!mounted.current || request !== requestSequence.current) return;
      setApiKeyStatusView({ statuses, loading: false, error: false });
    } catch (error: unknown) {
      if (!mounted.current || request !== requestSequence.current) return;
      setApiKeyStatusView((current) => ({
        ...current,
        loading: false,
        error: true,
      }));
      onError.current?.(error);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refreshApiKeyStatuses();
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
    };
  }, [refreshApiKeyStatuses]);

  return (
    <ConfigForm
      {...createCliConfigFormProps({
        ...props,
        stores,
        apiKeyStatusView,
        markProviderApiKeySet,
        refreshApiKeyStatuses,
      })}
    />
  );
}
