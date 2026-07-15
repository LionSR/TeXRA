import { platform, tryPlatform } from '@platform/platform';
import { resolveMemoryStoragePath } from '@platform/defaults/workspaceStorage';

import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
import {
  isAllowedLatexInstallCommand,
  LatexToolingController,
} from '@controllers/settingsView/LatexToolingController';
import { SettingsGoalController } from '@controllers/settingsView/SettingsGoalController';
import {
  createSettingsViewCommandHandlers,
  type SettingsViewCommandActions,
} from '@controllers/settingsView/SettingsViewCommandHandlers';
import { createSettingsViewHost } from '@controllers/settingsView/SettingsViewHost';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  LATEX_WORKSHOP_EXT_ID,
  normalizePlatform,
} from '@shared/constants/latex';
import type { LatexConfigField } from '@shared/constants/latex';
import {
  dispatchSettingsViewInbound,
  SettingsViewInboundMessageSchema,
  type LatexSettingsStatus,
  type ReasoningLevel,
  type ToolDashboardItem,
} from '@shared/schemas/settingsViewMessages';
import { unsupported, unsupportedCommands } from '@shared/utils/dispatcher';
import {
  BASH_APPROVAL_CONFIG_TARGET,
  buildApprovalSettingsMessage,
  setBashApprovalEnabled,
  setWorkspaceAgentSetting,
} from '@shared/settingsView/handlers/approvalHandlers';
import { buildSuperYoloMessage } from '@shared/settingsView/handlers/superYoloHandlers';
import { GoalStore } from '@tools/goal';
import type { ExternalToolCheckResult } from '@tools/toolAvailability';
import { StorageFS } from '@utils/files';
import {
  applyGitAuthorSettings,
  buildGitAuthorSettingsMessage,
  readGitAuthorSettingsFromState,
} from '@utils/system/gitAuthorSettings';
import { BinaryResolver } from '@utils/system/binaryResolver';
import {
  checkToolInstalled,
  detectPackageManager,
} from '@utils/system/toolUtils';
import {
  type DesktopCrashReportingStatus,
  getDesktopCrashReportingStatus,
  setDesktopCrashReportingDsn,
  setDesktopCrashReportingEnabled,
} from './desktopCrashReporting.js';
import {
  buildDefaultToolDashboardItems,
  defaultOnError,
  emptySecrets,
  findToolCommand,
  getCachedToolCheckResults,
  refreshDefaultDisabledToolCache,
} from './desktopSettingsIpcHelpers.js';
import {
  createDesktopErrorReporter,
  type DesktopCommandMessage,
  type DesktopMessageHandler,
} from './desktopIpcTypes.js';
import {
  DesktopHistoryHandlers,
  type DesktopHistoryOptions,
} from './desktopHistoryHandlers.js';
import type { ConfigProvider, StateStore } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import type { DesktopAgentSettingsController } from './desktopAgentSettingsController.js';
import type { DesktopCredentialSettingsController } from './desktopCredentialSettingsController.js';

type ToolDashboardBuilder = (
  cachedResults?: ExternalToolCheckResult[],
) => Promise<ToolDashboardItem[]>;

