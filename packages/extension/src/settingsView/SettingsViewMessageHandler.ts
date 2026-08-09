/**
 * Schema-driven message handler for every SettingsView tab.
 *
 * This class owns the inbound registry, the memory/profile/model/tool commands,
 * and the refresh fan-out after a mutation. Tab-shaped groups are delegated to
 * focused handler classes in `./handlers/`: `AgentHandlers`,
 * `LatexSettingsHandlers`, `HistoryHandlers`, `GitHubSubscriptionHandlers`, and
 * `SubscriptionHandlers` (one instance per subscription provider).
 */
import * as path from 'node:path';

import * as vscode from 'vscode';

// Shared schemas and dispatchers
import { defaultSession } from '@agent/runtime/SessionHandle';
import { getServerSideKeyService } from '@auth/serverKeys';
import { AUTH_COMMANDS } from '@auth/constants';
import { globalSM, workspaceSM } from '@common/state';
import { BaseViewMessageHandler } from '@common/webview';
import { SettingsViewHost } from '@controllers/settingsView/SettingsViewHost';
import { SubscriptionUsageService } from '@controllers/modelAccess/subscriptionUsage/SubscriptionUsageService';
import {
  buildToolDashboardItems,
  planToolTerminalAction,
} from '@controllers/settingsView/ToolDashboardData';
import { SettingsProfileKeyController } from '@controllers/settingsView/SettingsProfileKeyController';
import {
  SettingsProfileController,
  getSharedProviderProfileDefaults,
} from '@controllers/settingsView/SettingsProfileController';
import { appSignals } from '@eventBus/AppSignals';
import { SecretManager, type ApiProvider } from '@frontend/secretManager';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import {
  isInlineCriticismEnabled,
  setInlineCriticismEnabled,
} from '@frontend/latex/inlineCriticism';
import { VscodePromptHost } from '@frontend/hosts/VscodePromptHost';
import { VscodeExternalOpener } from '@frontend/hosts/VscodeExternalOpener';
import { applyGitAuthorConfig } from '@frontend/git/gitAuthorSetup';
import {
  logErrorMessage,
  showLoggedErrorMessage,
  showLoggedInfoMessage,
} from '@frontend/ui/errorHandlingUtils';
import { refreshApprovalPolicyTooltip } from '@frontend/statusBar/approvalPolicyTooltipRefresh';
import {
  invalidateApiKeyCache,
  loadApiKeyStatusMap,
} from '@model/apiProviders';
import {
  invalidateRuntimeModelRegistry,
  requestRuntimeModelAccess,
} from '@model/runtimeModelRegistry';
import { setCopilotRoutePreference } from '@model/copilotRouting';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import {
  LANGUAGE_MODEL_PORT_ERROR_CODE,
  LanguageModelPortError,
} from '@platform/languageModel';
import { platform } from '@platform/platform';
import {
  resolveMemoryStoragePath,
  RUNS_STORAGE_DIR,
} from '@platform/defaults/workspaceStorage';
import { revealProgressStream } from '@progressView/progressNavigation';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { INCLUDED_ACCESS, OWN_API_KEYS } from '@shared/copy/modelAccess';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { SettingsViewSnapshot } from '@shared/schemas/stateSettings';
import {
  applyStateSettingUpdate,
  postStateSettingSnapshot as dispatchStateSettingSnapshot,
} from '@shared/settingsView/handlers/stateSettingWrite';
import {
  dispatchSettingsViewInbound,
  type SettingsViewInboundHandlerRegistry,
  type SettingsViewInboundMessage,
  type SettingsMessageFor,
  SETTINGS_VIEW_CMD,
} from '@shared/schemas/settingsViewMessages';
import { unsupportedCommands } from '@shared/utils/dispatcher';
import { buildApprovalSettingsMessage } from '@shared/settingsView/handlers/approvalHandlers';
import { buildAgentSkillsSettingsMessage } from '@shared/settingsView/handlers/agentSkillsHandlers';
import { buildTelemetrySettingsMessage } from '@shared/settingsView/handlers/telemetrySettingsHandlers';
import { buildReliabilityAndOrchestrationMessage } from '@shared/settingsView/handlers/superYoloHandlers';
import {
  getLastCheckResults,
  refreshToolAvailability,
} from '@tools/toolAvailability';
import { GoalStore, subscribeGoalStateChanges } from '@tools/goal';
import { StorageFS, WorkspaceFS } from '@utils/files';
import { debounce } from '@utils/core';
import { hasExtension } from '@utils/core/pathCore';
import {
  buildGitAuthorSettingsMessage,
  readGitAuthorSettingsFromState,
  type GitAuthorSettings,
} from '@utils/system/gitAuthorSettings';
import { DEBOUNCE_OPTIONS_MS } from '@utils/config/constants';
import {
  setGlobalStreaming,
  setProviderStreaming,
  setProviderEndpoint,
} from '@utils/config/providerConfig';
import { getConfig, updateConfig } from '@utils/config/configUtils';
import { setToolEnabled } from '@utils/config/constants';
import { AgentHandlers } from './handlers/agentHandlers';
import { LatexSettingsHandlers } from './handlers/latexSettingsHandlers';
import { HistoryHandlers } from './handlers/historyHandlers';
import { GitHubSubscriptionHandlers } from './handlers/githubSubscriptionHandlers';
import {
  CHATGPT_SUBSCRIPTION_PROVIDER,
  GROK_SUBSCRIPTION_PROVIDER,
  SubscriptionHandlers,
} from './handlers/subscriptionHandlers';
import {
  sendSubscriptionUsage,
  type SubscriptionUsageReader,
} from './handlers/subscriptionUsageHandlers';
import type { SettingsHandlerContext } from './handlers/SettingsHandlerContext';

