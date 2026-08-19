/**
 * Schema-driven message handler for every SettingsView tab.
 *
 * This class owns the inbound registry, the memory/profile/model/tool commands,
 * and the refresh fan-out after a mutation. Tab-shaped groups are delegated to
 * focused handler classes in `./handlers/`: `AgentHandlers`,
 * `LatexSettingsHandlers`, `MemoryHandlers`,
 * `GitHubSubscriptionHandlers`, and `SubscriptionHandlers` (one instance per
 * subscription provider).
 */
import * as vscode from 'vscode';

// Shared schemas and dispatchers
import { defaultSession } from '@agent/runtime';
import { AUTH_COMMANDS } from '@auth/constants';
import { globalSM, workspaceSM } from '@common/state';
import { BaseViewMessageHandler } from '@common/webview';
import { SettingsViewHost } from '@controllers/settingsView/SettingsViewHost';
import { getChatGptAuthStatus } from '@controllers/modelAccess/chatGptAuthStatus';
import { getGrokAuthStatus } from '@controllers/modelAccess/grokAuthStatus';
import { SubscriptionUsageService } from '@controllers/modelAccess/subscriptionUsage/SubscriptionUsageService';
import {
  buildToolDashboardItems,
  planToolTerminalAction,
} from '@controllers/settingsView/ToolDashboardData';
import { SettingsProfileKeyController } from '@controllers/settingsView/SettingsProfileKeyController';
import { SettingsProfileController } from '@controllers/settingsView/SettingsProfileController';
import { appSignals } from '@eventBus/AppSignals';
import { SecretManager } from '@frontend/secretManager';
import {
  getMainWebview,
  safeExecuteCommand,
} from '@frontend/system/commandUtils';
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
import { revealProgressStream } from '@progressView/progressNavigation';
import { MAIN_VIEW_COMMANDS, SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  codingPlanForApiProvider,
  codingPlanForUsageSetting,
} from '@shared/codingPlanSubscriptions';
import type {
  DerivedSettingsSnapshot,
  SettingsMessageFor,
  SettingsViewInboundHandlerRegistry,
  SettingsViewSnapshot,
  SubscriptionUsageProvider,
} from '@shared/schemas';
import {
  dispatchSettingsViewInbound,
  SETTINGS_VIEW_CMD,
} from '@shared/schemas';
import { buildAuthStatusMessage } from '@shared/settingsView/handlers/authStatusMessage';

import {
  applyStateSettingUpdate,
  postStateSettingSnapshot as dispatchStateSettingSnapshot,
} from '@shared/settingsView/handlers/stateSettingWrite';

import { unsupportedCommands } from '@shared/utils/dispatcher';
import { buildSettingsSnapshotMessage } from '@shared/settingsView/handlers/settingsSnapshot';
import type { SettingsStores } from '@shared/config/settingsAccess';
import {
  getLastCheckResults,
  refreshToolAvailability,
} from '@tools/toolAvailability';
import { GoalStore, subscribeGoalStateChanges } from '@tools/goal';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { getConfig, updateConfig } from '@utils/config/configUtils';
import { setToolEnabled } from '@utils/config/constants';
import { AgentHandlers } from './handlers/agentHandlers';
import { LatexSettingsHandlers } from './handlers/latexSettingsHandlers';
import { MemoryHandlers } from './handlers/memoryHandlers';
import { GitHubSubscriptionHandlers } from './handlers/githubSubscriptionHandlers';
import { SubscriptionHandlers } from './handlers/subscriptionHandlers';
import {
  sendSubscriptionUsage,
  type SubscriptionUsageReader,
} from './handlers/subscriptionUsageHandlers';
import type { SettingsHandlerContext } from './handlers/SettingsHandlerContext';

export class SettingsViewMessageHandler extends BaseViewMessageHandler<
  vscode.WebviewView | vscode.WebviewPanel
