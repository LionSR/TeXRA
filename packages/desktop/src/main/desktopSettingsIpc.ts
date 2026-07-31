import { formatError } from '@common/errors';
import { SettingsViewHost } from '@controllers/settingsView/SettingsViewHost';
import {
  createSettingsViewCommandHandlers,
  type SettingsViewCommandActions,
} from '@controllers/settingsView/SettingsViewCommandHandlers';
import {
  GITHUB_TOKEN_CREATE_URL,
  listGitHubSubscriptionEntries,
  unsubscribeGitHubKey,
} from '@controllers/settingsView/githubSubscriptions';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import type { ConfigProvider } from '@platform/interfaces';
import { platform } from '@platform/platform';
import { resolveMemoryStoragePath } from '@platform/defaults/workspaceStorage';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { resolveStateSettingWrite } from '@shared/settingsView/handlers/stateSettingWrite';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  dispatchSettingsViewInbound,
  SettingsViewInboundMessageSchema,
} from '@shared/schemas/settingsViewMessages';
import { unsupported, unsupportedCommands } from '@shared/utils/dispatcher';
import {
  BASH_APPROVAL_CONFIG_TARGET,
  buildApprovalSettingsMessage,
  setBashApprovalEnabled,
  setWorkspaceAgentSetting,
} from '@shared/settingsView/handlers/approvalHandlers';
import {
  buildAgentSkillsSettingsMessage,
  setAgentSkillsEnabled,
} from '@shared/settingsView/handlers/agentSkillsHandlers';
import { buildSuperYoloMessage } from '@shared/settingsView/handlers/superYoloHandlers';
import type { SettingsStatePorts } from '@shared/settingsView/types';
import { GoalStore } from '@tools/goal';
import {
  GITHUB_TOKEN_STORAGE_KEY,
  resolveGitHubTokenSource,
} from '@tools/github/githubAuth';
import { StorageFS } from '@utils/files';
import {
  applyGitAuthorSettings,
  buildGitAuthorSettingsMessage,
  readGitAuthorSettingsFromState,
} from '@utils/system/gitAuthorSettings';
import {
  createDesktopErrorReporter,
  type DesktopCommandMessage,
  type DesktopMessageHandler,
} from './desktopIpcTypes.js';
import type { DesktopHistorySettingsController } from './desktopHistoryHandlers.js';
import type { DesktopAgentSettingsController } from './desktopAgentSettingsController.js';
import type { DesktopCrashReportingSettingsController } from './desktopCrashReportingSettingsController.js';
import type { DesktopCredentialSettingsController } from './desktopCredentialSettingsController.js';
import type { DesktopToolingSettingsController } from './desktopToolingSettingsController.js';

export interface DesktopSettingsUiHost {
  openPath(filePath: string): Promise<void>;
  revealStream(streamId: string): Promise<void>;
  /**
   * Display label for a stream, used by the Git tab to name each subscription's
   * owning agent run. Returns undefined when no presentation is attached, in
   * which case the raw stream id is shown.
   */
  getStreamLabel?(streamId: string): string | undefined;
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
  crashReportingSettingsController: DesktopCrashReportingSettingsController;
  credentialSettingsController: DesktopCredentialSettingsController;
  historySettingsController: DesktopHistorySettingsController;
  toolingSettingsController: DesktopToolingSettingsController;
  state: SettingsStatePorts;
  config: ConfigProvider;
  ui: DesktopSettingsUiHost;
}

export interface DesktopSettingsIpc extends DesktopMessageHandler {
  refreshAuthDependentData(options?: {
    deferAgentCatalogRefresh?: boolean;
  }): Promise<void>;
  signInChatGpt(options?: { enableSubscription?: boolean }): Promise<void>;
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
    beforeModelSelectionMessage: () =>
      options.credentialSettingsController.prepareModelSelectionData(),
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

  function postGitAuthorSettings(
    settings = readCurrentGitAuthorSettings(),
  ): void {
    options.postToRenderer(buildGitAuthorSettingsMessage(settings));
  }

  async function openMemoryFile(input: { storagePath: string }): Promise<void> {
    const resolvedPath = resolveMemoryStoragePath(input.storagePath);
    await options.ui.openPath(StorageFS.fullPath(resolvedPath));
  }