export interface DesktopSettingsIpcOptions extends DesktopHistoryOptions {
  postToRenderer(message: unknown): void;
  agentSettingsController: DesktopAgentSettingsController;
  credentialSettingsController: DesktopCredentialSettingsController;
  sendStartupCatalogData?: boolean;
  globalState?: StateStore;
  workspaceState?: StateStore;
  config?: ConfigProvider;
  buildToolDashboardItems?: ToolDashboardBuilder;
  refreshToolAvailability?: () => Promise<void>;
  openPath?: (filePath: string) => Promise<void>;
  /** Route this window to the progress view and select the given stream. */
  revealStream?: (streamId: string) => Promise<void>;
  openExternalUrl?: (url: string) => Promise<void>;
  installToolExtension?: (extensionId: string) => Promise<void>;
  promptSecret?: (input: {
    title: string;
    prompt: string;
  }) => Promise<string | undefined>;
  showInfoMessage?: (message: string) => Promise<void>;
  showErrorMessage?: (message: string) => Promise<void>;
  confirmAction?: (message: string, confirmLabel?: string) => Promise<boolean>;
  initializeCrashReporting?: () => Promise<void>;
  secrets?: PlatformSecrets;
  detectLatexSettingsStatus?: () => Promise<LatexSettingsStatus>;
  runInstallCommand?: (command: string) => Promise<void>;
  runToolCommand?: (input: {
    toolId: string;
    command: string;
    kind: 'install' | 'auth';
  }) => Promise<void>;
  onError?: (error: unknown) => void;
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
  const workspaceState = options.workspaceState ?? platform().workspaceState;
  const globalState = options.globalState ?? platform().globalState;
  // Commands declared `unsupported(...)` in settingsHandlers below surface as
  // a visible info dialog instead of a console-only error log.
  const onError = createDesktopErrorReporter(
    options.onError ?? defaultOnError,
    (error) => {
      void options.showInfoMessage?.(error.reason);
    },
  );
  const historyHandlers = new DesktopHistoryHandlers({
    postToRenderer: options.postToRenderer,
    resourcesPath: options.resourcesPath,
    runExecution: options.runExecution,
    restoreTaskState: options.restoreTaskState,
    openPath: options.openPath,
    showInfoMessage: options.showInfoMessage,
    showErrorMessage: options.showErrorMessage,
    onError,
  });
  const usesDefaultToolDashboardBuilder =
    options.buildToolDashboardItems == null;
  const buildToolDashboardItems =
    options.buildToolDashboardItems ?? buildDefaultToolDashboardItems;
  const refreshToolAvailability = options.refreshToolAvailability;
  const secrets = options.secrets ?? tryPlatform()?.secrets ?? emptySecrets;
  const latexConfigPersistenceController =
    new LatexConfigPersistenceController();
  const goalController = new SettingsGoalController({
    listGoals: () => GoalStore.list(),
  });
  const latexToolingController = new LatexToolingController({
    checkToolInstalled: (tool) => checkToolInstalled(tool, false),
    findPath: (tool) => BinaryResolver.findPath(tool),
    detectPackageManager,
    getPlatform: () => normalizePlatform(process.platform),
    isLatexWorkshopInstalled: () => false,
    getRecommendedStatus: () => ({
      outDir: true,
      autoRevealExclude: true,
    }),
    onDetectionError: onError,
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
        options.confirmAction?.(message, promptOptions?.confirmLabel) ??
        Promise.resolve(true),
      warning: async (message) => {
        await options.showInfoMessage?.(message);
      },
    },
  });

  function readCurrentGitAuthorSettings() {
    return readGitAuthorSettingsFromState(workspaceState);
  }

  function getConfigProvider(): ConfigProvider {
    return options.config ?? platform().config;
  }

  function applyCurrentGitAuthorSettings() {
    return applyGitAuthorSettings(readCurrentGitAuthorSettings());
  }

  function postGitAuthorSettings(
    settings = readCurrentGitAuthorSettings(),
  ): void {
    options.postToRenderer(buildGitAuthorSettingsMessage(settings));
  }

  function postLatexConfigValues(): void {
    options.postToRenderer(
      latexConfigPersistenceController.buildConfigMessage((key) =>
        workspaceState.get(key),
      ),
    );
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
    await options.openPath?.(StorageFS.fullPath(resolvedPath));
  }

  async function openMemoryFolder(): Promise<void> {
    await StorageFS.ensureDir(resolveMemoryStoragePath());
    await options.openPath?.(StorageFS.fullPath(resolveMemoryStoragePath()));
  }

  async function postToolDashboardData(postOptions?: {
    skipChecks?: boolean;
  }): Promise<void> {
    const cachedResults =
      postOptions?.skipChecks && usesDefaultToolDashboardBuilder
        ? await getCachedToolCheckResults()
        : undefined;
    const items = await buildToolDashboardItems(cachedResults);
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
      items,
    });
  }

  async function postLatexSettingsStatus(): Promise<void> {
    const settings =
      (await options.detectLatexSettingsStatus?.()) ??
      (await latexToolingController.detectStatus());
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS,
      settings,
    });
  }

  function postDesktopCrashReportingStatusMessage(
    status: DesktopCrashReportingStatus,
  ): void {
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_DESKTOP_CRASH_REPORTING,
      ...status,
    });
  }

  async function postDesktopCrashReportingStatus(): Promise<void> {
    const status = await getDesktopCrashReportingStatus(globalState, secrets);
    postDesktopCrashReportingStatusMessage(status);
  }

  async function finishDesktopCrashReportingSettingsChange(): Promise<void> {
    const status = await getDesktopCrashReportingStatus(globalState, secrets);
    if (status.enabled && status.configured) {
      await options.initializeCrashReporting?.();
    }
    postDesktopCrashReportingStatusMessage(status);
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
        config: getConfigProvider(),
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
    postLatexConfigValues();
    postGoalList();
    const memoryEnabledPosted = postMemoryEnabled();
    const modelSelectionDataPosted = postModelSelectionData();
    postSuperYoloEnabled();
    postApprovalSettings();
    await Promise.all([
      memoryEnabledPosted,
      postMemoryData(),
      historyHandlers.postHistoryData(),
      modelSelectionDataPosted,
      options.credentialSettingsController.postStartupData(),
      postLatexSettingsStatus(),
      postDesktopCrashReportingStatus(),
      options.agentSettingsController.postStartupData(),
      postToolDashboardData(),
    ]);
  }

  async function updateGitAuthorSetting(
    key: WorkspaceStateKey,
    value: unknown,
  ): Promise<void> {
    await workspaceState.update(key, value);
    postGitAuthorSettings(applyCurrentGitAuthorSettings());
  }

  async function updateLatexConfigValue(input: {
    field: LatexConfigField;
    value: unknown;
  }): Promise<void> {
    const plan = latexConfigPersistenceController.planUpdate(input);
    if (!plan.ok) {
      onError(
        new Error(`Invalid LaTeX config value for ${input.field}`, {
          cause: plan.error,
        }),
      );
      return;
    }

    await workspaceState.update(plan.update.key, plan.update.value);
    postLatexConfigValues();
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

  async function updateDesktopCrashReportingEnabled(
    enabled: boolean,
  ): Promise<void> {
    await setDesktopCrashReportingEnabled(globalState, enabled);
    await finishDesktopCrashReportingSettingsChange();
  }

  async function updateDesktopCrashReportingDsn(): Promise<void> {
    const dsn = await options.promptSecret?.({
      title: 'Set Sentry DSN',
      prompt: 'Enter the Sentry DSN for opt-in desktop crash reports',
    });
    if (dsn == null) return;
    await setDesktopCrashReportingDsn(secrets, dsn);
    await finishDesktopCrashReportingSettingsChange();
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
      { workspaceState, globalState, config: getConfigProvider() },
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

  async function setToolEnabled(
    toolId: string,
    enabled: boolean,
  ): Promise<void> {
    const current = globalState.get<string[]>(
      GlobalStateKey.DISABLED_TOOLS,
      [],
    );
    const disabled = new Set(current);
    if (enabled) {
      disabled.delete(toolId);
    } else {
      disabled.add(toolId);
    }
    await globalState.update(GlobalStateKey.DISABLED_TOOLS, [...disabled]);
    if (usesDefaultToolDashboardBuilder) {
      await refreshDefaultDisabledToolCache();
    }
    await postToolDashboardData({ skipChecks: true });
  }

  async function recheckToolStatus(): Promise<void> {
    const didRefresh = refreshToolAvailability != null;
    if (didRefresh) {
      await refreshToolAvailability();
    }
    await postToolDashboardData({ skipChecks: didRefresh });
  }

  async function runToolCommand(input: {
    toolId: string;
    kind: 'install' | 'auth';
  }): Promise<void> {
    const command = await findToolCommand(input.toolId, input.kind);
    if (!command) return;
    await options.runToolCommand?.({ ...input, command });
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
    history: historyHandlers.actions,
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
    tools: {
      openInstallUrl: (url) =>
        options.openExternalUrl?.(url) ?? Promise.resolve(),
      installExtension: (extensionId) =>
        options.installToolExtension?.(extensionId) ?? Promise.resolve(),
      recheckStatus: () => recheckToolStatus(),
      toggle: (toolId, enabled) => setToolEnabled(toolId, enabled),
      runCommand: ({ toolId, kind }) => runToolCommand({ toolId, kind }),
    },
    latex: {
      applySettings: () => postLatexSettingsStatus(),
      installLatexWorkshop: () =>
        options.installToolExtension?.(LATEX_WORKSHOP_EXT_ID) ??
        Promise.resolve(),
      runInstallCommand: (installCommand) => {
        if (!isAllowedLatexInstallCommand(installCommand)) {
          onError(
            new Error(`Rejected unknown install command: ${installCommand}`),
          );
          return;
        }
        return options.runInstallCommand?.(installCommand) ?? Promise.resolve();
      },
      setConfigValue: ({ field, value }) =>
        updateLatexConfigValue({ field, value }),
    },
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
      revealStream: (streamId) =>
        options.revealStream?.(streamId) ?? Promise.resolve(),
    },
    desktopCrashReporting: {
      get: () => postDesktopCrashReportingStatus(),
      setEnabled: (enabled) => updateDesktopCrashReportingEnabled(enabled),
      setDsn: () => updateDesktopCrashReportingDsn(),
    },
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
          if (options.sendStartupCatalogData) {
            runAsync(postInitialSettingsData());
          } else {
            postGitAuthorSettings();
            postLatexConfigValues();
            postGoalList();
          }
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
