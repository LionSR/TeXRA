import { Cause, Effect } from 'effect';
import { useCallback, useEffect, useRef, useState } from 'react';

import { commitCliProviderApiKey } from '@cli/chat/tui/hosts/cliProviderKeys';
import { storeCredential } from '@common/secrets/storeCredential';
import {
  API_PROVIDERS,
  loadApiKeyStatusMap,
  type ApiKeyStatus,
  type ApiProvider,
} from '@model/apiProviders';
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
import { useAsyncListForm } from './_shared/useAsyncListForm';
import { renderAsyncListFormTransient } from './_shared/FormFrame';
import {
  formatGitHubTokenSummary,
  GitHubTokenForm,
  type GitHubTokenStatus,
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

type StatusViewBase = { readonly loading: boolean; readonly error: boolean };

const INITIAL_STATUS_VIEW: StatusViewBase = Object.freeze({
  loading: true,
  error: false,
} as const);

function useAsyncStatusView<Status, View extends StatusViewBase>(options: {
  readonly initial: View;
  /**
   * The status read, as the program its module exposes. The hook settles it
   * on the surface's runtime and recovers from the whole cause there, so a
   * failed read reaches the view without a Promise rejection in between.
   */
  readonly load: () => Effect.Effect<Status, Error>;
  readonly runtime: ProcessRuntime;
  readonly buildView: (status: Status) => View;
  readonly onErrorRef: {
    readonly current: ((error: unknown) => void) | undefined;
  };
}): {
  readonly view: View;
  /** The read as a program: the mount runs it, and a row that writes first
   *  sequences it after its own write in one run. */
  readonly refresh: () => Effect.Effect<void>;
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

  // `suspend` so the sequence number is claimed when the read starts, not
  // when its program is built: a row that composes this after a write must
  // not reserve the slot before that write lands.
  const refresh = useCallback(
    (): Effect.Effect<void> =>
      Effect.suspend(() => {
        const request = ++requestSequence.current;
        if (mounted.current) {
          setView(
            (current) => ({ ...current, loading: true, error: false }) as View,
          );
        }
        return options.load().pipe(
          Effect.matchCause({
            onSuccess: (status) => {
              if (!mounted.current || request !== requestSequence.current) {
                return;
              }
              setView(options.buildView(status));
            },
            onFailure: (cause) => {
              if (!mounted.current || request !== requestSequence.current) {
                return;
              }
              setView(
                (current) =>
                  ({ ...current, loading: false, error: true }) as View,
              );
              // The squashed cause is the value the runtime would have
              // rejected this read with, so the surface's error hook still
              // sees the failure the status module reported.
              options.onErrorRef.current?.(Cause.squash(cause));
            },
          }),
        );
      }),
    [options.load, options.buildView, options.onErrorRef],
  );

  useEffect(() => {
    mounted.current = true;
    void options.runtime.runPromise(refresh());
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
    };
  }, [refresh, options.runtime]);

  return { view, refresh, mark };
}

const buildApiKeyStatusView = (
  statuses: Record<ApiProvider, ApiKeyStatus>,
): ProviderApiKeyStatusView => ({ statuses, loading: false, error: false });

const buildGitHubTokenStatusView = (
  status: GitHubTokenStatus,
): GitHubTokenStatusView => ({ status, loading: false, error: false });

/**
 * Canonical CLI configuration form. Both `texra config` and `/config` mount
 * it, so persistence and runtime side effects cannot diverge between them.
 */
export function CliConfigForm(props: CliConfigFormProps): React.JSX.Element {
  const { stores } = props;
  const onError = useRef(props.onError);
  onError.current = props.onError;
  const { secrets } = props;
  const { runtime } = props;
  const loadApiKeyStatuses = useCallback(
    () => loadApiKeyStatusMap(secrets, API_PROVIDERS),
    [secrets],
  );
  // The status read is a program like the save and remove rows below it, so
  // this surface settles all three on the runtime it was handed.
  const loadGitHubToken = useCallback(
    () => resolveGitHubTokenSource(secrets),
    [secrets],
  );

  const {
    view: apiKeyStatusView,
    refresh: refreshApiKeyStatuses,
    mark: markApiKey,
  } = useAsyncStatusView({
    initial: INITIAL_STATUS_VIEW as ProviderApiKeyStatusView,
    load: loadApiKeyStatuses,
    runtime,
    buildView: buildApiKeyStatusView,
    onErrorRef: onError,
  });

  const {
    view: githubTokenStatusView,
    refresh: refreshGitHubTokenStatus,
    mark: markGitHubToken,
  } = useAsyncStatusView({
    initial: INITIAL_STATUS_VIEW as GitHubTokenStatusView,
    load: loadGitHubToken,
    runtime,
    buildView: buildGitHubTokenStatusView,
    onErrorRef: onError,
  });

  const settings = useAsyncListForm<Record<string, unknown>>({
    load: () =>
      runtime.runPromise(
        Effect.map(
          Effect.forEach(CLI_STATE_SETTINGS, (entry) =>
            Effect.map(
              readSetting(entry, stores, 'cli'),
              (value) => [entry.key, value] as const,
            ),
          ),
          Object.fromEntries,
        ),
      ),
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
                markApiKey((current) => ({
                  statuses: { ...current.statuses, [provider]: 'set' },
                }));
                yield* refreshApiKeyStatuses();
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
                markGitHubToken(() => ({ status: 'secret' }));
                yield* refreshGitHubTokenStatus();
              })
            }
            onRemove={() =>
              Effect.gen(function* () {
                yield* secrets.delete(GITHUB_TOKEN_STORAGE_KEY);
                yield* refreshGitHubTokenStatus();
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
