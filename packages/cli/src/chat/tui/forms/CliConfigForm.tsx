import { useCallback, useEffect, useRef, useState } from 'react';

import { cliSettingsStores } from '@cli/runtime/settingsStores';
import { applyCliGitAuthorConfig } from '@cli/runtime/gitAuthor';
import {
  loadGitHubTokenStatus,
  removeGitHubToken,
  saveGitHubToken,
} from '@cli/runtime/githubToken';
import {
  loadProviderApiKeyStatuses,
  saveProviderApiKey,
} from '@cli/runtime/providerApiKey';
import type { ApiProvider } from '@model/apiProviders';
import { CLI_STATE_SETTINGS } from '@shared/schemas';
import {
  readSetting,
  resetSetting,
  writeSetting,
  type SettingsStores,
} from '@shared/config/settingsAccess';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { setPreferKimiCode } from '@utils/config/providerConfig';

import { refreshSubscriptionPreferenceViews } from '../state/codexSubscription';
import { AgentRosterForm } from './AgentRosterForm';
import { ConfigForm, type ConfigFormProps } from './ConfigForm';
import {
  formatGitHubTokenSummary,
  GitHubTokenForm,
  type GitHubTokenStatusView,
} from './GitHubTokenForm';
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
  readonly githubTokenStatusView?: GitHubTokenStatusView;
  readonly markGitHubTokenSet?: () => void;
  readonly refreshGitHubTokenStatus?: () => void | Promise<void>;
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

const INITIAL_GITHUB_TOKEN_STATUS_VIEW: GitHubTokenStatusView = {
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
  const githubTokenStatusView =
    props.githubTokenStatusView ?? INITIAL_GITHUB_TOKEN_STATUS_VIEW;
  return {
    availableRows: props.availableRows,
    entries: CLI_STATE_SETTINGS,
    readValue: (entry) => readSetting(entry, stores, 'cli'),
    writeValue: async (entry, value) => {
      if (entry.key === GlobalStateKey.KIMI_CODE_PREFER) {
        // The runtime owner carries the OpenRouter mutual exclusion, so the
        // form and `/api kimi-code` cannot drift.
        await setPreferKimiCode(value === true, stores.globalState);
      } else {
        await writeSetting(entry, value, stores, 'cli');
      }
      if (entry.category === 'git') applyCliGitAuthorConfig(stores.config);
      if (MODEL_ROUTING_SETTING_KEYS.has(entry.key)) {
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
      {
        name: 'github-token',
        label: 'GitHub token',
        description: formatGitHubTokenSummary(githubTokenStatusView),
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
      'github-token': (onBack) => (
        <GitHubTokenForm
          availableRows={props.availableRows}
          statusView={githubTokenStatusView}
          onSave={async (token) => {
            await saveGitHubToken(token);
            props.markGitHubTokenSet?.();
            await props.refreshGitHubTokenStatus?.();
          }}
          onRemove={async () => {
            await removeGitHubToken();
            await props.refreshGitHubTokenStatus?.();
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
  const [githubTokenStatusView, setGitHubTokenStatusView] =
    useState<GitHubTokenStatusView>(INITIAL_GITHUB_TOKEN_STATUS_VIEW);
  const mounted = useRef(false);
  const requestSequence = useRef(0);
  const githubTokenRequestSequence = useRef(0);
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

  const markGitHubTokenSet = useCallback(() => {
    if (!mounted.current) return;
    setGitHubTokenStatusView((current) => ({
      status: 'secret',
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

  const refreshGitHubTokenStatus = useCallback(async () => {
    const request = ++githubTokenRequestSequence.current;
    if (mounted.current) {
      setGitHubTokenStatusView((current) => ({
        ...current,
        loading: true,
        error: false,
      }));
    }
    try {
      const status = await loadGitHubTokenStatus();
      if (!mounted.current || request !== githubTokenRequestSequence.current) {
        return;
      }
      setGitHubTokenStatusView({ status, loading: false, error: false });
    } catch (error: unknown) {
      if (!mounted.current || request !== githubTokenRequestSequence.current) {
        return;
      }
      setGitHubTokenStatusView((current) => ({
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
    void refreshGitHubTokenStatus();
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
      githubTokenRequestSequence.current += 1;
    };
  }, [refreshApiKeyStatuses, refreshGitHubTokenStatus]);

  return (
    <ConfigForm
      {...createCliConfigFormProps({
        ...props,
        stores,
        apiKeyStatusView,
        markProviderApiKeySet,
        refreshApiKeyStatuses,
        githubTokenStatusView,
        markGitHubTokenSet,
        refreshGitHubTokenStatus,
      })}
    />
  );
}
