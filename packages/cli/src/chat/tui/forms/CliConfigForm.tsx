import { Effect } from 'effect';

import { commitCliProviderApiKey } from '@cli/chat/tui/hosts/cliProviderKeys';
import { storeCredential } from '@common/secrets/storeCredential';
import { API_PROVIDERS, loadApiKeyStatusMap } from '@model/apiProviders';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import {
  CLI_STATE_SETTINGS,
  type SurfacedSettingEntry,
} from '@shared/state/stateSettings';
import {
  readSetting,
  type SettingsStores,
} from '@shared/config/settingsAccess';
import { applyStateSettingUpdate } from '@shared/settingsView/handlers/stateSettingWrite';
import {
  GITHUB_TOKEN_STORAGE_KEY,
  resolveGitHubTokenSource,
} from '@tools/github/githubAuth';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { bumpCodexPreferenceVersion } from '../state/cliState';
import { AgentRosterForm } from './AgentRosterForm';
import { ConfigForm } from './ConfigForm';
import { useAsyncListForm, useAsyncResource } from './_shared/useAsyncListForm';
import { renderAsyncListFormTransient } from './_shared/FormFrame';
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
import { SkillsSettingsForm } from './SkillsSettingsForm';

export interface CliConfigFormProps {
  readonly availableRows?: number;
  /** The settings slots this form reads and writes: the surface's own roots. */
  readonly stores: SettingsStores;
  /**
   * The secret store the API-key and GitHub-token rows read and write. Ink
   * components run no Effect, so the process store arrives as a prop from the
   * surface that opened this form.
   */
  readonly secrets: PlatformSecrets;
  /** The process runtime the tools row's probes run on, from the same surface. */
  readonly runtime: ProcessRuntime;
  /** The project the process opened, for the probes that need a workspace. */
  readonly workspaceRoot: string | undefined;
  readonly onClose: () => void;
  readonly onError?: (error: unknown) => void;
  /**
   * Applies the approval-policy side effect when that row is written here — the
   * chat TUI's live-session hook, identical to the one `/approval` drives.
   * Omitted by `texra config edit`, whose process holds no session to update.
   */
  readonly onApprovalPolicyChanged?: (policy: TexraApprovalPolicy) => void;
}

/**
 * Canonical CLI configuration form. Both `texra config` and `/config` mount
 * it, so persistence and runtime side effects cannot diverge between them.
 */