> {
  private readonly handlerRegistry: SettingsViewInboundHandlerRegistry;

  // Domain-specific handler delegates
  private readonly agentHandlers: AgentHandlers;
  private readonly latexHandlers: LatexSettingsHandlers;
  private readonly memoryHandlers: MemoryHandlers;
  private readonly githubHandlers: GitHubSubscriptionHandlers;
  private readonly chatgptHandlers: SubscriptionHandlers;
  private readonly grokHandlers: SubscriptionHandlers;
  private readonly settingsHost: SettingsViewHost;
  private readonly profileController: SettingsProfileController;
  private readonly profileKeyController: SettingsProfileKeyController;
  private readonly subscriptionUsage: SubscriptionUsageReader;
  public readonly signInChatGpt: () => Promise<void>;

  constructor(context: vscode.ExtensionContext) {
    super('SettingsView');

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
    });
    this.profileController = new SettingsProfileController({
      host: 'vscode',
      globalState: globalSM,
      loadProviderKeyStatuses: () =>
        loadApiKeyStatusMap(platform().secrets, SecretManager.API_PROVIDERS),
      getConfig,
      updateConfig: (key, value) =>
        updateConfig(key, value, { target: 'global', prefix: false }),
    });
    this.subscriptionUsage = new SubscriptionUsageService();
    this.profileKeyController = new SettingsProfileKeyController({
      prompt: new VscodePromptHost(),
      externalOpener: new VscodeExternalOpener(),
      getProviderDisplayName: (provider) =>
        this.profileController.getProviderDisplayName(provider),
      getProviderKeyUrl: (provider) =>
        this.profileController.getProviderKeyUrl(provider),
      refreshAfterKeyChange: (provider) =>
        this.refreshAfterProviderKeyChange(provider),
      reportFailure: async (message, error) => {
        await showLoggedErrorMessage(this.channel, message, error);
        // On error, still refresh settings view to reflect current key state.
        await this.withActiveWebview((w) =>
          this.sendProfileAndModelSelectionData(w),
        );
      },
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
    this.memoryHandlers = new MemoryHandlers(
      ctx,
      this.settingsHost,
      this.viewName,
    );
    this.githubHandlers = new GitHubSubscriptionHandlers(ctx);
    this.chatgptHandlers = new SubscriptionHandlers(
      'chatgpt',
      () =>
        buildAuthStatusMessage(
          SETTINGS_VIEW_COMMANDS.UPDATE_CHATGPT_AUTH_STATUS,
          getChatGptAuthStatus,
        ),
      ctx,
      () => this.refreshAfterSubscriptionAuthChange('chatgpt'),
    );
    this.signInChatGpt = this.chatgptHandlers.handleSignIn;
    this.grokHandlers = new SubscriptionHandlers(
      'grok',
      () =>
        buildAuthStatusMessage(
          SETTINGS_VIEW_COMMANDS.UPDATE_GROK_AUTH_STATUS,
          getGrokAuthStatus,
        ),
      ctx,
      () => this.refreshAfterSubscriptionAuthChange(),
    );
    this.handlerRegistry = this.createHandlerRegistry();

    context.subscriptions.push(
      {
        dispose: appSignals.on('githubSubscriptionsChanged', () => {
          void this.withActiveWebview((w) =>
            this.githubHandlers.sendPRSubscriptions(w),
          );
        }),
      },
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
  }

  private createHandlerRegistry(): SettingsViewInboundHandlerRegistry {
    return {
      webviewReady: () => this.withActiveWebview((w) => this.sendAllData(w)),
      getMemoryData: () =>
        this.withActiveWebview((w) => this.memoryHandlers.sendMemoryData(w)),
      getMemoryPreview: (message) =>
        this.memoryHandlers.handleGetMemoryPreview(message),
      openMemoryFile: (message) =>
        this.memoryHandlers.handleOpenMemoryFile(message),
      openMemoryFolder: () => this.memoryHandlers.handleOpenMemoryFolder(),
      deleteMemory: (message) =>
        this.memoryHandlers.handleDeleteMemory(message),
      setMemoryEnabled: (message) =>
        this.memoryHandlers.handleSetMemoryEnabled(message),
      pinMemory: (message) =>
        this.memoryHandlers.setMemoryPinned(message.storagePath, true),
      unpinMemory: (message) =>
        this.memoryHandlers.setMemoryPinned(message.storagePath, false),
      signIn: () =>
        safeExecuteCommand(AUTH_COMMANDS.SIGN_IN, [], this.viewName),
      signOut: () =>
        safeExecuteCommand(AUTH_COMMANDS.SIGN_OUT, [], this.viewName),
      setProviderKey: (message) =>
        this.profileKeyController.setProviderKey(message.provider),
      removeProviderKey: (message) =>
        this.profileKeyController.removeProviderKey(message.provider),
      openProviderKeyUrl: (message) =>
        this.profileKeyController.openProviderKeyUrl(message.provider),
      setProviderSetting: (message) => this.handleSetProviderSetting(message),
      openExternalUrl: (message) => this.openExternalUrl(message.url),
      setModelEnabled: (message) =>
        this.setModelEnabled(message.modelName, message.enabled),
      setModelReasoningLevel: (message) =>
        this.settingsHost.setReasoningLevel(
          { modelName: message.modelName, level: message.level },
          {
            respond: (response) => this.postMessageToActiveWebview(response),
          },
        ),
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
      signInChatGpt: this.signInChatGpt,
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
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.RUN_TOOL_COMMAND>,
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

    // Auth/session changes affect model availability and must not reuse a
    // pre-login/pre-logout availability snapshot.
    invalidateModelOptionsCache();
    await this.sendProfileAndModelSelectionData(webview);

    await Promise.all([
      this.memoryHandlers.sendMemoryData(webview),
      this.memoryHandlers.sendMemoryEnabled(webview),
      this.agentHandlers.sendAgentSelectionData(webview),
      this.agentHandlers.sendCustomAgentDir(webview),
      this.sendSettingsSnapshot(webview, 'multi-agent'),
      this.agentHandlers.sendAgentModePresets(webview),
      this.sendSettingsSnapshot(webview, 'git-author'),
      this.githubHandlers.sendGitHubTokenStatus(webview),
      this.chatgptHandlers.sendAuthStatus(webview),
      this.grokHandlers.sendAuthStatus(webview),
      this.githubHandlers.sendPRSubscriptions(webview),
      this.sendSettingsSnapshot(webview, 'approval'),
      this.sendSettingsSnapshot(webview, 'agent-skills'),
      this.sendSettingsSnapshot(webview, 'telemetry'),
      this.latexHandlers.sendLatexSettingsStatus(webview),
      this.latexHandlers.sendLatexConfigValues(webview),
      this.sendInlineCriticismEnabled(webview),
      this.sendGoalList(webview),
    ]);
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
  // Catalog-derived settings snapshots
  // ============================================================

  private settingsStores(): SettingsStores {
    return {
      config: platform().config,
      workspaceState: workspaceSM,
      globalState: globalSM,
    };
  }

  /**
   * Post one catalog-derived snapshot. Every field comes from the settings
   * catalog, so the only per-snapshot code left is the multi-agent arm's
   * host-specific reliability tuning, which has no catalog row.
   */
  private async sendSettingsSnapshot(
    webview: vscode.Webview,
    snapshot: DerivedSettingsSnapshot,
  ): Promise<void> {
    const message = buildSettingsSnapshotMessage(
      snapshot,
      this.settingsStores(),
      'vscode',
    );
    await webview.postMessage(
      snapshot === 'multi-agent'
        ? {
            ...message,
            reliabilitySettings:
              this.profileController.getReliabilitySettings(),
          }
        : message,
    );
  }

  private rebroadcastSnapshot(
    snapshot: DerivedSettingsSnapshot,
  ): Promise<void> {
    return this.withActiveWebview((w) =>
      this.sendSettingsSnapshot(w, snapshot),
    );
  }

  /**
   * Generic write path for catalog-backed settings-view rows.
   */
  private async updateStateSetting(key: string, value: unknown): Promise<void> {
    const result = await applyStateSettingUpdate(key, value, {
      host: 'vscode',
      stores: this.settingsStores(),
      // The shared function already gates this hook on
      // `configTarget !== 'global'`; this checks only the workspace half.
      requiresOpenWorkspace: () => !WorkspaceFS.getPath(),
      onApprovalPolicyChanged: (policy) => {
        defaultSession().setApprovalPolicy(policy);
        appSignals.emit('approvalPolicyChanged', undefined);
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
    await this.postStateSettingSnapshot(result.entry.surfaces.settingsView);
    if (result.kind !== 'applied') return;
    if (result.entry.onWrite?.invalidatesModelOptions) {
      invalidateModelOptionsCache();
      await this.withActiveWebview((w) => this.sendModelSelectionData(w));
      await safeExecuteCommand('texra.refreshAllOptions', [], this.viewName);
    }
    if (codingPlanForUsageSetting(key) !== undefined) {
      await this.withActiveWebview((w) =>
        sendSubscriptionUsage(w, this.subscriptionUsage),
      );
    }
  }

  private async postStateSettingSnapshot(
    snapshot: SettingsViewSnapshot,
  ): Promise<void> {
    await dispatchStateSettingSnapshot(snapshot, {
      'agent-skills': () => this.rebroadcastSnapshot('agent-skills'),
      approval: () => this.rebroadcastSnapshot('approval'),
      'git-author': () => {
        // Git identity is also process env, so the write must reach `git`
        // before the webview is told the new value stuck.
        applyGitAuthorConfig();
        return this.rebroadcastSnapshot('git-author');
      },
      latex: () =>
        this.withActiveWebview((w) =>
          this.latexHandlers.sendLatexConfigValues(w),
        ),
      models: () =>
        this.withActiveWebview((w) => this.sendModelSelectionData(w)),
      'multi-agent': () => this.rebroadcastSnapshot('multi-agent'),
      profile: () => this.withActiveWebview((w) => this.sendProfileData(w)),
      telemetry: () => this.rebroadcastSnapshot('telemetry'),
    });
  }

  // ============================================================
  // Profile handler implementations
  // ============================================================

  /**
   * The shared refresh tail for a credential change (API key or subscription
   * auth): invalidate caches, re-run the host refresh commands, and push
   * fresh profile/model/usage data to the active webview. Model selection
   * availability depends on key state, so the key status command is awaited
   * before any model/profile data is sent. `refreshProfileData` selects which
   * profile surface to push (profile+model for key changes, model-only for
   * subscription changes).
   */
  private async refreshCredentialDependentSurfaces(options: {
    usageProvider?: SubscriptionUsageProvider;
    refreshProfileData: (webview: vscode.Webview) => Promise<void>;
  }): Promise<void> {
    // Invalidate caches so downstream refreshes see fresh credential state.
    invalidateModelOptionsCache();
    if (options.usageProvider) {
      this.subscriptionUsage.invalidate(options.usageProvider);
    }
    await safeExecuteCommand('texra.refreshApiKeyStatus', [], this.viewName);
    await Promise.all([
      safeExecuteCommand('texra.refreshAllOptions', [], this.viewName),
      this.withActiveWebview((w) => options.refreshProfileData(w)),
      ...(options.usageProvider
        ? [
            this.withActiveWebview((w) =>
              sendSubscriptionUsage(w, this.subscriptionUsage),
            ),
          ]
        : []),
    ]);
  }

  /**
   * Refresh main view API key status, model options, and settings-view model/profile
   * data after key changes. Model selection availability depends on provider
   * key state, so keep it paired with the profile refresh.
   */
  public async refreshAfterProviderKeyChange(provider: string): Promise<void> {
    invalidateApiKeyCache();
    const usageProvider = codingPlanForApiProvider(provider)?.usageProvider;
    const mainView = await getMainWebview(this.viewName);
    if (mainView) {
      const anyKeyExists = await SecretManager.anyApiKeyExists();
      mainView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_BANNER,
        banner: 'apiKey',
        visible: !anyKeyExists,
      });
    }
    await this.refreshCredentialDependentSurfaces({
      usageProvider,
      refreshProfileData: (webview) =>
        this.sendProfileAndModelSelectionData(webview),
    });
  }

  /** Subscription auth is a setup credential: same host refresh as API-key changes. */
  private async refreshAfterSubscriptionAuthChange(
    usageProvider?: 'chatgpt',
  ): Promise<void> {
    await this.refreshCredentialDependentSurfaces({
      usageProvider,
      refreshProfileData: (webview) => this.sendModelSelectionData(webview),
    });
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
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.SET_PROVIDER_SETTING>,
  ): Promise<void> {
    const result = await this.profileController.setProviderSetting(data);
    if (result.kind === 'rejected') {
      this.logger.warn(
        this.channel,
        `Rejected unknown provider setting key: ${result.key}`,
      );
      return;
    }

    await this.withActiveWebview(async (w) => {
      await Promise.all([
        this.sendProfileData(w),
        this.sendSettingsSnapshot(w, 'multi-agent'),
      ]);
    });
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
    const items = await buildToolDashboardItems('extension', cachedResults);
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
