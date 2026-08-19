import { useCallback, useEffect, useRef, useState } from 'react';

import { cliSettingsStores } from '@cli/runtime/settingsStores';
import { applyCliGitAuthorConfig } from '@cli/runtime/gitAuthor';
import {
  loadGitHubTokenStatus,
  removeGitHubToken,
  saveGitHubToken,
  type GitHubTokenStatus,
} from '@cli/runtime/githubToken';
import {
  loadProviderApiKeyStatuses,
  saveProviderApiKey,
} from '@cli/runtime/providerApiKey';
import type { ApiKeyStatus, ApiProvider } from '@model/apiProviders';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import { CLI_STATE_SETTINGS, type SurfacedSettingEntry } from '@shared/schemas';
import {
  readSetting,
  type SettingsStores,
} from '@shared/config/settingsAccess';
import { applyStateSettingUpdate } from '@shared/settingsView/handlers/stateSettingWrite';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { refreshSubscriptionPreferenceViews } from '../state/subscriptionPreference';
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
  /**
   * Applies the approval-policy side effect when that row is written here — the
   * chat TUI's live-session hook, identical to the one `/approval` drives.
   * Omitted by `texra config edit`, whose process holds no session to update.
   */
  readonly onApprovalPolicyChanged?: (policy: TexraApprovalPolicy) => void;
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

type StatusViewBase = { readonly loading: boolean; readonly error: boolean };

const INITIAL_STATUS_VIEW: StatusViewBase = Object.freeze({
  loading: true,
  error: false,
} as const);

function useAsyncStatusView<Status, View extends StatusViewBase>(options: {
  readonly initial: View;
  readonly load: () => Promise<Status>;
  readonly buildView: (status: Status) => View;
  readonly onErrorRef: {
    readonly current: ((error: unknown) => void) | undefined;
  };
}): {
  readonly view: View;
  readonly refresh: () => Promise<void>;
  readonly mark: (updater: (current: View) => Partial<View>) => void;
} {
  const [view, setView] = useState<View>(options.initial);
  const mounted = useRef(false);
  const requestSequence = useRef(0);

  const mark = useCallback((updater: (current: View) => Partial<View>) => {
    if (!mounted.current) return;
    setView(
      (current) =>
        ({
          ...current,
          ...updater(current),
          loading: current.loading,
          error: false,
        }) as View,
    );
  }, []);

  const refresh = useCallback(async () => {
    const request = ++requestSequence.current;
    if (mounted.current) {
      setView(
        (current) => ({ ...current, loading: true, error: false }) as View,
      );
    }
    try {
      const status = await options.load();
      if (!mounted.current || request !== requestSequence.current) return;
      setView(options.buildView(status));
    } catch (error: unknown) {
      if (!mounted.current || request !== requestSequence.current) return;
      setView(
        (current) => ({ ...current, loading: false, error: true }) as View,
      );
      options.onErrorRef.current?.(error);
    }
  }, [options.load, options.buildView, options.onErrorRef]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
    };
  }, [refresh]);

  return { view, refresh, mark };
}

const buildApiKeyStatusView = (
  statuses: Record<ApiProvider, ApiKeyStatus>,
): ProviderApiKeyStatusView => ({ statuses, loading: false, error: false });

const buildGitHubTokenStatusView = (
  status: GitHubTokenStatus,
): GitHubTokenStatusView => ({ status, loading: false, error: false });

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
    props.apiKeyStatusView ?? (INITIAL_STATUS_VIEW as ProviderApiKeyStatusView);
  const githubTokenStatusView =
    props.githubTokenStatusView ??
    (INITIAL_STATUS_VIEW as GitHubTokenStatusView);
  // The one CLI write path for a `/config` row: the same
  // `applyStateSettingUpdate` the extension and desktop settings views call, so
  // a row that carries a live side effect (approval policy) cannot be persisted
  // from here while the running session keeps enforcing the old value. The
  // catalog row still owns the write consequences below it — `writeSetting`
  // applies the declared mutual exclusions (Kimi Code clears OpenRouter) and
  // `onWrite.invalidatesModelOptions` marks the rows whose change re-routes
  // models — so this form keeps no key list of its own. `null` is the shared
  // reset convention (delete the key so the schema default reappears).
  const applyUpdate = async (
    entry: SurfacedSettingEntry,
    value: unknown,
  ): Promise<void> => {
    const result = await applyStateSettingUpdate(entry.key, value, {
      host: 'cli',
      stores,
      onApprovalPolicyChanged: props.onApprovalPolicyChanged,
    });
    const label = entry.title ?? entry.key;
    switch (result.kind) {
      case 'applied':
        break;
      case 'rejected':
      case 'failed':
        // ConfigForm rolls its optimistic value back on a rejection and reports
        // it, so a refused write must throw rather than read as applied.
        throw new Error(
          `Failed to update "${label}": ${toErrorMessage(result.error)}`,
          { cause: result.error },
        );
      case 'ignored':
      case 'workspace-required':
        throw new Error(
          `Setting "${label}" is not writable from /config (${result.kind}).`,
        );
    }
    if (entry.category === 'git') applyCliGitAuthorConfig(stores.config);
    if (entry.onWrite?.invalidatesModelOptions) {
      refreshSubscriptionPreferenceViews();
    }
  };
  return {
    availableRows: props.availableRows,
    entries: CLI_STATE_SETTINGS,
    readValue: (entry) => readSetting(entry, stores, 'cli'),
    writeValue: (entry, value) => applyUpdate(entry, value),
    resetValue: (entry) => applyUpdate(entry, null),
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
  const onError = useRef(props.onError);
  onError.current = props.onError;

  const {
    view: apiKeyStatusView,
    refresh: refreshApiKeyStatuses,
    mark: markApiKey,
  } = useAsyncStatusView({
    initial: INITIAL_STATUS_VIEW as ProviderApiKeyStatusView,
    load: loadProviderApiKeyStatuses,
    buildView: buildApiKeyStatusView,
    onErrorRef: onError,
  });

  const {
    view: githubTokenStatusView,
    refresh: refreshGitHubTokenStatus,
    mark: markGitHubToken,
  } = useAsyncStatusView({
    initial: INITIAL_STATUS_VIEW as GitHubTokenStatusView,
    load: loadGitHubTokenStatus,
    buildView: buildGitHubTokenStatusView,
    onErrorRef: onError,
  });

  const markProviderApiKeySet = useCallback(
    (provider: ApiProvider) => {
      markApiKey((current) => ({
        statuses: { ...current.statuses, [provider]: 'set' },
      }));
    },
    [markApiKey],
  );

  const markGitHubTokenSet = useCallback(() => {
    markGitHubToken(() => ({ status: 'secret' }));
  }, [markGitHubToken]);

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
