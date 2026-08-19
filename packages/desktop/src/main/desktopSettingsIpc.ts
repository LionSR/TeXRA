import type { SessionHandle } from '@agent/runtime';
import { formatError } from '@common/errors';
import { SettingsViewHost } from '@controllers/settingsView/SettingsViewHost';
import {
  listGitHubSubscriptionEntries,
  unsubscribeGitHubKey,
} from '@controllers/settingsView/githubSubscriptions';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import type { ConfigProvider } from '@platform/interfaces';
import { platform } from '@platform/platform';
import { resolveMemoryStoragePath } from '@platform/defaults/workspaceStorage';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  dispatchSettingsViewInbound,
  SettingsViewInboundMessageSchema,
  type DerivedSettingsSnapshot,
  type SettingsViewInboundHandlerRegistry,
} from '@shared/schemas';
import {
  applyStateSettingUpdate,
  postStateSettingSnapshot,
  type SettingsSnapshotPosters,
} from '@shared/settingsView/handlers/stateSettingWrite';
import { unsupported, unsupportedCommands } from '@shared/utils/dispatcher';
import { buildSettingsSnapshotMessage } from '@shared/settingsView/handlers/settingsSnapshot';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { SettingsStatePorts } from '@shared/settingsView/types';
import { GoalStore, subscribeGoalStateChanges } from '@tools/goal';
import {
  GITHUB_TOKEN_CREATE_URL,
  GITHUB_TOKEN_STORAGE_KEY,
  resolveGitHubTokenSource,
} from '@tools/github/githubAuth';
import { StorageFS } from '@utils/files/storageFS';
import {
  applyGitAuthorSettings,
  readGitAuthorSettingsFromState,
} from '@utils/system/gitAuthorSettings';
import {
  createDesktopErrorReporter,
  type DesktopCommandMessage,
  type DesktopMessageHandler,
} from './desktopIpcTypes.js';
import type { DesktopStreamRevealResult } from './desktopAgentExecution.js';
import type { DesktopAgentSettingsController } from './desktopAgentSettingsController.js';
import type { DesktopCredentialSettingsController } from './desktopCredentialSettingsController.js';
import type { DesktopToolingSettingsController } from './desktopToolingSettingsController.js';

export interface DesktopSettingsUiHost {
  openPath(filePath: string): Promise<void>;
  /**
   * Select the stream as the window's active stream. `'unavailable'` covers a
   * presentation that could not be reached at all; the reveal is then reported
   * through {@link DesktopSettingsUiHost.onError} rather than here.
   */
  revealStream(
    streamId: string,
  ): Promise<DesktopStreamRevealResult | 'unavailable'>;
  /**
   * Display label for a stream, used by the Git tab to name each subscription's
   * owning agent run. Returns undefined when no presentation is attached, in
   * which case the raw stream id is shown.
   */
  getStreamLabel(streamId: string): string | undefined;
  /** Prompt for a secret (masked). Used for the GitHub personal access token. */
  promptForSecret?(input: {
    title: string;
    prompt: string;
  }): Promise<string | undefined>;
  openExternal?(url: string): Promise<void>;
  showInfoMessage(message: string): Promise<void>;
  showErrorMessage(message: string): Promise<void>;
  confirmAction(message: string, confirmLabel?: string): Promise<boolean>;
  onError(error: unknown): void;
}

export interface DesktopSettingsIpcOptions {
  postToRenderer(message: unknown): void;
  agentSettingsController: DesktopAgentSettingsController;
  credentialSettingsController: DesktopCredentialSettingsController;
  toolingSettingsController: DesktopToolingSettingsController;
  state: SettingsStatePorts;
  config: ConfigProvider;
  ui: DesktopSettingsUiHost;
  /**
   * Process-owned session the desktop runs execute in. Goal mutations are
   * emitted on it, so the Goals tab follows a run without a manual refresh.
   * The desktop has no process-default session, so it must be passed.
   */
  session: Pick<SessionHandle, 'events' | 'setApprovalPolicy'>;
}

export interface DesktopSettingsIpc extends DesktopMessageHandler {
  refreshAuthDependentData(options?: {
    deferAgentCatalogRefresh?: boolean;
  }): Promise<void>;
  signInChatGpt(): Promise<void>;
}

