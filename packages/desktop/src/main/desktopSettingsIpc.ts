import { resolveMemoryStoragePath } from '@platform/defaults/workspaceStorage';

import { SettingsGoalController } from '@controllers/settingsView/SettingsGoalController';
import {
  createSettingsViewCommandHandlers,
  type SettingsViewCommandActions,
} from '@controllers/settingsView/SettingsViewCommandHandlers';
import { createSettingsViewHost } from '@controllers/settingsView/SettingsViewHost';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  dispatchSettingsViewInbound,
  SettingsViewInboundMessageSchema,
  type ReasoningLevel,
} from '@shared/schemas/settingsViewMessages';
import { unsupported, unsupportedCommands } from '@shared/utils/dispatcher';
import {
  BASH_APPROVAL_CONFIG_TARGET,
  buildApprovalSettingsMessage,
  setBashApprovalEnabled,
  setWorkspaceAgentSetting,
} from '@shared/settingsView/handlers/approvalHandlers';
import { buildSuperYoloMessage } from '@shared/settingsView/handlers/superYoloHandlers';
import type { SettingsStatePorts } from '@shared/settingsView/types';
import { GoalStore } from '@tools/goal';
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
import type { ConfigProvider } from '@platform/interfaces';
import type { DesktopAgentSettingsController } from './desktopAgentSettingsController.js';
import type { DesktopCrashReportingSettingsController } from './desktopCrashReportingSettingsController.js';
import type { DesktopCredentialSettingsController } from './desktopCredentialSettingsController.js';
import type { DesktopToolingSettingsController } from './desktopToolingSettingsController.js';