  async function openMemoryFolder(): Promise<void> {
    await StorageFS.ensureDir(resolveMemoryStoragePath());
    await options.ui.openPath(StorageFS.fullPath(resolveMemoryStoragePath()));
  }

  function postSuperYoloEnabled(): void {
    options.postToRenderer(
      buildSuperYoloMessage({
        workspaceState,
        globalState,
        getReliabilitySettings: () => [],
      }),
    );
  }

  function postApprovalSettings(): void {
    options.postToRenderer(
      buildApprovalSettingsMessage({
        workspaceState,
        globalState,
        config: options.config,
      }),
    );
  }

  function postAgentSkillsSettings(): void {
    options.postToRenderer(buildAgentSkillsSettingsMessage(options.config));
  }

  /**
   * Deliberate divergence from the extension: no `subscribeGoalStateChanges`
   * push hook here. The initial post below, the webview-ready re-post, and
   * the Goals tab's manual `getList` refresh cover the desktop settings
   * panel — goal state only changes through agent runs, and returning to
   * (or refreshing) the panel re-reads the store, so a live push adds a
   * subscription surface without a user-visible gain.
   */
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
    postGitAuthorSettings();
    options.toolingSettingsController.postLatexConfigValues();
    const goalListPosted = postGoalList();
    const memoryEnabledPosted = settingsHost.sendMemoryEnabled();
    const modelSelectionDataPosted = settingsHost.sendModelSelectionData();
    postSuperYoloEnabled();
    postApprovalSettings();
    postAgentSkillsSettings();
    await Promise.all([
      goalListPosted,
      memoryEnabledPosted,
      settingsHost.sendMemoryData(),
      options.historySettingsController.postHistoryData(),
      modelSelectionDataPosted,
      options.credentialSettingsController.postStartupData(),
      options.toolingSettingsController.postStartupData(),
      options.crashReportingSettingsController.postStartupData(),
      options.agentSettingsController.postStartupData(),
    ]);
  }

  async function updateGitAuthorSetting(
    key: WorkspaceStateKey,
    value: unknown,
  ): Promise<void> {
    await workspaceState.update(key, value);
    postGitAuthorSettings(applyCurrentGitAuthorSettings());
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

  async function updateAgentSetting(
    key: WorkspaceStateKey,
    value: string,
  ): Promise<void> {
    await setWorkspaceAgentSetting({ workspaceState, globalState }, key, value);
    postApprovalSettings();
  }

  async function updateToolSafetySetting(
    key: WorkspaceStateKey,
    value: boolean,
  ): Promise<void> {
    await workspaceState.update(key, value);
    postApprovalSettings();
  }

  /**
   * Generic write path for scalar `STATE_SETTINGS` rows (git author, external
   * coding agents, and tool safety). The shared
   * {@link resolveStateSettingWrite} owns value validation and family
   * classification across graphical hosts; this host only dispatches the
   * resolved family to its updater.
   */
  async function updateStateSetting(
    key: string,
    value: unknown,
  ): Promise<void> {
    const write = resolveStateSettingWrite(key, value);
    if (!write) return;
    if (write.family === 'git') {
      await updateGitAuthorSetting(write.key, write.value);
    } else if (write.family === 'agent') {
      await updateAgentSetting(write.key, write.value);
    } else {
      await updateToolSafetySetting(write.key, write.value);
    }
  }

  async function updateBashApprovalEnabled(enabled: boolean): Promise<void> {
    await setBashApprovalEnabled(
      { workspaceState, globalState, config: options.config },
      enabled,
      BASH_APPROVAL_CONFIG_TARGET,
    );
    postApprovalSettings();
  }

  async function updateAgentSkillsEnabled(enabled: boolean): Promise<void> {
    await setAgentSkillsEnabled(options.config, enabled);
    postAgentSkillsSettings();
  }

  async function updateBooleanWorkspaceSetting(
    key: WorkspaceStateKey,
    enabled: boolean,
  ): Promise<void> {
    await workspaceState.update(key, enabled);
    postSuperYoloEnabled();
  }

  function runAsync(work: Promise<void>): void {
    void work.catch(onError);
  }

  applyCurrentGitAuthorSettings();

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

  async function openGitHubTokenUrl(): Promise<void> {
    await options.ui.openExternal?.(GITHUB_TOKEN_CREATE_URL);
  }

  async function postGitHubSubscriptions(): Promise<void> {
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS,
      subscriptions: listGitHubSubscriptionEntries((streamId) =>
        options.ui.getStreamLabel?.(streamId),
      ),
    });
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

  const settingsActions: SettingsViewCommandActions = {
    // WEBVIEW_READY is intercepted in handleMessage below, before reaching
    // the dispatcher, so this entry is never actually invoked — it exists
    // only to satisfy the exhaustive registry type.
    lifecycle: {
      webviewReady: () => {},
      // VS Code-only surfaces with no desktop equivalent.
      openVscodeSettings: unsupported(
        'No VS Code settings in the desktop app.',
      ),
    },
    memory: {
      getData: () => settingsHost.sendMemoryData(),
      getPreview: (storagePath) =>
        settingsHost.sendMemoryPreview({ storagePath }, { onError }),
      openFile: (data) => openMemoryFile(data),
      openFolder: () => openMemoryFolder(),
      delete: (data) => settingsHost.deleteMemory(data),
      setEnabled: (enabled) => settingsHost.setMemoryEnabled(enabled),
      pin: (storagePath) => settingsHost.setMemoryPinned(storagePath, true),
      unpin: (storagePath) => settingsHost.setMemoryPinned(storagePath, false),
    },
    history: options.historySettingsController.actions,
    profile: options.credentialSettingsController.profileActions,
    modelSelection: {
      setEnabled: (modelName, enabled) =>
        updateModelEnabled({ modelName, enabled }),
      setHelperModel: (modelName) => settingsHost.setHelperModel(modelName),
      setReasoningLevel: (modelName, level) =>
        settingsHost.setReasoningLevel({ modelName, level }),
      setPreferShortModelNames: (enabled) =>
        settingsHost.setPreferShortModelNames(enabled),
      requestAccess: unsupported('Copilot models require VS Code.'),
    },
    orchestration: {
      setAllowOrchestratorKill: (enabled) =>
        updateBooleanWorkspaceSetting(
          WorkspaceStateKey.ALLOW_ORCHESTRATOR_KILL,
          enabled,
        ),
      setDetachSubagentsOnStop: (enabled) =>
        updateBooleanWorkspaceSetting(
          WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
          enabled,
        ),
    },
    agentSelection: options.agentSettingsController.actions,
    // Mirrors the extension's `GitHubSubscriptionHandlers`. The token store and
    // the subscription registry are host-agnostic (`@tools/github`); only the
    // secret prompt, the browser hand-off, and the stream reveal differ here.
    githubSubscriptions: {
      getTokenStatus: () => postGitHubTokenStatus(),
      setToken: () => setGitHubToken(),
      removeToken: () => removeGitHubToken(),
      openTokenUrl: () => openGitHubTokenUrl(),
      getSubscriptions: () => postGitHubSubscriptions(),
      unsubscribe: (data) => unsubscribeGitHub(data),
      openSubscriptionStream: (data) => options.ui.revealStream(data.streamId),
    },
    chatGpt: options.credentialSettingsController.chatGptActions,
    approval: {
      setBashApprovalEnabled: (enabled) => updateBashApprovalEnabled(enabled),
    },
    agentSkills: {
      setEnabled: (enabled) => updateAgentSkillsEnabled(enabled),
    },
    stateSettings: {
      update: (key, value) => updateStateSetting(key, value),
    },
    tools: options.toolingSettingsController.toolsActions,
    latex: options.toolingSettingsController.latexActions,
    // Inline criticism renders `\criticize{...}` annotations as editor
    // squiggles and Problems-panel entries. Both are VS Code editor surfaces
    // with no desktop counterpart, so this stays host-specific rather than
    // "not yet ported".
    inlineCriticism: {
      getEnabled: unsupported(
        'Inline criticism needs the VS Code editor and Problems panel.',
      ),
      setEnabled: unsupported(
        'Inline criticism needs the VS Code editor and Problems panel.',
      ),
    },
    goals: {
      getList: postGoalList,
      revealStream: (streamId) => options.ui.revealStream(streamId),
    },
    desktopCrashReporting: options.crashReportingSettingsController.actions,
  };

  const settingsHandlers = createSettingsViewCommandHandlers(settingsActions);

  return {
    refreshAuthDependentData,
    signInChatGpt: (signInOptions) =>
      options.credentialSettingsController.signInChatGpt(signInOptions),

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