// Re-use the shared type helper for extracting specific message types.
type MessageFor<C extends SettingsViewInboundMessage['command']> =
  SettingsMessageFor<C>;

export class SettingsViewMessageHandler extends BaseViewMessageHandler<
  vscode.WebviewView | vscode.WebviewPanel
> {
  private executionsWatcher: vscode.FileSystemWatcher | undefined;
  private executionsWatcherGeneration = 0;
  private readonly handlerRegistry: SettingsViewInboundHandlerRegistry;

  // Domain-specific handler delegates
  private readonly agentHandlers: AgentHandlers;
  private readonly latexHandlers: LatexSettingsHandlers;
  private readonly historyHandlers: HistoryHandlers;
  private readonly githubHandlers: GitHubSubscriptionHandlers;
  private readonly chatgptHandlers: SubscriptionHandlers;
  private readonly grokHandlers: SubscriptionHandlers;
  private readonly settingsHost: SettingsViewHost;
  private readonly profileController: SettingsProfileController;
  private readonly profileKeyController: SettingsProfileKeyController;
  private readonly subscriptionUsage: SubscriptionUsageReader;

  constructor(
    context: vscode.ExtensionContext,
    subscriptionUsage: SubscriptionUsageReader = new SubscriptionUsageService(),
  ) {
    super('SettingsView', { trackActiveView: true });

    const ctx: SettingsHandlerContext = {
      channel: this.channel,
      logger: this.logger,
      extensionContext: context,
      withActiveWebview: (fn) => this.withActiveWebview(fn),
    };

    // Must build inside the constructor: globalSM/workspaceSM are populated
    // by extension.ts → initializeStateManagers and are still undefined at
    // module load, so destructuring them at top level captures `undefined`
    // and every later globalState.get(...) throws.
    this.settingsHost = new SettingsViewHost({
      state: { workspaceState: workspaceSM, globalState: globalSM },
      memoryPrompt: new VscodePromptHost(),
      modelSelectionExtras: {
        useIncludedAccess: () =>
          getServerSideKeyService().getUseIncludedModelAccess(),
        getUserTier: () => getServerSideKeyService().getUserTier() ?? undefined,
      },
    });
    this.profileController = new SettingsProfileController({
      ...getSharedProviderProfileDefaults(),
      globalState: globalSM,
      loadProviderKeyStatuses: () =>
        loadApiKeyStatusMap(platform().secrets, SecretManager.API_PROVIDERS),
      getConfig,
      updateConfig: (key, value) =>
        updateConfig(key, value, { target: 'global', prefix: false }),
      setUseIncludedModelAccess: (enabled) =>
        getServerSideKeyService().setUseIncludedModelAccess(enabled),
      refreshSpendingStatus: () =>
        getServerSideKeyService().refreshSpendingStatus(),
    });
    this.subscriptionUsage = subscriptionUsage;
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
      refreshAfterKeyChange: (provider) => this.refreshAfterKeyChange(provider),
    });
    this.agentHandlers = new AgentHandlers(
      ctx,
      (selectedToolUseAgent, agentCatalogAlreadyFresh) =>
        this.refreshAfterAgentMutation(
          selectedToolUseAgent,
          agentCatalogAlreadyFresh,
        ),
    );
    this.latexHandlers = new LatexSettingsHandlers(ctx);
    this.historyHandlers = new HistoryHandlers(ctx);
    this.githubHandlers = new GitHubSubscriptionHandlers(ctx);
    this.chatgptHandlers = new SubscriptionHandlers(
      CHATGPT_SUBSCRIPTION_PROVIDER,
      ctx,
      () => this.refreshAfterSubscriptionAuthChange('chatgpt'),
    );
    this.grokHandlers = new SubscriptionHandlers(
      GROK_SUBSCRIPTION_PROVIDER,
      ctx,
      () => this.refreshAfterSubscriptionAuthChange(),
    );
    this.handlerRegistry = this.createHandlerRegistry();

    const refreshSubscriptions = () =>
      void this.withActiveWebview((w) =>
        this.githubHandlers.sendPRSubscriptions(w),
      );
    for (const signal of [
      'prSubscriptionsChanged',
      'prSubscriptionBindingsChanged',
      'repoSubscriptionsChanged',
      'repoSubscriptionBindingsChanged',
      'issueSubscriptionsChanged',
      'issueSubscriptionBindingsChanged',
    ] as const) {
      context.subscriptions.push({
        dispose: appSignals.on(signal, refreshSubscriptions),
      });
    }
    context.subscriptions.push(
      {
        dispose: appSignals.on('toolAvailabilityChanged', () => {
          void this.withActiveWebview((w) =>
            this.sendToolDashboardData(w, { skipChecks: true }),
          );
        }),
      },
      {
        dispose: appSignals.on('languageModelsChanged', () => {
          void this.withActiveWebview((webview) =>
            this.sendModelSelectionData(webview),
          );
        }),
      },
    );
    const unsubscribeGoals = subscribeGoalStateChanges(defaultSession(), () => {
      void this.withActiveWebview((w) => this.sendGoalList(w));
    });
    context.subscriptions.push({ dispose: unsubscribeGoals });

    // Cross-host history refresh (#8625): the shared ~/.texra executions dir
    // is written by the CLI and desktop too, so an open history tab re-lists
    // when any host adds, finishes, or deletes a run. Re-registered on
    // workspace-folder changes because the storage path follows the current
    // workspace.
    void this.registerExecutionsWatcher();
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.registerExecutionsWatcher();
      }),
      { dispose: () => this.invalidateExecutionsWatcher() },
    );
  }

  private invalidateExecutionsWatcher(): number {
    const generation = ++this.executionsWatcherGeneration;
    const watcher = this.executionsWatcher;
    this.executionsWatcher = undefined;
    watcher?.dispose();
    return generation;
  }

  /**
   * Watch the shared executions directory (outside the workspace, hence the
   * RelativePattern base) and re-send the history list to the active settings
   * webview. The debounce coalesces launch and terminal write bursts.
   */
  private async registerExecutionsWatcher(): Promise<void> {
    const generation = this.invalidateExecutionsWatcher();
    let candidate: vscode.FileSystemWatcher | undefined;
    try {
      const executionsDir = path.join(
        platform().storage.getStoragePath(),
        RUNS_STORAGE_DIR,
      );
      // A watcher rooted at a not-yet-existing directory can silently never
      // fire; the dir is cheap to create and always wanted.
      await StorageFS.ensureDir(RUNS_STORAGE_DIR);
      // A workspace change or teardown may supersede this registration while
      // directory setup is pending.
      if (generation !== this.executionsWatcherGeneration) return;
      const refreshHistory = debounce(
        () =>
          this.withActiveWebview((w) =>
            this.historyHandlers.sendHistoryData(w),
          ),
        DEBOUNCE_OPTIONS_MS,
      );
      const onExecutionsEvent = () => {
        void refreshHistory();
      };
      candidate = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(executionsDir), '**'),
      );
      candidate.onDidCreate(onExecutionsEvent);
      candidate.onDidChange(onExecutionsEvent);
      candidate.onDidDelete(onExecutionsEvent);
      // Publish only a candidate that still owns the current generation.
      if (generation !== this.executionsWatcherGeneration) {
        candidate.dispose();
        return;
      }
      this.executionsWatcher = candidate;
    } catch (error) {
      candidate?.dispose();
      if (generation !== this.executionsWatcherGeneration) return;
      logErrorMessage(
        this.channel,
        'Failed to register execution history watcher',
        error,
      );
    }
  }

  private createHandlerRegistry(): SettingsViewInboundHandlerRegistry {
    return {
      webviewReady: () => this.withActiveWebview((w) => this.sendAllData(w)),
      getMemoryData: () =>
        this.withActiveWebview((w) => this.sendMemoryData(w)),
      getMemoryPreview: (message) => this.handleGetMemoryPreview(message),
      openMemoryFile: (message) => this.handleOpenMemoryFile(message),
      openMemoryFolder: () => this.handleOpenMemoryFolder(),
      deleteMemory: (message) => this.handleDeleteMemory(message),
      setMemoryEnabled: (message) => this.handleSetMemoryEnabled(message),
      pinMemory: (message) => this.setMemoryPinned(message.storagePath, true),
      unpinMemory: (message) =>
        this.setMemoryPinned(message.storagePath, false),
      rerunAgent: (message) => this.historyHandlers.handleRerunAgent(message),
      restoreAgent: (message) =>
        this.historyHandlers.handleRestoreAgent(message),
      deleteAgent: (message) => this.historyHandlers.handleDeleteAgent(message),
      clearHistory: () => this.historyHandlers.handleClearHistory(),
      exportChatMd: (message) =>
        this.historyHandlers.handleExportChat(message, 'md'),
      exportChatTex: (message) =>
        this.historyHandlers.handleExportChat(message, 'tex'),
      exportChatHtml: (message) =>
        this.historyHandlers.handleExportChat(message, 'html'),
      signIn: () =>
        safeExecuteCommand(AUTH_COMMANDS.SIGN_IN, [], this.viewName),
      signOut: () =>
        safeExecuteCommand(AUTH_COMMANDS.SIGN_OUT, [], this.viewName),
      setApiAccessMode: (message) => this.handleSetApiAccessMode(message),
      setProviderKey: (message) =>
        this.runProviderKeyAction(message.provider, 'set', (targetProvider) =>
          this.profileKeyController.setProviderKey(targetProvider),
        ),
      removeProviderKey: (message) =>
        this.runProviderKeyAction(
          message.provider,
          'remove',
          (targetProvider) =>
            this.profileKeyController.removeProviderKey(targetProvider),
        ),
      openProviderKeyUrl: (message) =>
        this.profileKeyController.openProviderKeyUrl(message.provider),
      setProviderStreaming: async (message) => {
        await setProviderStreaming(message.provider, message.enabled);
        await this.withActiveWebview((webview) =>
          this.sendProfileData(webview),
        );
      },
      setProviderEndpoint: async (message) => {
        await setProviderEndpoint(message.provider, message.endpoint);
        await this.withActiveWebview((webview) =>
          this.sendProfileData(webview),
        );
      },
      setGlobalStreaming: async (message) => {
        await setGlobalStreaming(message.enabled);
        await this.withActiveWebview((webview) =>
          this.sendProfileData(webview),
        );
      },
      setProviderSetting: (message) => this.handleSetProviderSetting(message),
      openExternalUrl: (message) => this.openExternalUrl(message.url),
      setModelEnabled: (message) =>
        this.setModelEnabled(message.modelName, message.enabled),
      setPolishModel: (message) =>
        this.settingsHost.setHelperModel(message.modelName, {
          respond: (response) => this.postMessageToActiveWebview(response),
        }),
      setModelReasoningLevel: (message) =>
        this.settingsHost.setReasoningLevel(
          { modelName: message.modelName, level: message.level },
          {
            respond: (response) => this.postMessageToActiveWebview(response),
          },
        ),
      setPreferShortModelNames: (message) =>
        this.settingsHost.setPreferShortModelNames(message.enabled, {
          respond: (response) => this.postMessageToActiveWebview(response),
        }),
      requestModelAccess: (message) =>
        this.handleRequestModelAccess(message.modelName),
      clearCopilotRoute: (message) =>
        this.handleClearCopilotRoute(message.modelName),
      setAgentEnabled: (message) =>
        this.agentHandlers.handleSetAgentEnabled(message),
      setAllAgentsEnabled: (message) =>
        this.agentHandlers.handleSetAllAgentsEnabled(message),
      openAgentYaml: (message) =>
        this.agentHandlers.handleOpenAgentYaml(message),
      openAgentFolder: (message) =>
        this.agentHandlers.handleOpenAgentFolder(message),
      createAgent: (message) => this.agentHandlers.handleCreateAgent(message),
      customizeAgent: (message) =>
        this.agentHandlers.handleCustomizeAgent(message),
      deleteCustomAgent: (message) =>
        this.agentHandlers.handleDeleteCustomAgent(message),
      revealAgentFile: (message) =>
        this.agentHandlers.handleRevealAgentFile(message),
      viewRemoteAgentPrompt: (message) =>
        this.agentHandlers.handleViewRemoteAgentPrompt(message),
      setCustomAgentDir: () => this.agentHandlers.handleSetCustomAgentDir(),
      resetCustomAgentDir: () => this.agentHandlers.handleResetCustomAgentDir(),
      applyAgentModePreset: (message) =>
        this.agentHandlers.handleApplyAgentModePreset(message),
      saveAgentModePreset: (message) =>
        this.agentHandlers.handleSaveAgentModePreset(message),
      deleteAgentModePreset: (message) =>
        this.agentHandlers.handleDeleteAgentModePreset(message),
      getGitHubTokenStatus: () =>
        this.withActiveWebview((w) =>
          this.githubHandlers.sendGitHubTokenStatus(w),
        ),
      setGitHubToken: () => this.githubHandlers.handleSetGitHubToken(),
      removeGitHubToken: () => this.githubHandlers.handleRemoveGitHubToken(),
      openGitHubTokenUrl: () => this.githubHandlers.openGitHubTokenUrl(),
      getPRSubscriptions: () =>
        this.withActiveWebview((w) =>
          this.githubHandlers.sendPRSubscriptions(w),
        ),
      unsubscribePR: (message) =>
        this.githubHandlers.handleUnsubscribePR(message),
      openPRSubscriptionStream: (message) =>
        this.githubHandlers.handleOpenPRSubscriptionStream(message),
      signInChatGpt: () => this.chatgptHandlers.handleSignIn(),
      signOutChatGpt: () => this.chatgptHandlers.handleSignOut(),
      setChatGptPreferSubscription: (message) =>
        this.chatgptHandlers.handleSetPreferSubscription(message.enabled),
      signInGrok: () => this.grokHandlers.handleSignIn(),
      signOutGrok: () => this.grokHandlers.handleSignOut(),
      setGrokPreferSubscription: (message) =>
        this.grokHandlers.handleSetPreferSubscription(message.enabled),
      getSubscriptionUsage: (message) =>
        this.withActiveWebview((webview) =>
          sendSubscriptionUsage(
            webview,
            this.subscriptionUsage,
            message.forceRefresh ?? false,
          ),
        ),
      updateStateSetting: (message) =>
        this.updateStateSetting(message.key, message.value),
      openToolInstallUrl: (message) => this.openExternalUrl(message.url),
      installToolExtension: (message) =>
        this.latexHandlers.installExtension(message.extensionId),
      recheckToolStatus: () => refreshToolAvailability(),
      toggleTool: async (message) => {
        await setToolEnabled(message.toolId, message.enabled);
        await this.withActiveWebview((w) =>
          this.sendToolDashboardData(w, { skipChecks: true }),
        );
      },
      runToolCommand: (message) => this.handleRunToolCommand(message),
      applyLatexSettings: (message) =>
        this.latexHandlers.handleApplyLatexSettings(message),
      installLatexWorkshop: () =>
        this.latexHandlers.handleInstallLatexWorkshop(),
      runInstallCommand: (message) =>
        this.latexHandlers.handleRunInstallCommand(message),
      getInlineCriticismEnabled: () =>
        this.withActiveWebview((w) => this.sendInlineCriticismEnabled(w)),
      setInlineCriticismEnabled: (message) =>
        this.handleSetInlineCriticismEnabled(message.enabled),
      getGoalList: () => this.withActiveWebview((w) => this.sendGoalList(w)),
      revealGoalStream: async (message) => {
        await revealProgressStream(message.streamId);
      },
    };
  }

  public async sendGoalList(webview: vscode.Webview): Promise<void> {
    try {
      const delivered = await webview.postMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST,
        items: GoalStore.list(),
      });
      if (!delivered) {
        throw new Error('settings webview is no longer available');
      }
    } catch (error) {
      await showLoggedErrorMessage(this.channel, 'Failed to load goals', error);
    }
  }

  private handleRunToolCommand(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.RUN_TOOL_COMMAND>,
  ): void {
    const action = planToolTerminalAction({
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
  // Full refresh — SettingsViewProvider's entry point
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
      this.sendReliabilityAndOrchestrationSettings(webview),
      this.agentHandlers.sendAgentModePresets(webview),
      this.sendGitAuthorSettings(webview),
      this.githubHandlers.sendGitHubTokenStatus(webview),
      this.chatgptHandlers.sendAuthStatus(webview),
      this.grokHandlers.sendAuthStatus(webview),
      this.githubHandlers.sendPRSubscriptions(webview),
      this.sendApprovalSettings(webview),
      this.sendAgentSkillsSettings(webview),
      this.sendTelemetrySettings(webview),
      this.latexHandlers.sendLatexSettingsStatus(webview),
      this.latexHandlers.sendLatexConfigValues(webview),
      this.sendInlineCriticismEnabled(webview),
      this.sendGoalList(webview),
    ]);
  }

  private async sendMemoryData(webview: vscode.Webview): Promise<void> {
    await this.settingsHost.sendMemoryData((message) =>
      webview.postMessage(message),
    );
  }

  private async handleGetMemoryPreview(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.GET_MEMORY_PREVIEW>,
  ): Promise<void> {
    await this.withActiveWebview(async (webview) => {
      await this.settingsHost.sendMemoryPreview(data, {
        respond: (message) => webview.postMessage(message),
        onError: async (error) => {
          await showLoggedErrorMessage(
            this.channel,
            'Failed to load memory preview',
            error,
          );
        },
      });
    });
  }

  private async sendMemoryEnabled(webview: vscode.Webview): Promise<void> {
    await this.settingsHost.sendMemoryEnabled((message) =>
      webview.postMessage(message),
    );
  }

  private async sendInlineCriticismEnabled(
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

  private async sendProfileData(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(
      await this.profileController.buildProfileMessage(),
    );
  }

  private async sendModelSelectionData(webview: vscode.Webview): Promise<void> {
    await this.settingsHost.sendModelSelectionData((message) =>
      webview.postMessage(message),
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

  private async sendReliabilityAndOrchestrationSettings(
    webview: vscode.Webview,
  ): Promise<void> {
    await webview.postMessage(
      buildReliabilityAndOrchestrationMessage({
        workspaceState: workspaceSM,
        globalState: globalSM,
        getReliabilitySettings: () =>
          this.profileController.getReliabilitySettings(),
      }),
    );
  }

  // ============================================================
  // Git author settings handler implementations
  // ============================================================

  private async sendGitAuthorSettings(
    webview: vscode.Webview,
    settings?: GitAuthorSettings,
  ): Promise<void> {
    await webview.postMessage(
      buildGitAuthorSettingsMessage(
        settings ?? readGitAuthorSettingsFromState(workspaceSM),
      ),
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

  private async sendAgentSkillsSettings(
    webview: vscode.Webview,
  ): Promise<void> {
    await webview.postMessage(
      buildAgentSkillsSettingsMessage(platform().config),
    );
  }

  private async sendTelemetrySettings(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(buildTelemetrySettingsMessage(platform().config));
  }

  /**
   * Generic write path for catalog-backed settings-view rows.
   */
  private async updateStateSetting(key: string, value: unknown): Promise<void> {
    const result = await applyStateSettingUpdate(key, value, {
      stores: {
        config: platform().config,
        workspaceState: workspaceSM,
        globalState: globalSM,
      },
      // The shared function already gates this hook on
      // `configTarget !== 'global'`; this checks only the workspace half.
      requiresOpenWorkspace: () => !WorkspaceFS.getPath(),
      onApprovalPolicyChanged: (policy) => {
        defaultSession().setApprovalPolicy(policy);
        refreshApprovalPolicyTooltip();
      },
    });
    if (result.kind === 'ignored') return;
    if (result.kind === 'rejected') {
      await showLoggedErrorMessage(
        this.channel,
        `Invalid value for “${result.entry.title ?? result.entry.key}”`,
        result.error,
      );
    } else if (result.kind === 'workspace-required') {
      void showLoggedInfoMessage(
        this.channel,
        `Open a workspace folder before changing the “${result.entry.title ?? result.entry.key}” setting.`,
      );
    } else if (result.kind === 'failed') {
      await showLoggedErrorMessage(
        this.channel,
        `Failed to update “${result.entry.title ?? result.entry.key}”`,
        result.error,
      );
    }
    await this.postStateSettingSnapshot(result.entry.settingsViewSnapshot);
  }

  private async postStateSettingSnapshot(
    snapshot: SettingsViewSnapshot,
  ): Promise<void> {
    await dispatchStateSettingSnapshot(snapshot, {
      'agent-skills': () =>
        this.withActiveWebview((w) => this.sendAgentSkillsSettings(w)),
      approval: () =>
        this.withActiveWebview((w) => this.sendApprovalSettings(w)),
      'git-author': () => {
        const settings = applyGitAuthorConfig();
        return this.withActiveWebview((w) =>
          this.sendGitAuthorSettings(w, settings),
        );
      },
      latex: () =>
        this.withActiveWebview((w) =>
          this.latexHandlers.sendLatexConfigValues(w),
        ),
      'multi-agent': () =>
        this.withActiveWebview((w) =>
          this.sendReliabilityAndOrchestrationSettings(w),
        ),
      telemetry: () =>
        this.withActiveWebview((w) => this.sendTelemetrySettings(w)),
    });
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
      const resolvedPath = resolveMemoryStoragePath();
      await StorageFS.ensureDir(resolvedPath);
      const absolutePath = StorageFS.fullPath(resolvedPath);
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
      await this.settingsHost.deleteMemory(data, (message) =>
        this.postMessageToActiveWebview(message),
      );
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
    await this.settingsHost.setMemoryEnabled(data.enabled, (message) =>
      this.postMessageToActiveWebview(message),
    );
  }

  private async setMemoryPinned(
    storagePath: string,
    pinned: boolean,
  ): Promise<void> {
    try {
      await this.settingsHost.setMemoryPinned(storagePath, pinned, (message) =>
        this.postMessageToActiveWebview(message),
      );
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
    if (update.kind === 'rejected') {
      await this.withActiveWebview((w) => this.sendProfileData(w));
      void showLoggedInfoMessage(
        this.channel,
        'Included access is unavailable because this month’s quota is exhausted.',
      );
      return;
    }
    await this.withActiveWebview((w) =>
      this.sendProfileAndModelSelectionData(w),
    );
    const modeLabel =
      update.mode === 'included' ? INCLUDED_ACCESS.inline : OWN_API_KEYS.inline;
    const suffix = update.openRouterDisabled
      ? ' OpenRouter has been turned off, because OpenRouter models always use your own OpenRouter key.'
      : '';
    void vscode.window.showInformationMessage(
      `Now using ${modeLabel}.${suffix}`,
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
  private async refreshAfterKeyChange(provider: string): Promise<void> {
    // Invalidate caches so downstream refreshes see fresh key state.
    invalidateModelOptionsCache();
    invalidateApiKeyCache();
    let usageProvider: 'kimiCode' | 'glmCodingPlan' | undefined;
    if (provider === 'kimiCode') usageProvider = 'kimiCode';
    if (provider === 'glm') usageProvider = 'glmCodingPlan';
    if (usageProvider) this.subscriptionUsage.invalidate(usageProvider);
    await safeExecuteCommand('texra.refreshApiKeyStatus', [], this.viewName);
    await Promise.all([
      safeExecuteCommand('texra.refreshAllOptions', [], this.viewName),
      this.withActiveWebview((w) => this.sendProfileAndModelSelectionData(w)),
      ...(usageProvider
        ? [
            this.withActiveWebview((w) =>
              sendSubscriptionUsage(w, this.subscriptionUsage),
            ),
          ]
        : []),
    ]);
  }

  /** Subscription auth is a setup credential: same host refresh as API-key changes. */
  private async refreshAfterSubscriptionAuthChange(
    usageProvider?: 'chatgpt',
  ): Promise<void> {
    invalidateModelOptionsCache();
    if (usageProvider) this.subscriptionUsage.invalidate(usageProvider);
    await Promise.all([
      safeExecuteCommand('texra.refreshApiKeyStatus', [], this.viewName),
      safeExecuteCommand('texra.refreshAllOptions', [], this.viewName),
      this.withActiveWebview((w) => this.sendModelSelectionData(w)),
      ...(usageProvider
        ? [
            this.withActiveWebview((w) =>
              sendSubscriptionUsage(w, this.subscriptionUsage),
            ),
          ]
        : []),
    ]);
  }

  private async handleRequestModelAccess(modelName: string): Promise<void> {
    try {
      const result = await requestRuntimeModelAccess(modelName);
      if (result === 'unavailable') {
        await showLoggedInfoMessage(
          this.channel,
          'This Copilot model is no longer available in VS Code. Refresh the model list and choose another model.',
        );
      } else {
        // Granting access is the user's explicit choice of the Copilot route
        // for this model; persist it so the canonical model row routes
        // through Copilot from here on (#9635).
        await setCopilotRoutePreference(modelName, true);
      }
    } catch (error) {
      if (
        error instanceof LanguageModelPortError &&
        error.code === LANGUAGE_MODEL_PORT_ERROR_CODE.NO_PERMISSIONS
      ) {
        await showLoggedInfoMessage(
          this.channel,
          'Copilot access was not granted. TeXRA will leave these models disabled.',
        );
      } else {
        await showLoggedErrorMessage(
          this.channel,
          'Could not request Copilot model access',
          error,
        );
      }
    } finally {
      invalidateRuntimeModelRegistry();
      invalidateModelOptionsCache();
      await Promise.all([
        safeExecuteCommand('texra.refreshAllOptions', [], this.viewName),
        this.withActiveWebview((webview) =>
          this.sendModelSelectionData(webview),
        ),
      ]);
    }
  }

  /** Clear the per-model Copilot route preference (#9659), returning the
   * canonical model to direct-provider routing. */
  private async handleClearCopilotRoute(modelName: string): Promise<void> {
    await setCopilotRoutePreference(modelName, false);
    invalidateModelOptionsCache();
    await Promise.all([
      safeExecuteCommand('texra.refreshAllOptions', [], this.viewName),
      this.withActiveWebview((webview) => this.sendModelSelectionData(webview)),
    ]);
  }

  /** Refresh settings-view agent list and main-view dropdown after agent mutations. */
  private async refreshAfterAgentMutation(
    selectedToolUseAgent?: string,
    agentCatalogAlreadyFresh = false,
  ): Promise<void> {
    await Promise.all([
      this.withActiveWebview((w) =>
        this.agentHandlers.sendAgentSelectionData(w),
      ),
      safeExecuteCommand(
        'texra.refreshAllOptions',
        selectedToolUseAgent || agentCatalogAlreadyFresh
          ? [{ selectedToolUseAgent, agentCatalogAlreadyFresh }]
          : [],
        this.viewName,
      ),
    ]);
  }

  private async handleSetProviderSetting(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_PROVIDER_SETTING>,
  ): Promise<void> {
    const result = await this.profileController.setProviderSetting(data);
    if (result.kind === 'rejected') {
      this.logger.warn(
        this.channel,
        `Rejected unknown provider setting key: ${result.key}`,
      );
      return;
    }

    const glmRegionChanged = data.key === GlobalStateKey.GLM_USE_CHINA;
    if (glmRegionChanged) this.subscriptionUsage.invalidate('glmCodingPlan');
    await this.withActiveWebview(async (w) => {
      await Promise.all([
        this.sendProfileData(w),
        this.sendReliabilityAndOrchestrationSettings(w),
        result.affectsModelAvailability
          ? this.sendModelSelectionData(w)
          : Promise.resolve(),
        glmRegionChanged
          ? sendSubscriptionUsage(w, this.subscriptionUsage)
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

  private async sendToolDashboardData(
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

  private async postMessageToActiveWebview(message: unknown): Promise<void> {
    if (message == null) return;
    await this.withActiveWebview(async (webview) => {
      await webview.postMessage(message);
    });
  }

  private async setModelEnabled(
    modelName: string,
    enabled: boolean,
  ): Promise<void> {
    await this.settingsHost.setModelEnabled(
      { modelName, enabled },
      {
        afterUpdate: () => invalidateModelOptionsCache(),
        respond: (message) => this.postMessageToActiveWebview(message),
        afterPost: () =>
          safeExecuteCommand('texra.refreshAllOptions', [], this.viewName),
      },
    );
  }
}