export function createDesktopSettingsIpc(
  options: DesktopSettingsIpcOptions,
): DesktopSettingsIpc {
  const { globalState, workspaceState } = options.state;
  // Commands declared `unsupported(...)` in settingsHandlers below surface as
  // a visible info dialog instead of a console-only error log.
  const onError = createDesktopErrorReporter(options.ui.onError, (error) => {
    void options.ui.showInfoMessage(error.reason).catch(options.ui.onError);
  });
  const settingsHost = new SettingsViewHost({
    state: { workspaceState, globalState },
    respond: options.postToRenderer,
    controllers: {
      modelSelection:
        options.credentialSettingsController.modelSelectionController,
    },
    memoryPrompt: {
      confirm: (message, promptOptions) =>
        options.ui.confirmAction(message, promptOptions?.confirmLabel),
      warning: async (message) => {
        await options.ui.showInfoMessage(message);
      },
    },
  });

  function readCurrentGitAuthorSettings() {
    return readGitAuthorSettingsFromState(workspaceState);
  }

  function applyCurrentGitAuthorSettings() {
    return applyGitAuthorSettings(readCurrentGitAuthorSettings());
  }

  const settingsStores: SettingsStores = {
    config: options.config,
    workspaceState,
    globalState,
  };

  /**
   * Post one catalog-derived snapshot. The desktop build has no reliability
   * tuning of its own, so the multi-agent arm carries an empty list.
   */
  function postSettingsSnapshot(snapshot: DerivedSettingsSnapshot): void {
    const message = buildSettingsSnapshotMessage(
      snapshot,
      settingsStores,
      'desktop',
    );
    options.postToRenderer(
      snapshot === 'multi-agent'
        ? { ...message, reliabilitySettings: [] }
        : message,
    );
  }

  async function openMemoryFile(input: { storagePath: string }): Promise<void> {
    const resolvedPath = resolveMemoryStoragePath(input.storagePath);
    await options.ui.openPath(StorageFS.fullPath(resolvedPath));
  }

  async function openMemoryFolder(): Promise<void> {
    const memoryPath = resolveMemoryStoragePath();
    await StorageFS.ensureDir(memoryPath);
    await options.ui.openPath(StorageFS.fullPath(memoryPath));
  }

  async function postGoalList(): Promise<void> {
    try {
      options.postToRenderer({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST,
        items: GoalStore.list(),
      });
    } catch (error) {
      options.ui.onError(error);
      await options.ui.showErrorMessage(
        formatError('Failed to load goals', error),
      );
    }
  }

  async function postInitialSettingsData(): Promise<void> {
    // Model availability can change without a session event (a server-side
    // tier or subscription flip), so the panel must not paint a stale list.
    invalidateModelOptionsCache();
    postSettingsSnapshot('git-author');
    options.toolingSettingsController.postLatexConfigValues();
    const goalListPosted = postGoalList();
    const memoryEnabledPosted = settingsHost.sendMemoryEnabled();
    const modelSelectionDataPosted = settingsHost.sendModelSelectionData();
    postSettingsSnapshot('multi-agent');
    postSettingsSnapshot('approval');
    postSettingsSnapshot('agent-skills');
    postSettingsSnapshot('telemetry');
    await Promise.all([
      goalListPosted,
      memoryEnabledPosted,
      settingsHost.sendMemoryData(),
      modelSelectionDataPosted,
      postGitHubTokenStatus(),
      postGitHubSubscriptions(),
      options.credentialSettingsController.postStartupData(),
      options.toolingSettingsController.postStartupData(),
      options.agentSettingsController.postStartupData(),
    ]);
  }

  async function updateModelEnabled(input: {
    modelName: string;
    enabled: boolean;
  }): Promise<void> {
    await settingsHost.setModelEnabled(input, {
      afterUpdate: () => invalidateModelOptionsCache(),
      afterPost: () =>
        options.credentialSettingsController.postMainModelOptionsData(),
    });
  }

  async function refreshAuthDependentData(
    refreshOptions: { deferAgentCatalogRefresh?: boolean } = {},
  ): Promise<void> {
    await options.credentialSettingsController.refreshAuthDependentData();
    if (refreshOptions.deferAgentCatalogRefresh) return;
    await options.agentSettingsController.refreshCatalogData();
  }

  const stateSettingSnapshotPosters: SettingsSnapshotPosters = {
    'agent-skills': () => postSettingsSnapshot('agent-skills'),
    approval: () => postSettingsSnapshot('approval'),
    'git-author': () => {
      // Git identity is also process env, so the write must reach `git` before
      // the renderer is told the new value stuck.
      applyCurrentGitAuthorSettings();
      postSettingsSnapshot('git-author');
    },
    latex: () => options.toolingSettingsController.postLatexConfigValues(),
    models: () => settingsHost.sendModelSelectionData(),
    'multi-agent': () => postSettingsSnapshot('multi-agent'),
    profile: () => options.credentialSettingsController.postProfileData(),
    telemetry: () => postSettingsSnapshot('telemetry'),
  };

  /**
   * Generic write path for catalog-backed settings-view rows.
   */
  async function updateStateSetting(
    key: string,
    value: unknown,
  ): Promise<void> {
    const result = await applyStateSettingUpdate(key, value, {
      host: 'desktop',
      stores: settingsStores,
      onApprovalPolicyChanged: (policy) =>
        options.session.setApprovalPolicy(policy),
    });
    if (result.kind === 'ignored') return;
    if (result.kind === 'rejected' || result.kind === 'failed') {
      options.ui.onError(result.error);
      const label = result.entry.title ?? result.entry.key;
      const prefix =
        result.kind === 'rejected' ? 'Invalid value for' : 'Failed to update';
      await options.ui.showErrorMessage(
        formatError(`${prefix} "${label}"`, result.error),
      );
    }
    await postStateSettingSnapshot(
      result.entry.surfaces.settingsView,
      stateSettingSnapshotPosters,
    );
    if (result.kind !== 'applied') return;
    if (result.entry.onWrite?.invalidatesModelOptions) {
      invalidateModelOptionsCache();
      await options.credentialSettingsController.refreshAfterProviderSettingChange(
        key,
      );
    }
  }

  function runAsync(work: Promise<void>): void {
    void work.catch(onError);
  }

  applyCurrentGitAuthorSettings();

  // Agent runs execute in this same main process and the settings panel shares
  // the app window with run progress, so a Goals tab left open during a run
  // needs the push. Lifetime == app, matching the extension's process-global
  // stance, so there is no dispose to hold.
  subscribeGoalStateChanges(options.session, () => runAsync(postGoalList()));

  // ── GitHub token + PR/repo/issue subscriptions (Git tab) ──

  async function postGitHubTokenStatus(): Promise<void> {
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GITHUB_TOKEN_STATUS,
      status: await resolveGitHubTokenSource(platform().secrets),
    });
  }

  async function setGitHubToken(): Promise<void> {
    const token = await options.ui.promptForSecret?.({
      title: 'GitHub token',
      prompt:
        'Paste a GitHub personal access token (repo or public_repo scope)',
    });
    if (!token?.trim()) return;
    await platform().secrets.set(GITHUB_TOKEN_STORAGE_KEY, token.trim());
    await options.ui.showInfoMessage('GitHub token saved.');
    await postGitHubTokenStatus();
  }

  async function removeGitHubToken(): Promise<void> {
    await platform().secrets.delete(GITHUB_TOKEN_STORAGE_KEY);
    await options.ui.showInfoMessage('GitHub token removed.');
    await postGitHubTokenStatus();
  }

  async function postGitHubSubscriptions(): Promise<void> {
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS,
      subscriptions: listGitHubSubscriptionEntries((streamId) =>
        options.ui.getStreamLabel(streamId),
      ),
    });
  }

  /**
   * Jump from a settings entry (a goal, a PR subscription) to the run that owns
   * it. A stream deleted since the entry was written has nothing to show, so
   * say so instead of leaving the click with no visible effect.
   */
  async function revealStream(streamId: string): Promise<void> {
    const result = await options.ui.revealStream(streamId);
    if (result === 'missing') {
      await options.ui.showInfoMessage(
        'The agent stream is no longer available.',
      );
    }
  }

  async function unsubscribeGitHub(data: { key: string }): Promise<void> {
    const removed = unsubscribeGitHubKey(data.key);
    if (removed === 0) {
      await options.ui.showInfoMessage(
        `No active subscription for ${data.key}.`,
      );
      return;
    }
    await postGitHubSubscriptions();
  }

  const settingsHandlers: SettingsViewInboundHandlerRegistry = {
    // WEBVIEW_READY is intercepted in handleMessage below, before reaching
    // the dispatcher, so this entry is never actually invoked — it exists
    // only to satisfy the exhaustive registry type.
    webviewReady: () => {},
    getMemoryData: () => settingsHost.sendMemoryData(),
    getMemoryPreview: (message) =>
      settingsHost.sendMemoryPreview(message, { onError }),
    openMemoryFile,
    openMemoryFolder,
    deleteMemory: (message) => settingsHost.deleteMemory(message),
    setMemoryEnabled: (message) =>
      settingsHost.setMemoryEnabled(message.enabled),
    pinMemory: (message) =>
      settingsHost.setMemoryPinned(message.storagePath, true),
    unpinMemory: (message) =>
      settingsHost.setMemoryPinned(message.storagePath, false),
    ...options.credentialSettingsController.profileHandlers,
    setModelEnabled: updateModelEnabled,
    setModelReasoningLevel: (message) =>
      settingsHost.setReasoningLevel(message),
    requestModelAccess: unsupported('Copilot models require VS Code.'),
    clearCopilotRoute: unsupported('Copilot models require VS Code.'),
    ...options.agentSettingsController.handlers,
    // Mirrors the extension's `GitHubSubscriptionHandlers`. The token store and
    // the subscription registry are host-agnostic (`@tools/github`); only the
    // secret prompt, the browser hand-off, and the stream reveal differ here.
    getGitHubTokenStatus: postGitHubTokenStatus,
    setGitHubToken,
    removeGitHubToken,
    openGitHubTokenUrl: async () => {
      await options.ui.openExternal?.(GITHUB_TOKEN_CREATE_URL);
    },
    getPRSubscriptions: postGitHubSubscriptions,
    unsubscribePR: unsubscribeGitHub,
    openPRSubscriptionStream: (message) => revealStream(message.streamId),
    ...options.credentialSettingsController.chatGptHandlers,
    ...options.credentialSettingsController.grokHandlers,
    getSubscriptionUsage: (message) =>
      options.credentialSettingsController.postSubscriptionUsage(
        message.forceRefresh ?? false,
      ),
    updateStateSetting: (message) =>
      updateStateSetting(message.key, message.value),
    ...options.toolingSettingsController.toolHandlers,
    ...options.toolingSettingsController.latexHandlers,
    // Inline criticism renders `\criticize{...}` annotations as editor
    // squiggles and Problems-panel entries. Both are VS Code editor surfaces
    // with no desktop counterpart, so this stays host-specific rather than
    // "not yet ported".
    getInlineCriticismEnabled: unsupported(
      'Inline criticism needs the VS Code editor and Problems panel.',
    ),
    setInlineCriticismEnabled: unsupported(
      'Inline criticism needs the VS Code editor and Problems panel.',
    ),
    getGoalList: postGoalList,
    revealGoalStream: (message) => revealStream(message.streamId),
  };

  return {
    refreshAuthDependentData,
    signInChatGpt: () => options.credentialSettingsController.signInChatGpt(),

    handleMessage(message: DesktopCommandMessage) {
      // WEBVIEW_READY is a broadcast: act on it but return false so sibling
      // handlers (startup, onboarding) in the chain still receive it.
      const parsed = SettingsViewInboundMessageSchema.safeParse(message);
      if (!parsed.success) return false;
      if (parsed.data.command === SETTINGS_VIEW_COMMANDS.WEBVIEW_READY) {
        if (parsed.data.view === 'settings') {
          options.postToRenderer({
            command: SETTINGS_VIEW_COMMANDS.SET_UNSUPPORTED_COMMANDS,
            commands: unsupportedCommands(settingsHandlers),
          });
          runAsync(postInitialSettingsData());
        }
        return false;
      }
      // A successful parse conclusively identifies this as a settings
      // command, so claim it (true) even when the matched entry is
      // `unsupported(...)` — the dispatcher's `false` there means "no
      // function ran," not "not mine"; onError already surfaces the
      // unsupported reason as visible feedback (see `onError` above).
      dispatchSettingsViewInbound(message, settingsHandlers, onError);
      return true;
    },
  };
}
