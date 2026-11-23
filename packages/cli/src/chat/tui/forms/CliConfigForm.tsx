import {
  Secrets,
  Settings,
  type AppSignals,
} from '@texra-ai/worldline/plugins';
import { Effect } from 'effect';

import { apiKeyOrigins } from '@texra-ai/llm';
import { tuiUi } from '@cli/chat/tui/hosts/tuiUiHost';
import { commitProviderKey } from '@texra/controllers/settingsView/providerKeyActions';
import { SettingsRequestFailed } from '@texra/controllers/settingsView/settingsHostBindings';
import { TEXRA_SETTINGS } from '@texra/shared/settings/texraSettings';
import {
  applyStateSettingUpdate,
  settingWriteFailure,
} from '@texra/controllers/settingsView/stateSettingWrite';
import type { TexraSettingRow } from '@texra/shared/settings/settingSurfaces';
import {
  removeGitHubToken,
  resolveGitHubTokenSource,
  saveGitHubToken,
} from '@texra/tools/github/githubAuth';

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
import { SkillsSettingsForm } from './SkillsSettingsForm';
import { useChatProcess } from '../chatProcess';

export interface CliConfigFormProps {
  readonly availableRows: number;
  readonly onClose: () => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * Canonical CLI configuration form. Both `texra config` and `/config` mount
 * it, so persistence and runtime side effects cannot diverge between them.
 */
export function CliConfigForm(props: CliConfigFormProps): React.JSX.Element {
  const { roots } = useChatProcess();
  const apiKeys = useAsyncResource({
    load: () => Effect.flatMap(Secrets, apiKeyOrigins),
    onError: props.onError,
  });
  const apiKeyStatusView: ProviderApiKeyStatusView = {
    statuses: apiKeys.data,
    loading: apiKeys.loading,
    error: apiKeys.error !== undefined,
  };
  const githubToken = useAsyncResource({
    load: () => Effect.flatMap(Secrets, resolveGitHubTokenSource),
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
        Effect.forEach(TEXRA_SETTINGS.cliRows, (entry) =>
          Effect.map(
            Settings.get(roots, entry),
            (value) => [entry.key, value] as const,
          ),
        ),
        Object.fromEntries,
      ),
    onClose: props.onClose,
    onError: props.onError,
  });

  // The one CLI write path for a `/config` row: the same
  // `applyStateSettingUpdate` the extension and desktop settings views call.
  // The write announces what it changed to the process, which is how the
  // chat repaints its policy line. `null` is the shared reset convention
  // (delete the key so the schema default reappears).
  const applyUpdate = Effect.fn('applyUpdate')(function* (
    entry: TexraSettingRow,
    value: unknown,
  ): Effect.fn.Return<void, SettingsRequestFailed, AppSignals | Secrets> {
    const result = yield* applyStateSettingUpdate(entry, value, roots);
    // ConfigForm rolls its optimistic value back on a failure and reports
    // it, so a refused write must fail rather than read as applied.
    const failure = settingWriteFailure(result);
    if (failure !== undefined) return yield* failure;
    if (result.kind === 'ignored') return;
    settings.reload();
  });

  const transient = renderAsyncListFormTransient({
    loading: settings.data === undefined && settings.loading,
    error: settings.error,
    title: '/config',
    loadingLabel: 'Loading settings…',
  });
  if (transient) return transient;

  return (
    <ConfigForm
      availableRows={props.availableRows}
      entries={TEXRA_SETTINGS.cliRows}
      readValue={(entry) => settings.data?.[entry.key]}
      writeValue={(entry, value) => applyUpdate(entry, value)}
      resetValue={(entry) => applyUpdate(entry, null)}
      formLinks={[
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
        'api-keys': (onBack) => (
          <ProviderApiKeyForm
            availableRows={props.availableRows}
            statusView={apiKeyStatusView}
            // The save and the refresh that follows it are one program.
            onSave={(provider, key) =>
              Effect.gen(function* () {
                yield* commitProviderKey(tuiUi, roots, provider, key);
                apiKeys.setData(
                  (current) => current && { ...current, [provider]: 'secret' },
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
            onSave={(token) =>
              Effect.gen(function* () {
                yield* saveGitHubToken(token);
                githubToken.setData(() => 'secret');
                yield* githubToken.refresh();
              })
            }
            onRemove={() =>
              Effect.gen(function* () {
                yield* removeGitHubToken;
                yield* githubToken.refresh();
              })
            }
            onDone={onBack}
            onCancel={onBack}
          />
        ),
        skills: (onBack) => (
          <SkillsSettingsForm
            availableRows={props.availableRows}
            onClose={onBack}
          />
        ),
      }}
      onClose={props.onClose}
      onError={props.onError}
    />
  );
}