export interface DesktopSettingsUiHost {
  openPath(filePath: string): Promise<void>;
  revealStream(streamId: string): Promise<void>;
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
    void options.ui.showInfoMessage(error.reason);
  });
  const goalController = new SettingsGoalController({
    listGoals: () => GoalStore.list(),
  });
  const settingsHost = createSettingsViewHost({
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

  async function postModelSelectionData(): Promise<void> {
    await settingsHost.sendModelSelectionData();
  }

  async function postMemoryData(): Promise<void> {
    await settingsHost.sendMemoryData();
  }

  async function postMemoryPreview(storagePath: string): Promise<void> {
    await settingsHost.sendMemoryPreview({ storagePath }, { onError });
  }

  async function postMemoryEnabled(): Promise<void> {
    await settingsHost.sendMemoryEnabled();
  }

  async function deleteMemory(input: {
    storagePath: string;
    displayPath: string;
  }): Promise<void> {
    await settingsHost.deleteMemory(input);
  }

  async function setMemoryEnabled(enabled: boolean): Promise<void> {
    await settingsHost.setMemoryEnabled(enabled);
  }

  async function setMemoryPinned(
    storagePath: string,
    pinned: boolean,
  ): Promise<void> {
    await settingsHost.setMemoryPinned(storagePath, pinned);
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

  /**
   * Deliberate divergence from the extension: no `subscribeGoalStateChanges`
   * push hook here. The initial post below, the webview-ready re-post, and
   * the Goals tab's manual `getList` refresh cover the desktop settings
   * panel — goal state only changes through agent runs, and returning to
   * (or refreshing) the panel re-reads the store, so a live push adds a
   * subscription surface without a user-visible gain.
   */
  function postGoalList(): void {
    options.postToRenderer(goalController.getGoalListMessage());
  }

  async function postInitialSettingsData(): Promise<void> {
    postGitAuthorSettings();
    options.toolingSettingsController.postLatexConfigValues();
    postGoalList();
    const memoryEnabledPosted = postMemoryEnabled();
    const modelSelectionDataPosted = postModelSelectionData();
    postSuperYoloEnabled();
    postApprovalSettings();
    await Promise.all([
      memoryEnabledPosted,
      postMemoryData(),
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

  async function updateModelReasoningLevel(input: {
    modelName: string;
    level: ReasoningLevel | null;
  }): Promise<void> {
    await settingsHost.setReasoningLevel(input);
  }

  async function updateHelperModel(modelName: string): Promise<void> {
    await settingsHost.setHelperModel(modelName);
  }

  async function updatePreferShortModelNames(enabled: boolean): Promise<void> {
    await settingsHost.setPreferShortModelNames(enabled);
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

  async function updateBashApprovalEnabled(enabled: boolean): Promise<void> {
    await setBashApprovalEnabled(
      { workspaceState, globalState, config: options.config },
      enabled,
      BASH_APPROVAL_CONFIG_TARGET,
    );
    postApprovalSettings();
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

  const StateKeys = WorkspaceStateKey;
  const setGitAuthor = (key: WorkspaceStateKey, value: boolean | string) =>
    updateGitAuthorSetting(key, value);
  const setAgent = (key: WorkspaceStateKey, value: string) =>
    updateAgentSetting(key, value);

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
      getData: () => postMemoryData(),
      getPreview: (storagePath) => postMemoryPreview(storagePath),
      openFile: (data) => openMemoryFile(data),
      openFolder: () => openMemoryFolder(),
      delete: (data) => deleteMemory(data),
      setEnabled: (enabled) => setMemoryEnabled(enabled),
      pin: (storagePath) => setMemoryPinned(storagePath, true),
      unpin: (storagePath) => setMemoryPinned(storagePath, false),
    },
    history: options.historySettingsController.actions,
    profile: options.credentialSettingsController.profileActions,
    modelSelection: {
      setEnabled: (modelName, enabled) =>
        updateModelEnabled({ modelName, enabled }),
      setHelperModel: (modelName) => updateHelperModel(modelName),
      setReasoningLevel: (modelName, level) =>
        updateModelReasoningLevel({ modelName, level }),
      setPreferShortModelNames: (enabled) =>
        updatePreferShortModelNames(enabled),
    },
    orchestration: {
      setAllowOrchestratorKill: (enabled) =>
        updateBooleanWorkspaceSetting(
          StateKeys.ALLOW_ORCHESTRATOR_KILL,
          enabled,
        ),
      setDetachSubagentsOnStop: (enabled) =>
        updateBooleanWorkspaceSetting(
          StateKeys.DETACH_SUBAGENTS_ON_STOP,
          enabled,
        ),
    },
    agentSelection: options.agentSettingsController.actions,
    gitAuthor: {
      setMarkCommits: (enabled) =>
        setGitAuthor(StateKeys.GIT_MARK_COMMITS, enabled),
      setName: (name) => setGitAuthor(StateKeys.GIT_AUTHOR_NAME, name),
      setEmail: (email) => setGitAuthor(StateKeys.GIT_AUTHOR_EMAIL, email),
      setWorktreeSupport: (enabled) =>
        setGitAuthor(StateKeys.GIT_WORKTREE_SUPPORT, enabled),
    },
    githubSubscriptions: {
      getTokenStatus: unsupported(
        'GitHub PR subscriptions are not available in the desktop app yet.',
      ),
      setToken: unsupported(
        'GitHub PR subscriptions are not available in the desktop app yet.',
      ),
      removeToken: unsupported(
        'GitHub PR subscriptions are not available in the desktop app yet.',
      ),
      openTokenUrl: unsupported(
        'GitHub PR subscriptions are not available in the desktop app yet.',
      ),
      getSubscriptions: unsupported(
        'GitHub PR subscriptions are not available in the desktop app yet.',
      ),
      unsubscribe: unsupported(
        'GitHub PR subscriptions are not available in the desktop app yet.',
      ),
      openSubscriptionStream: unsupported(
        'GitHub PR subscriptions are not available in the desktop app yet.',
      ),
    },
    chatGpt: options.credentialSettingsController.chatGptActions,
    approval: {
      setBashApprovalEnabled: (enabled) => updateBashApprovalEnabled(enabled),
      setCodexSandboxMode: (mode) =>
        setAgent(StateKeys.CODEX_SANDBOX_MODE, mode),
      setCodexReasoningEffort: (effort) =>
        setAgent(StateKeys.CODEX_REASONING_EFFORT, effort),
      setCodexApprovalPolicy: (policy) =>
        setAgent(StateKeys.CODEX_APPROVAL_POLICY, policy),
      setClaudeAgentModel: (model) =>
        setAgent(StateKeys.CLAUDE_AGENT_MODEL, model),
      setClaudeAgentPermissionMode: (mode) =>
        setAgent(StateKeys.CLAUDE_AGENT_PERMISSION_MODE, mode),
      setClaudeAgentEffort: (effort) =>
        setAgent(StateKeys.CLAUDE_AGENT_EFFORT, effort),
    },
    tools: options.toolingSettingsController.toolsActions,
    latex: options.toolingSettingsController.latexActions,
    inlineCriticism: {
      getEnabled: unsupported(
        'Inline criticism is not available in the desktop app yet.',
      ),
      setEnabled: unsupported(
        'Inline criticism is not available in the desktop app yet.',
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