export function CliConfigForm(props: CliConfigFormProps): React.JSX.Element {
  const { stores, secrets, runtime } = props;
  // The status reads are programs like the save and remove rows below them,
  // so this surface settles all of them on the runtime it was handed.
  const apiKeys = useAsyncResource({
    load: () => loadApiKeyStatusMap(secrets, API_PROVIDERS),
    runtime,
    onError: props.onError,
  });
  const apiKeyStatusView: ProviderApiKeyStatusView = {
    statuses: apiKeys.data,
    loading: apiKeys.loading,
    error: apiKeys.error !== undefined,
  };
  const githubToken = useAsyncResource({
    load: () => resolveGitHubTokenSource(secrets),
    runtime,
    onError: props.onError,
  });
  const githubTokenStatusView: GitHubTokenStatusView = {
    status: githubToken.data,
    loading: githubToken.loading,
    error: githubToken.error !== undefined,
  };

  const settings = useAsyncListForm<Record<string, unknown>>({
    load: () =>
      Effect.map(
        Effect.forEach(CLI_STATE_SETTINGS, (entry) =>
          Effect.map(
            readSetting(entry, stores, 'cli'),
            (value) => [entry.key, value] as const,
          ),
        ),
        Object.fromEntries,
      ),
    runtime,
    onClose: props.onClose,
    onError: props.onError,
  });

  // The one CLI write path for a `/config` row: the same
  // `applyStateSettingUpdate` the extension and desktop settings views call, so
  // a row that carries a live side effect (approval policy) cannot be persisted
  // from here while the running session keeps enforcing the old value. The
  // catalog row still owns the write consequences below it — `writeSetting`
  // applies the declared mutual exclusions (Kimi Code clears OpenRouter) and
  // `onWrite.invalidatesModelOptions` marks the rows whose change re-routes
  // models — so this form keeps no key list of its own. `null` is the shared
  // reset convention (delete the key so the schema default reappears).
  const applyUpdate = (
    entry: SurfacedSettingEntry,
    value: unknown,
  ): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      const result = yield* applyStateSettingUpdate(entry.key, value, {
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
          // ConfigForm rolls its optimistic value back on a failure and
          // reports it, so a refused write must fail rather than read as
          // applied.
          return yield* Effect.fail(
            new Error(
              `Failed to update "${label}": ${toErrorMessage(result.error)}`,
              { cause: result.error },
            ),
          );
        case 'ignored':
        case 'workspace-required':
          return yield* Effect.fail(
            new Error(
              `Setting "${label}" is not writable from /config (${result.kind}).`,
            ),
          );
      }
      settings.reload();
      if (entry.onWrite?.invalidatesModelOptions) {
        bumpCodexPreferenceVersion();
      }
    });

  const transient = renderAsyncListFormTransient({
    loading: settings.data === undefined && settings.loading,
    error: settings.error,
    title: '/config',
    loadingLabel: 'Loading settings...',
  });
  if (transient) return transient;

  return (
    <ConfigForm
      availableRows={props.availableRows}
      entries={CLI_STATE_SETTINGS}
      readValue={(entry) => settings.data?.[entry.key]}
      writeValue={(entry, value) => applyUpdate(entry, value)}
      resetValue={(entry) => applyUpdate(entry, null)}
      runtime={runtime}
      formLinks={[
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
      ]}
      formRenderers={{
        agents: (onBack) => (
          <AgentRosterForm
            runtime={props.runtime}
            stores={stores}
            workspaceRoot={props.workspaceRoot}
            availableRows={props.availableRows}
            onClose={onBack}
            onError={props.onError}
          />
        ),
        'api-keys': (onBack) => (
          <ProviderApiKeyForm
            availableRows={props.availableRows}
            statusView={apiKeyStatusView}
            runtime={runtime}
            // The save and the refresh that follows it are one program; the
            // form settles it on the runtime this surface handed it.
            onSave={(provider, key) =>
              Effect.gen(function* () {
                yield* commitCliProviderApiKey(secrets, stores, provider, key);
                apiKeys.setData(
                  (current) => current && { ...current, [provider]: 'set' },
                );
                yield* apiKeys.refresh();
              })
            }
            onDone={onBack}
            onCancel={onBack}
          />
        ),
        'github-token': (onBack) => (
          <GitHubTokenForm
            availableRows={props.availableRows}
            statusView={githubTokenStatusView}
            runtime={runtime}
            onSave={(token) =>
              Effect.gen(function* () {
                yield* storeCredential(secrets, {
                  secretName: GITHUB_TOKEN_STORAGE_KEY,
                  value: token,
                  kind: 'github',
                });
                githubToken.setData(() => 'secret');
                yield* githubToken.refresh();
              })
            }
            onRemove={() =>
              Effect.gen(function* () {
                yield* secrets.delete(GITHUB_TOKEN_STORAGE_KEY);
                yield* githubToken.refresh();
              })
            }
            onDone={onBack}
            onCancel={onBack}
          />
        ),
        tools: (onBack) => (
          <ToolsListForm
            availableRows={props.availableRows}
            state={stores.globalState}
            runtime={props.runtime}
            workspaceRoot={props.workspaceRoot}
            config={stores.config}
            onClose={onBack}
          />
        ),
        skills: (onBack) => (
          <SkillsSettingsForm
            availableRows={props.availableRows}
            stores={stores}
            workspaceRoot={props.workspaceRoot}
            runtime={props.runtime}
            onClose={onBack}
          />
        ),
      }}
      onClose={props.onClose}
      onError={props.onError}
    />
  );
}
