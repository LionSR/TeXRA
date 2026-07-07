/**
 * Schema-driven message handler for SettingsView.
 *
 * Combines handlers from MemoryView, HistoryView, and ProfileView
 * into a single unified message handler.
 *
 * Domain-specific handlers are delegated to focused handler classes:
 * - AgentHandlers: agent selection, directories, and teams
 * - LatexSettingsHandlers: LaTeX tool detection and recommended settings
 */
import * as vscode from 'vscode';

// Shared schemas and dispatchers
import { SettingsProfileKeyController } from '@controllers/settingsView/SettingsProfileKeyController';
import { SettingsProfileController } from '@controllers/settingsView/SettingsProfileController';
import { SettingsGoalController } from '@controllers/settingsView/SettingsGoalController';
import {
  buildToolDashboardItems,
  buildToolDashboardTerminalAction,
} from '@controllers/settingsView/ToolDashboardData';
import {
  createSettingsViewCommandHandlers,
  type SettingsViewCommandActions,
} from '@controllers/settingsView/SettingsViewCommandHandlers';
import { platform } from '@platform/platform';
import { resolveMemoryStoragePath } from '@platform/defaults/workspaceStorage';
import { createSettingsMemoryController } from '@controllers/settingsView/SettingsMemoryControllerFactory';
import {
  buildModelSelectionMessage,
  createModelSelectionController,
} from '@controllers/settingsView/SettingsModelSelectionControllerFactory';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { AUTH_COMMANDS } from '@auth/constants';
import { getServerSideKeyService } from '@auth/serverKeys';
import { BaseViewMessageHandler } from '@common/webview';
import { WorkspaceStateKey, globalSM, workspaceSM } from '@common/state';
import { appSignals } from '@eventBus/AppSignals';
import { SecretManager, type ApiProvider } from '@frontend/secretManager';
import {
  showLoggedErrorMessage,
  showLoggedInfoMessage,
} from '@frontend/ui/errorHandlingUtils';
import { selectAgentInMainView } from '@frontend/agents/remoteAgentUtils';
import {
  applyGitAuthorConfig,
  readGitAuthorSettings,
} from '@frontend/git/gitAuthorSetup';
import { VscodeExternalOpener } from '@frontend/hosts/VscodeExternalOpener';
import { VscodePromptHost } from '@frontend/hosts/VscodePromptHost';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import {
  isInlineCriticismEnabled,
  setInlineCriticismEnabled,
} from '@frontend/latex/inlineCriticism';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import {
  invalidateApiKeyCache,
  loadApiKeyStatusMap,
} from '@model/apiProviders';
import { revealProgressStream } from '@progressView/progressNavigation';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  dispatchSettingsViewInbound,
  type SettingsViewInboundHandlerRegistry,
  type SettingsViewInboundMessage,
  type SettingsMessageFor,
  SETTINGS_VIEW_CMD,
} from '@shared/schemas/settingsViewMessages';
import { unsupported, unsupportedCommands } from '@shared/utils/dispatcher';
import {
  BASH_APPROVAL_CONFIG_TARGET,
  buildApprovalSettingsMessage,
  setBashApprovalEnabled as setBashApprovalEnabledShared,
  setWorkspaceAgentSetting,
} from '@shared/settingsView/handlers/approvalHandlers';
import { buildSuperYoloMessage } from '@shared/settingsView/handlers/superYoloHandlers';
import {
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_URLS,
  PROVIDER_VSCODE_SETTINGS,
} from '@shared/constants/providers';
import { GoalStore, subscribeGoalStateChanges } from '@tools/goal';
import {
  getLastCheckResults,
  refreshToolAvailability,
  refreshDisabledToolCache,
} from '@tools/toolAvailability';
import { StorageFS } from '@utils/files';
import { hasExtension } from '@utils/core/pathCore';
import {
  buildGitAuthorSettingsMessage,
  readGitAuthorSettingsFromState,
} from '@utils/system/gitAuthorSettings';
import { setToolUseMemoryEnabled } from '@utils/config/constants';
import {
  setGlobalStreaming,
  getProviderStreaming,
  setProviderStreaming,
  getProviderEndpoint,
  setProviderEndpoint,
  supportsCustomEndpoint,
  getProviderDisplayName,
  getProviderKeyUrl,
} from '@utils/config/providerConfig';
import { getConfig, updateConfig } from '@utils/config/configUtils';
import { setToolEnabled } from '@utils/config/constants';
import { AgentHandlers } from './handlers/agentHandlers';
import { LatexSettingsHandlers } from './handlers/latexSettingsHandlers';
import { HistoryHandlers } from './handlers/historyHandlers';
import { GitHubSubscriptionHandlers } from './handlers/githubSubscriptionHandlers';
import { ChatGptSubscriptionHandlers } from './handlers/chatgptSubscriptionHandlers';
import type { SettingsMemoryController } from '@controllers/settingsView/SettingsMemoryController';
import type { SettingsModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionController';
import type { SettingsHandlerContext } from './handlers/SettingsHandlerContext';

// Re-use the shared type helper for extracting specific message types.
type MessageFor<C extends SettingsViewInboundMessage['command']> =
  SettingsMessageFor<C>;

export class SettingsViewMessageHandler extends BaseViewMessageHandler<
  vscode.WebviewView | vscode.WebviewPanel
> {
  private readonly handlerRegistry: SettingsViewInboundHandlerRegistry;

  // Domain-specific handler delegates
  private readonly agentHandlers: AgentHandlers;
  private readonly latexHandlers: LatexSettingsHandlers;
  private readonly historyHandlers: HistoryHandlers;
  private readonly githubHandlers: GitHubSubscriptionHandlers;
  private readonly chatgptHandlers: ChatGptSubscriptionHandlers;
  private readonly memoryController: SettingsMemoryController;
  private readonly modelSelectionController: SettingsModelSelectionController;
  private readonly profileController: SettingsProfileController;
  private readonly profileKeyController: SettingsProfileKeyController;
  private readonly goalController: SettingsGoalController;

  constructor(context: vscode.ExtensionContext) {
    super('SettingsView', { trackActiveView: true });

    const ctx: SettingsHandlerContext = {
      channel: this.channel,
      logger: this.logger,
      extensionContext: context,
      withActiveWebview: (fn) => this.withActiveWebview(fn),
    };

    this.memoryController = createSettingsMemoryController({
      globalState: globalSM,
      prompt: new VscodePromptHost(),
      setMemoryEnabled: setToolUseMemoryEnabled,
    });
    // Must build inside the constructor: globalSM/workspaceSM are populated
    // by extension.ts → initializeStateManagers and are still undefined at
    // module load, so destructuring them at top level captures `undefined`
    // and every later globalState.get(...) throws.
    this.modelSelectionController = createModelSelectionController(
      { workspaceState: workspaceSM, globalState: globalSM },
      {
        useIncludedAccess: () =>
          getServerSideKeyService().getUseIncludedModelAccess(),
        getUserTier: () => getServerSideKeyService().getUserTier() ?? undefined,
      },
    );
    this.profileController = new SettingsProfileController({
      globalState: globalSM,
      providerIds: SecretManager.API_PROVIDERS,
      providerVscodeSettings: PROVIDER_VSCODE_SETTINGS,
      providerDisplayNames: PROVIDER_DISPLAY_NAMES,
      providerKeyUrls: PROVIDER_URLS,
      loadProviderKeyStatuses: () =>
        loadApiKeyStatusMap(platform().secrets, SecretManager.API_PROVIDERS),
      getProviderDisplayName,
      getProviderKeyUrl,
      getProviderStreaming,
      getProviderEndpoint,
      supportsCustomEndpoint,
      getConfig,
      updateConfig: (key, value) =>
        updateConfig(key, value, { target: 'global', prefix: false }),
      setUseIncludedModelAccess: (enabled) =>
        getServerSideKeyService().setUseIncludedModelAccess(enabled),
      invalidateModelOptionsCache,
    });
    this.profileKeyController = new SettingsProfileKeyController({
      prompt: new VscodePromptHost(),
      externalOpener: new VscodeExternalOpener(),
      getProviderDisplayName: (provider) =>
        this.profileController.getProviderDisplayName(provider),
      getProviderKeyUrl: (provider) =>
        this.profileController.getProviderKeyUrl(provider),
      getApiKeySecretName: (provider) =>
        SecretManager.getApiKeySecretName(provider as ApiProvider),
      setSecret: (key, value) => SecretManager.set(key, value),
      deleteSecret: (key) => SecretManager.delete(key),
      refreshAfterKeyChange: () => this.refreshAfterKeyChange(),
    });
    this.agentHandlers = new AgentHandlers(ctx, (selectedToolUseAgent) =>
      this.refreshAfterAgentMutation(selectedToolUseAgent),
    );
    this.latexHandlers = new LatexSettingsHandlers(ctx);
    this.historyHandlers = new HistoryHandlers(ctx);
    this.githubHandlers = new GitHubSubscriptionHandlers(ctx);
    this.chatgptHandlers = new ChatGptSubscriptionHandlers(ctx, () =>
      this.refreshAfterChatGptAuthChange(),
    );
    this.goalController = new SettingsGoalController({
      listGoals: () => GoalStore.list(),
    });

    this.handlerRegistry = this.createHandlerRegistry();

    // Lifetime == extension; appSignals is process-global so no dispose needed.
    const refreshSubscriptions = () =>
      void this.withActiveWebview((w) =>
        this.githubHandlers.sendPRSubscriptions(w),
      );
    appSignals.on('prSubscriptionsChanged', refreshSubscriptions);
    appSignals.on('prSubscriptionBindingsChanged', refreshSubscriptions);
    appSignals.on('repoSubscriptionsChanged', refreshSubscriptions);
    appSignals.on('repoSubscriptionBindingsChanged', refreshSubscriptions);
    appSignals.on('issueSubscriptionsChanged', refreshSubscriptions);
    appSignals.on('issueSubscriptionBindingsChanged', refreshSubscriptions);
    appSignals.on('toolAvailabilityChanged', () => {
      void this.withActiveWebview((w) =>
        this.sendToolDashboardData(w, { skipChecks: true }),
      );
    });
    const unsubscribeGoals = subscribeGoalStateChanges(defaultSession(), () => {
      void this.withActiveWebview((w) => this.sendGoalList(w));
    });
    context.subscriptions.push({ dispose: unsubscribeGoals });
  }

  private createHandlerRegistry(): SettingsViewInboundHandlerRegistry {
    const StateKeys = WorkspaceStateKey;
    const setGitAuthor = (key: WorkspaceStateKey, value: boolean | string) =>
      this.updateGitAuthorSetting(key, value);
    const setAgent = (key: WorkspaceStateKey, value: string) =>
      this.updateAgentSetting(key, value);

    const actions: SettingsViewCommandActions = {
      lifecycle: {
        webviewReady: () => this.withActiveWebview((w) => this.sendAllData(w)),
        openVscodeSettings: () => this.openVscodeSettings(),
      },
      memory: {
        getData: () => this.withActiveWebview((w) => this.sendMemoryData(w)),
        getPreview: (storagePath) =>
          this.handleGetMemoryPreview({
            command: SETTINGS_VIEW_COMMANDS.GET_MEMORY_PREVIEW,
            storagePath,
          }),
        openFile: (data) => this.handleOpenMemoryFile(data),
        openFolder: () => this.handleOpenMemoryFolder(),
        delete: (data) => this.handleDeleteMemory(data),
        getEnabled: () =>
          this.withActiveWebview((w) => this.sendMemoryEnabled(w)),
        setEnabled: (enabled) =>
          this.handleSetMemoryEnabled({
            command: SETTINGS_VIEW_COMMANDS.SET_MEMORY_ENABLED,
            enabled,
          }),
        pin: (storagePath) => this.setMemoryPinned(storagePath, true),
        unpin: (storagePath) => this.setMemoryPinned(storagePath, false),
      },
      history: {
        getData: () =>
          this.withActiveWebview((w) =>
            this.historyHandlers.sendHistoryData(w),
          ),
        rerunAgent: (data) => this.historyHandlers.handleRerunAgent(data),
        restoreAgent: (data) => this.historyHandlers.handleRestoreAgent(data),
        deleteAgent: (historyId) =>
          this.historyHandlers.handleDeleteAgent({
            command: SETTINGS_VIEW_COMMANDS.DELETE_AGENT,
            historyId,
          }),
        clear: () => this.historyHandlers.handleClearHistory(),
        exportChatMd: (data) =>
          this.historyHandlers.handleExportChat(data, 'md'),
        exportChatTex: (data) =>
          this.historyHandlers.handleExportChat(data, 'tex'),
        exportChatHtml: (data) =>
          this.historyHandlers.handleExportChat(data, 'html'),
      },
      profile: {
        getData: () => this.withActiveWebview((w) => this.sendProfileData(w)),
        selectAgent: async (agentName) => {
          await selectAgentInMainView(agentName, {
            showSuccessMessage: true,
            copyToClipboardOnFailure: false,
          });
        },
        signIn: () =>
          safeExecuteCommand(AUTH_COMMANDS.SIGN_IN, [], this.viewName),
        signOut: () =>
          safeExecuteCommand(AUTH_COMMANDS.SIGN_OUT, [], this.viewName),
        setApiAccessMode: (mode) =>
          this.handleSetApiAccessMode({
            command: SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE,
            mode,
          }),
        setProviderKey: (provider) =>
          this.runProviderKeyAction(provider, 'set', (targetProvider) =>
            this.profileKeyController.setProviderKey(targetProvider),
          ),
        removeProviderKey: (provider) =>
          this.runProviderKeyAction(provider, 'remove', (targetProvider) =>
            this.profileKeyController.removeProviderKey(targetProvider),
          ),
        openProviderKeyUrl: (provider) =>
          this.profileKeyController.openProviderKeyUrl(provider),
        setProviderStreaming: (provider, enabled) =>
          this.updateProfileSetting(() =>
            setProviderStreaming(provider, enabled),
          ),
        setProviderEndpoint: (provider, endpoint) =>
          this.updateProfileSetting(() =>
            setProviderEndpoint(provider, endpoint),
          ),
        setGlobalStreaming: (enabled) =>
          this.updateProfileSetting(() => setGlobalStreaming(enabled)),
        setProviderVscodeSetting: (data) =>
          this.handleSetProviderVscodeSetting(data),
        openExternalUrl: (url) => this.openExternalUrl(url),
      },
      modelSelection: {
        getData: () =>
          this.withActiveWebview((w) => this.sendModelSelectionData(w)),
        setEnabled: (modelName, enabled) =>
          this.updateModelSelection(
            () =>
              this.modelSelectionController.setModelEnabled({
                modelName,
                enabled,
              }),
            { invalidateCache: true, refreshMainOptions: true },
          ),
        setHelperModel: (modelName) =>
          this.updateModelSelection(() =>
            this.modelSelectionController.setHelperModel(modelName),
          ),
        setReasoningLevel: (modelName, level) =>
          this.updateModelSelection(() =>
            this.modelSelectionController.setReasoningLevel({
              modelName,
              level,
            }),
          ),
        setPreferShortModelNames: (enabled) =>
          this.updateModelSelection(() =>
            this.modelSelectionController.setPreferShortModelNames(enabled),
          ),
      },
      orchestration: {
        getSuperYoloEnabled: () =>
          this.withActiveWebview((w) => this.sendSuperYoloEnabled(w)),
        setSuperYoloEnabled: () =>
          this.withActiveWebview((w) => this.sendSuperYoloEnabled(w)),
        setAllowOrchestratorKill: (enabled) =>
          this.updateBooleanAndSendSuperYolo(
            StateKeys.ALLOW_ORCHESTRATOR_KILL,
            { enabled },
          ),
        setDetachSubagentsOnStop: (enabled) =>
          this.updateBooleanAndSendSuperYolo(
            StateKeys.DETACH_SUBAGENTS_ON_STOP,
            { enabled },
          ),
      },
      agentSelection: {
        getData: () =>
          this.withActiveWebview((w) =>
            this.agentHandlers.sendAgentSelectionData(w),
          ),
        openYaml: ({ source, name }) =>
          this.agentHandlers.handleOpenAgentYaml({
            command: SETTINGS_VIEW_COMMANDS.OPEN_AGENT_YAML,
            agentSource: source,
            agentName: name,
          }),
        setEnabled: ({ category, source, name, enabled }) =>
          this.agentHandlers.handleSetAgentEnabled({
            command: SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED,
            category,
            agentSource: source,
            agentName: name,
            enabled,
          }),
        setAllEnabled: ({ category, source, enabled }) =>
          this.agentHandlers.handleSetAllAgentsEnabled({
            command: SETTINGS_VIEW_COMMANDS.SET_ALL_AGENTS_ENABLED,
            category,
            source,
            enabled,
          }),
        openFolder: (data) => this.agentHandlers.handleOpenAgentFolder(data),
        create: (data) => this.agentHandlers.handleCreateAgent(data),
        customize: (data) => this.agentHandlers.handleCustomizeAgent(data),
        deleteCustom: (data) =>
          this.agentHandlers.handleDeleteCustomAgent(data),
        revealFile: ({ source, name }) =>
          this.agentHandlers.handleRevealAgentFile({
            command: SETTINGS_VIEW_COMMANDS.REVEAL_AGENT_FILE,
            agentSource: source,
            agentName: name,
          }),
        viewRemotePrompt: (data) =>
          this.agentHandlers.handleViewRemoteAgentPrompt(data),
        getCustomDir: () =>
          this.withActiveWebview((w) =>
            this.agentHandlers.sendCustomAgentDir(w),
          ),
        setCustomDir: () => this.agentHandlers.handleSetCustomAgentDir(),
        resetCustomDir: () => this.agentHandlers.handleResetCustomAgentDir(),
        getModePresets: () =>
          this.withActiveWebview((w) =>
            this.agentHandlers.sendAgentModePresets(w),
          ),
        applyModePreset: (presetId) =>
          this.agentHandlers.handleApplyAgentModePreset({
            command: SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET,
            presetId,
          }),
        saveModePreset: () =>
          this.agentHandlers.handleSaveAgentModePreset({
            command: SETTINGS_VIEW_COMMANDS.SAVE_AGENT_MODE_PRESET,
          }),
        deleteModePreset: (presetId) =>
          this.agentHandlers.handleDeleteAgentModePreset({
            command: SETTINGS_VIEW_COMMANDS.DELETE_AGENT_MODE_PRESET,
            presetId,
          }),
      },
      gitAuthor: {
        getSettings: () =>
          this.withActiveWebview((w) => this.sendGitAuthorSettings(w)),
        setMarkCommits: (enabled) =>
          setGitAuthor(StateKeys.GIT_MARK_COMMITS, enabled),
        setName: (name) => setGitAuthor(StateKeys.GIT_AUTHOR_NAME, name),
        setEmail: (email) => setGitAuthor(StateKeys.GIT_AUTHOR_EMAIL, email),
        setWorktreeSupport: (enabled) =>
          setGitAuthor(StateKeys.GIT_WORKTREE_SUPPORT, enabled),
      },
      githubSubscriptions: {
        getTokenStatus: () =>
          this.withActiveWebview((w) =>
            this.githubHandlers.sendGitHubTokenStatus(w),
          ),
        setToken: () => this.githubHandlers.handleSetGitHubToken(),
        removeToken: () => this.githubHandlers.handleRemoveGitHubToken(),
        openTokenUrl: () => this.githubHandlers.openGitHubTokenUrl(),
        getSubscriptions: () =>
          this.withActiveWebview((w) =>
            this.githubHandlers.sendPRSubscriptions(w),
          ),
        unsubscribe: (data) => this.githubHandlers.handleUnsubscribePR(data),
        openSubscriptionStream: (data) =>
          this.githubHandlers.handleOpenPRSubscriptionStream(data),
      },
      chatGpt: {
        getAuthStatus: () =>
          this.withActiveWebview((w) =>
            this.chatgptHandlers.sendChatGptAuthStatus(w),
          ),
        signIn: () => this.chatgptHandlers.handleSignInChatGpt(),
        signOut: () => this.chatgptHandlers.handleSignOutChatGpt(),
        setPreferSubscription: (enabled) =>
          this.chatgptHandlers.handleSetPreferSubscription(enabled),
        setSubscriptionToolUseOnly: (enabled) =>
          this.chatgptHandlers.handleSetSubscriptionToolUseOnly(enabled),
      },
      approval: {
        getSettings: () =>
          this.withActiveWebview((w) => this.sendApprovalSettings(w)),
        setBashApprovalEnabled: (enabled) =>
          this.handleSetApprovalEnabled(enabled),
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
        getDashboardData: () =>
          this.withActiveWebview((w) => this.sendToolDashboardData(w)),
        openInstallUrl: (url) => this.openExternalUrl(url),
        installExtension: (extensionId) =>
          this.latexHandlers.installExtension(extensionId),
        recheckStatus: () => refreshToolAvailability(),
        toggle: async (toolId, enabled) => {
          await setToolEnabled(toolId, enabled);
          refreshDisabledToolCache();
          await this.withActiveWebview((w) =>
            this.sendToolDashboardData(w, { skipChecks: true }),
          );
        },
        runCommand: (data) =>
          this.handleRunToolCommand({
            command: SETTINGS_VIEW_COMMANDS.RUN_TOOL_COMMAND,
            ...data,
          }),
      },
      latex: {
        getSettingsStatus: () =>
          this.withActiveWebview((w) =>
            this.latexHandlers.sendLatexSettingsStatus(w),
          ),
        applySettings: (data) =>
          this.latexHandlers.handleApplyLatexSettings(data),
        installLatexWorkshop: () =>
          this.latexHandlers.handleInstallLatexWorkshop(),
        runInstallCommand: (installCommand) =>
          this.latexHandlers.handleRunInstallCommand({
            command: SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND,
            installCommand,
          }),
        getConfigValues: () =>
          this.withActiveWebview((w) =>
            this.latexHandlers.sendLatexConfigValues(w),
          ),
        setConfigValue: ({ field, value }) =>
          this.latexHandlers.handleSetLatexConfigValue({
            command: SETTINGS_VIEW_COMMANDS.SET_LATEX_CONFIG_VALUE,
            field,
            value,
          }),
      },
      inlineCriticism: {
        getEnabled: () =>
          this.withActiveWebview((w) => this.sendInlineCriticismEnabled(w)),
        setEnabled: (enabled) => this.handleSetInlineCriticismEnabled(enabled),
      },
      goals: {
        getList: () => this.withActiveWebview((w) => this.sendGoalList(w)),
        revealStream: async (streamId) => {
          await revealProgressStream(streamId);
        },
      },
      desktopCrashReporting: {
        get: unsupported('Crash reporting is a desktop-app setting.'),
        setEnabled: unsupported('Crash reporting is a desktop-app setting.'),
        setDsn: unsupported('Crash reporting is a desktop-app setting.'),
      },
    };

    return createSettingsViewCommandHandlers(actions);
  }

  public async sendGoalList(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(this.goalController.getGoalListMessage());
  }

  private handleRunToolCommand(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.RUN_TOOL_COMMAND>,
  ): void {
    const action = buildToolDashboardTerminalAction({
      toolId: data.toolId,
      commandKind: data.kind,
    });
    if (action.kind === 'none') {
      this.logger.debug(this.channel, 'No command for tool', {
        data: { ...data, reason: action.reason },
      });
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: action.name,
    });
    terminal.show();
    terminal.sendText(action.command);
  }

  public override async handleMessage(
    message: unknown,
    webviewView: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.dispatchInbound(
      message,
      webviewView,
      dispatchSettingsViewInbound,
      this.handlerRegistry,
    );
  }

  // ============================================================
  // Public methods for external access
  // ============================================================

  public async sendAllData(webview: vscode.Webview): Promise<void> {
    // Tool dashboard involves network I/O (Zotero probe, etc.) — fire async
    // so it doesn't block the initial render. The frontend shows a loading
    // spinner until data arrives.
    void this.sendToolDashboardData(webview);

    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.SET_UNSUPPORTED_COMMANDS,
      commands: unsupportedCommands(this.handlerRegistry),
    });

    // Auth/session changes affect included access and must not reuse a
    // pre-login/pre-logout availability snapshot.
    invalidateModelOptionsCache();
    await this.sendProfileAndModelSelectionData(webview);

    await Promise.all([
      this.sendMemoryData(webview),
      this.sendMemoryEnabled(webview),
      this.historyHandlers.sendHistoryData(webview),
      this.agentHandlers.sendAgentSelectionData(webview),
      this.agentHandlers.sendCustomAgentDir(webview),
      this.sendSuperYoloEnabled(webview),
      this.agentHandlers.sendAgentModePresets(webview),
      this.sendGitAuthorSettings(webview),
      this.githubHandlers.sendGitHubTokenStatus(webview),
      this.chatgptHandlers.sendChatGptAuthStatus(webview),
      this.githubHandlers.sendPRSubscriptions(webview),
      this.sendApprovalSettings(webview),
      this.latexHandlers.sendLatexSettingsStatus(webview),
      this.latexHandlers.sendLatexConfigValues(webview),
      this.sendInlineCriticismEnabled(webview),
      this.sendGoalList(webview),
    ]);
  }

  public async sendMemoryData(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(
      await this.memoryController.getMemoryDataMessage(),
    );
  }

  private async handleGetMemoryPreview(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.GET_MEMORY_PREVIEW>,
  ): Promise<void> {
    await this.withActiveWebview(async (webview) => {
      try {
        await webview.postMessage(
          await this.memoryController.getMemoryPreviewMessage(data.storagePath),
        );
      } catch (error) {
        void showLoggedErrorMessage(
          this.channel,
          'Failed to load memory preview',
          error,
        );
        await webview.postMessage(
          this.memoryController.getMemoryPreviewErrorMessage(data.storagePath),
        );
      }
    });
  }

  public async sendMemoryEnabled(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(this.memoryController.getMemoryEnabledMessage());
  }

  public async sendInlineCriticismEnabled(
    webview: vscode.Webview,
  ): Promise<void> {
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_INLINE_CRITICISM_ENABLED,
      enabled: isInlineCriticismEnabled(),
    });
  }

  private async handleSetInlineCriticismEnabled(
    enabled: boolean,
  ): Promise<void> {
    await setInlineCriticismEnabled(enabled);
    await this.withActiveWebview((w) => this.sendInlineCriticismEnabled(w));
  }

  public async sendProfileData(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(
      await this.profileController.buildProfileMessage(),
    );
  }

  public async sendModelSelectionData(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(
      await buildModelSelectionMessage(this.modelSelectionController),
    );
  }

  private async sendProfileAndModelSelectionData(
    webview: vscode.Webview,
  ): Promise<void> {
    await this.sendProfileData(webview);
    await this.sendModelSelectionData(webview);
  }

  // ============================================================
  // Multi-agent coordination handler implementations
  // ============================================================

  public async sendSuperYoloEnabled(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(
      buildSuperYoloMessage({
        workspaceState: workspaceSM,
        globalState: globalSM,
        getReliabilitySettings: () =>
          this.profileController.getReliabilitySettings(),
      }),
    );
  }

  private async updateBooleanAndSendSuperYolo(
    key: WorkspaceStateKey,
    data: { enabled: boolean },
  ): Promise<void> {
    await workspaceSM.update(key, data.enabled);
    await this.withActiveWebview((w) => this.sendSuperYoloEnabled(w));
  }

  // ============================================================
  // Git author settings handler implementations
  // ============================================================

  private async sendGitAuthorSettings(
    webview: vscode.Webview,
    settings?: ReturnType<typeof readGitAuthorSettings>,
  ): Promise<void> {
    await webview.postMessage(
      buildGitAuthorSettingsMessage(
        settings ?? readGitAuthorSettingsFromState(workspaceSM),
      ),
    );
  }

  private async updateGitAuthorSetting(
    key: WorkspaceStateKey,
    value: unknown,
  ): Promise<void> {
    await workspaceSM.update(key, value);
    const settings = applyGitAuthorConfig();
    await this.withActiveWebview((w) =>
      this.sendGitAuthorSettings(w, settings),
    );
  }

  // ============================================================
  // Approval settings handler implementations
  // ============================================================

  private async sendApprovalSettings(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(
      buildApprovalSettingsMessage({
        workspaceState: workspaceSM,
        globalState: globalSM,
        config: platform().config,
      }),
    );
  }

  private async handleSetApprovalEnabled(enabled: boolean): Promise<void> {
    // Bash approval is a per-workspace, security-adjacent setting (see
    // BASH_APPROVAL_CONFIG_TARGET / issue #7085). VS Code throws when
    // writing a Workspace-target setting with no folder open, so refuse the
    // write up front rather than let that throw surface -- this is an
    // expected, non-error condition (no folder open yet), so inform rather
    // than alarm. Re-send the persisted settings afterwards so the webview's
    // (optimistically-toggled) switch snaps back to the actual, unwritten
    // value instead of drifting from it.
    if (!vscode.workspace.workspaceFolders?.length) {
      void showLoggedInfoMessage(
        this.channel,
        'Bash approval is a per-workspace setting. Open a workspace folder before changing it.',
      );
      await this.withActiveWebview((w) => this.sendApprovalSettings(w));
      return;
    }
    await setBashApprovalEnabledShared(
      {
        workspaceState: workspaceSM,
        globalState: globalSM,
        config: platform().config,
      },
      enabled,
      BASH_APPROVAL_CONFIG_TARGET,
    );
    await this.withActiveWebview((w) => this.sendApprovalSettings(w));
  }

  private async updateAgentSetting(
    key: WorkspaceStateKey,
    value: string,
  ): Promise<void> {
    await setWorkspaceAgentSetting(
      { workspaceState: workspaceSM, globalState: globalSM },
      key,
      value,
    );
    await this.withActiveWebview((w) => this.sendApprovalSettings(w));
  }

  // ============================================================
  // Navigation handler implementations
  // ============================================================

  private async openVscodeSettings(): Promise<void> {
    await safeExecuteCommand(
      'workbench.action.openSettings',
      ['@ext:texra-ai.texra'],
      this.viewName,
    );
  }

  // ============================================================
  // Memory handler implementations
  // ============================================================

  private async handleOpenMemoryFile(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.OPEN_MEMORY_FILE>,
  ): Promise<void> {
    try {
      const resolvedPath = resolveMemoryStoragePath(data.storagePath);
      const absolutePath = StorageFS.fullPath(resolvedPath);
      const fileUri = vscode.Uri.file(absolutePath);

      // Open markdown files in preview mode (read-only rendered view)
      if (hasExtension(absolutePath, '.md')) {
        await safeExecuteCommand(
          'markdown.showPreview',
          [fileUri],
          this.viewName,
        );
      } else {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preview: false });
      }
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to open memory file',
        error,
      );
    }
  }

  private async handleOpenMemoryFolder(): Promise<void> {
    try {
      await StorageFS.ensureDir(resolveMemoryStoragePath());
      const absolutePath = StorageFS.fullPath(resolveMemoryStoragePath());
      await safeExecuteCommand(
        'revealFileInOS',
        [vscode.Uri.file(absolutePath)],
        this.viewName,
      );
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to open memory folder',
        error,
      );
    }
  }

  private async handleDeleteMemory(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.DELETE_MEMORY>,
  ): Promise<void> {
    try {
      const message = await this.memoryController.deleteMemory(data);
      await this.postMessageToActiveWebview(message);
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to delete memory',
        error,
      );
      await this.withActiveWebview((w) => this.sendMemoryData(w));
    }
  }

  private async handleSetMemoryEnabled(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_MEMORY_ENABLED>,
  ): Promise<void> {
    const message = await this.memoryController.setMemoryEnabled(data.enabled);
    await this.postMessageToActiveWebview(message);
  }

  private async setMemoryPinned(
    storagePath: string,
    pinned: boolean,
  ): Promise<void> {
    try {
      const message = pinned
        ? await this.memoryController.pinMemory(storagePath)
        : await this.memoryController.unpinMemory(storagePath);
      await this.postMessageToActiveWebview(message);
    } catch (error) {
      const action = pinned ? 'pin' : 'unpin';
      await showLoggedErrorMessage(
        this.channel,
        `Failed to ${action} memory`,
        error,
      );
    }
  }

  // ============================================================
  // Profile handler implementations
  // ============================================================

  private async handleSetApiAccessMode(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_API_ACCESS_MODE>,
  ): Promise<void> {
    const update = await this.profileController.setApiAccessMode(data.mode);
    await this.withActiveWebview(async (w) => {
      await this.sendProfileAndModelSelectionData(w);
    });
    const modeLabel =
      update.mode === 'included' ? 'Included Access' : 'My Own Keys';
    const suffix = update.openRouterDisabled
      ? ' OpenRouter has been turned off (not compatible with Included Access).'
      : '';
    void vscode.window.showInformationMessage(
      `Model access changed to: ${modeLabel}.${suffix}`,
    );
  }

  private async runProviderKeyAction(
    provider: string,
    verb: 'set' | 'remove',
    actionFn: (provider: string) => Promise<void>,
  ): Promise<void> {
    try {
      await actionFn(provider);
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        `Failed to ${verb} ${this.profileController.getProviderDisplayName(provider)} API key`,
        error,
      );
      // On error, still refresh settings view to reflect current key state.
      await this.withActiveWebview((w) =>
        this.sendProfileAndModelSelectionData(w),
      );
    }
  }

  /**
   * Refresh main view API key status, model options, and settings-view model/profile
   * data after key changes. Model selection availability depends on provider
   * key state, so keep it paired with the profile refresh.
   */
  private async refreshAfterKeyChange(): Promise<void> {
    // Invalidate caches so downstream refreshes see fresh key state.
    invalidateModelOptionsCache();
    invalidateApiKeyCache();
    await safeExecuteCommand('texra.refreshApiKeyStatus', [], this.viewName);
    await Promise.all([
      safeExecuteCommand('texra.refreshAllOptions', [], this.viewName),
      this.withActiveWebview((w) => this.sendProfileAndModelSelectionData(w)),
    ]);
  }

  private async refreshAfterChatGptAuthChange(): Promise<void> {
    invalidateModelOptionsCache();
    await Promise.all([
      // ChatGPT subscription is now a setup credential, so reuse the same
      // host refresh path as API-key changes to update the welcome card.
      safeExecuteCommand('texra.refreshApiKeyStatus', [], this.viewName),
      safeExecuteCommand('texra.refreshAllOptions', [], this.viewName),
      this.withActiveWebview((w) => this.sendModelSelectionData(w)),
    ]);
  }

  /** Refresh settings-view agent list and main-view dropdown after agent mutations. */
  private async refreshAfterAgentMutation(
    selectedToolUseAgent?: string,
  ): Promise<void> {
    await Promise.all([
      this.withActiveWebview((w) =>
        this.agentHandlers.sendAgentSelectionData(w),
      ),
      safeExecuteCommand(
        'texra.refreshAllOptions',
        selectedToolUseAgent ? [{ selectedToolUseAgent }] : [],
        this.viewName,
      ),
    ]);
  }

  private async handleSetProviderVscodeSetting(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_PROVIDER_VSCODE_SETTING>,
  ): Promise<void> {
    const result = await this.profileController.setProviderVscodeSetting(data);
    if (result.kind === 'rejected') {
      this.logger.warn(
        this.channel,
        `Rejected unknown vscode setting key: ${result.key}`,
      );
      return;
    }

    await this.withActiveWebview(async (w) => {
      await Promise.all([
        this.sendProfileData(w),
        this.sendSuperYoloEnabled(w),
        result.affectsModelAvailability
          ? this.sendModelSelectionData(w)
          : Promise.resolve(),
      ]);
    });

    if (result.affectsModelAvailability) {
      await safeExecuteCommand('texra.refreshAllOptions', [], this.viewName);
    }
  }

  // ============================================================
  // Tool dashboard handler implementations
  // ============================================================

  public async sendToolDashboardData(
    webview: vscode.Webview,
    options?: { skipChecks?: boolean },
  ): Promise<void> {
    const cachedResults = options?.skipChecks
      ? (getLastCheckResults() ?? undefined)
      : undefined;
    const items = await buildToolDashboardItems(cachedResults);
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
      items,
    });
  }

  private async openExternalUrl(url: string): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  private async postMessageToActiveWebview(
    message: unknown | null | undefined,
  ): Promise<void> {
    if (message == null) return;
    await this.withActiveWebview(async (webview) => {
      await webview.postMessage(message);
    });
  }

  private async updateProfileSetting(
    update: () => Promise<void>,
  ): Promise<void> {
    await update();
    await this.withActiveWebview((w) => this.sendProfileData(w));
  }

  private async updateModelSelection(
    update: () => Promise<void>,
    options: { invalidateCache?: boolean; refreshMainOptions?: boolean } = {},
  ): Promise<void> {
    await update();
    if (options.invalidateCache) {
      invalidateModelOptionsCache();
    }

    const refreshSettings = this.withActiveWebview((w) =>
      this.sendModelSelectionData(w),
    );
    if (!options.refreshMainOptions) {
      await refreshSettings;
      return;
    }

    await Promise.all([
      safeExecuteCommand('texra.refreshAllOptions', [], this.viewName),
      refreshSettings,
    ]);
  }
}
