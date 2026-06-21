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
import { platform } from '@platform/platform';
import { createSettingsMemoryController } from '@controllers/settingsView/SettingsMemoryControllerFactory';
import {
  buildModelSelectionMessage,
  createModelSelectionController,
} from '@controllers/settingsView/SettingsModelSelectionControllerFactory';
import { AUTH_COMMANDS } from '@auth/constants';
import { getServerSideKeyService } from '@auth/serverKeys';
import { BaseViewMessageHandler } from '@common/webview';
import { WorkspaceStateKey, globalSM, workspaceSM } from '@common/state';
import { bus } from '@eventBus/ProgressEventBus';
import { SecretManager, type ApiProvider } from '@frontend/secretManager';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { selectAgentInMainView } from '@frontend/agents/remoteAgentUtils';
import {
  applyGitAuthorConfig,
  readGitAuthorSettings,
} from '@frontend/git/gitAuthorSetup';
import { VscodeExternalOpener } from '@frontend/hosts/VscodeExternalOpener';
import { VscodePromptHost } from '@frontend/hosts/VscodePromptHost';
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
import type { StreamTabId } from '@shared/schemas';
import {
  dispatchSettingsViewInbound,
  type SettingsViewInboundHandlerRegistry,
  type SettingsViewInboundMessage,
  type SettingsMessageFor,
  SETTINGS_VIEW_CMD,
} from '@shared/schemas/settingsViewMessages';
import {
  buildApprovalSettingsMessage,
  setBashApprovalEnabled as setBashApprovalEnabledShared,
  setWorkspaceAgentSetting,
} from '@shared/settingsView/handlers/approvalHandlers';
import {
  buildSuperYoloMessage,
  setNestedDelegationMaxDepth,
} from '@shared/settingsView/handlers/superYoloHandlers';
import {
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_URLS,
  PROVIDER_VSCODE_SETTINGS,
} from '@shared/constants/providers';
import { GoalStore } from '@tools/goal';
import {
  getLastCheckResults,
  refreshToolAvailability,
  refreshDisabledToolCache,
} from '@tools/toolAvailability';
import { MEMORY_STORAGE_ROOT } from '@tools/memory/constants';
import { resolveMemoryStoragePath } from '@tools/memory/memoryUtils';
import { StorageFS } from '@utils/files';
import { hasExtension } from '@utils/core/pathCore';
import { readGitAuthorSettingsFromState } from '@utils/system/gitAuthorSettings';
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
    this.agentHandlers = new AgentHandlers(ctx, () =>
      this.refreshAfterAgentMutation(),
    );
    this.latexHandlers = new LatexSettingsHandlers(ctx);
    this.historyHandlers = new HistoryHandlers(ctx);
    this.githubHandlers = new GitHubSubscriptionHandlers(ctx);
    this.chatgptHandlers = new ChatGptSubscriptionHandlers(ctx);
    this.goalController = new SettingsGoalController({
      listGoals: () => GoalStore.list(),
    });

    this.handlerRegistry = this.createHandlerRegistry();

    // Lifetime == extension; bus is process-global so no dispose needed.
    const refreshSubscriptions = () =>
      void this.withActiveWebview((w) =>
        this.githubHandlers.sendPRSubscriptions(w),
      );
    bus.on('prSubscriptionsChanged', refreshSubscriptions);
    bus.on('prSubscriptionBindingsChanged', refreshSubscriptions);
    bus.on('repoSubscriptionsChanged', refreshSubscriptions);
    bus.on('repoSubscriptionBindingsChanged', refreshSubscriptions);
    bus.on('issueSubscriptionsChanged', refreshSubscriptions);
    bus.on('issueSubscriptionBindingsChanged', refreshSubscriptions);
    bus.on('toolAvailabilityChanged', () => {
      void this.withActiveWebview((w) =>
        this.sendToolDashboardData(w, { skipChecks: true }),
      );
    });
    bus.on('goalStateChanged', () => {
      void this.withActiveWebview((w) => this.sendGoalList(w));
    });
  }

  private createHandlerRegistry(): SettingsViewInboundHandlerRegistry {
    return {
      // Lifecycle: webview signals it's mounted; populate every tab's
      // initial data via the single `sendAllData` source of truth.
      [SETTINGS_VIEW_COMMANDS.WEBVIEW_READY]: () =>
        this.withActiveWebview((w) => this.sendAllData(w)),

      // Navigation handlers
      [SETTINGS_VIEW_COMMANDS.OPEN_VSCODE_SETTINGS]: () =>
        this.handleOpenVscodeSettings(),

      // Memory handlers
      [SETTINGS_VIEW_COMMANDS.GET_MEMORY_DATA]: () =>
        this.withActiveWebview((w) => this.sendMemoryData(w)),
      [SETTINGS_VIEW_COMMANDS.GET_MEMORY_PREVIEW]: (data) =>
        this.handleGetMemoryPreview(data),
      [SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FILE]: (data) =>
        this.handleOpenMemoryFile(data),
      [SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FOLDER]: () =>
        this.handleOpenMemoryFolder(),
      [SETTINGS_VIEW_COMMANDS.DELETE_MEMORY]: (data) =>
        this.handleDeleteMemory(data),
      [SETTINGS_VIEW_COMMANDS.GET_MEMORY_ENABLED]: () =>
        this.withActiveWebview((w) => this.sendMemoryEnabled(w)),
      [SETTINGS_VIEW_COMMANDS.SET_MEMORY_ENABLED]: (data) =>
        this.handleSetMemoryEnabled(data),
      [SETTINGS_VIEW_COMMANDS.PIN_MEMORY]: (data) =>
        this.setMemoryPinned(data.storagePath, true),
      [SETTINGS_VIEW_COMMANDS.UNPIN_MEMORY]: (data) =>
        this.setMemoryPinned(data.storagePath, false),

      // History handlers
      [SETTINGS_VIEW_COMMANDS.GET_HISTORY_DATA]: () =>
        this.withActiveWebview((w) => this.historyHandlers.sendHistoryData(w)),
      [SETTINGS_VIEW_COMMANDS.RERUN_AGENT]: (data) =>
        this.historyHandlers.handleRerunAgent(data),
      [SETTINGS_VIEW_COMMANDS.RESTORE_AGENT]: (data) =>
        this.historyHandlers.handleRestoreAgent(data),
      [SETTINGS_VIEW_COMMANDS.DELETE_AGENT]: (data) =>
        this.historyHandlers.handleDeleteAgent(data),
      [SETTINGS_VIEW_COMMANDS.CLEAR_HISTORY]: () =>
        this.historyHandlers.handleClearHistory(),
      [SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_MD]: (data) =>
        this.historyHandlers.handleExportChat(data, 'md'),
      [SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_TEX]: (data) =>
        this.historyHandlers.handleExportChat(data, 'tex'),
      [SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_HTML]: (data) =>
        this.historyHandlers.handleExportChat(data, 'html'),

      // Profile handlers
      [SETTINGS_VIEW_COMMANDS.GET_PROFILE_DATA]: () =>
        this.withActiveWebview((w) => this.sendProfileData(w)),
      [SETTINGS_VIEW_COMMANDS.SELECT_AGENT]: (data) =>
        this.handleSelectAgent(data),
      [SETTINGS_VIEW_COMMANDS.SIGN_IN]: async () =>
        vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_IN),
      [SETTINGS_VIEW_COMMANDS.SIGN_OUT]: async () =>
        vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_OUT),
      [SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE]: (data) =>
        this.handleSetApiAccessMode(data),
      [SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY]: (data) =>
        this.handleSetProviderKey(data),
      [SETTINGS_VIEW_COMMANDS.REMOVE_PROVIDER_KEY]: (data) =>
        this.handleRemoveProviderKey(data),
      [SETTINGS_VIEW_COMMANDS.OPEN_PROVIDER_KEY_URL]: (data) =>
        this.handleOpenProviderKeyUrl(data),
      [SETTINGS_VIEW_COMMANDS.SET_PROVIDER_STREAMING]: (data) =>
        this.handleSetProviderStreaming(data),
      [SETTINGS_VIEW_COMMANDS.SET_PROVIDER_ENDPOINT]: (data) =>
        this.handleSetProviderEndpoint(data),
      [SETTINGS_VIEW_COMMANDS.SET_GLOBAL_STREAMING]: (data) =>
        this.handleSetGlobalStreaming(data),
      [SETTINGS_VIEW_COMMANDS.SET_PROVIDER_VSCODE_SETTING]: (data) =>
        this.handleSetProviderVscodeSetting(data),
      [SETTINGS_VIEW_COMMANDS.OPEN_EXTERNAL_URL]: async (data) => {
        await vscode.env.openExternal(vscode.Uri.parse(data.url));
      },

      // Model selection handlers
      [SETTINGS_VIEW_COMMANDS.GET_MODEL_SELECTION]: () =>
        this.withActiveWebview((w) => this.sendModelSelectionData(w)),
      [SETTINGS_VIEW_COMMANDS.SET_MODEL_ENABLED]: (data) =>
        this.handleSetModelEnabled(data),
      [SETTINGS_VIEW_COMMANDS.SET_HELPER_MODEL]: (data) =>
        this.handleSetHelperModel(data),
      [SETTINGS_VIEW_COMMANDS.SET_MODEL_REASONING_LEVEL]: (data) =>
        this.handleSetModelReasoningLevel(data),
      [SETTINGS_VIEW_COMMANDS.SET_PREFER_SHORT_MODEL_NAMES]: (data) =>
        this.handleSetPreferShortModelNames(data),

      // Multi-agent coordination handlers
      [SETTINGS_VIEW_COMMANDS.GET_SUPER_YOLO_ENABLED]: () =>
        this.withActiveWebview((w) => this.sendSuperYoloEnabled(w)),
      [SETTINGS_VIEW_COMMANDS.SET_SUPER_YOLO_ENABLED]: () =>
        this.withActiveWebview((w) => this.sendSuperYoloEnabled(w)),
      [SETTINGS_VIEW_COMMANDS.SET_ALLOW_ORCHESTRATOR_KILL]: (data) =>
        this.updateBooleanAndSendSuperYolo(
          WorkspaceStateKey.ALLOW_ORCHESTRATOR_KILL,
          data,
        ),
      [SETTINGS_VIEW_COMMANDS.SET_DETACH_SUBAGENTS_ON_STOP]: (data) =>
        this.updateBooleanAndSendSuperYolo(
          WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
          data,
        ),
      [SETTINGS_VIEW_COMMANDS.SET_NESTED_DELEGATION_MAX_DEPTH]: (data) =>
        this.handleSetNestedDelegationMaxDepth(data),

      // ── Delegated to AgentHandlers ──

      [SETTINGS_VIEW_COMMANDS.GET_AGENT_SELECTION]: () =>
        this.withActiveWebview((w) =>
          this.agentHandlers.sendAgentSelectionData(w),
        ),
      [SETTINGS_VIEW_COMMANDS.OPEN_AGENT_YAML]: (data) =>
        this.agentHandlers.handleOpenAgentYaml(data),
      [SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED]: (data) =>
        this.agentHandlers.handleSetAgentEnabled(data),
      [SETTINGS_VIEW_COMMANDS.SET_ALL_AGENTS_ENABLED]: (data) =>
        this.agentHandlers.handleSetAllAgentsEnabled(data),
      [SETTINGS_VIEW_COMMANDS.OPEN_AGENT_FOLDER]: (data) =>
        this.agentHandlers.handleOpenAgentFolder(data),
      [SETTINGS_VIEW_COMMANDS.CREATE_AGENT]: (data) =>
        this.agentHandlers.handleCreateAgent(data),
      [SETTINGS_VIEW_COMMANDS.CUSTOMIZE_AGENT]: (data) =>
        this.agentHandlers.handleCustomizeAgent(data),
      [SETTINGS_VIEW_COMMANDS.DELETE_CUSTOM_AGENT]: (data) =>
        this.agentHandlers.handleDeleteCustomAgent(data),
      [SETTINGS_VIEW_COMMANDS.REVEAL_AGENT_FILE]: (data) =>
        this.agentHandlers.handleRevealAgentFile(data),
      [SETTINGS_VIEW_COMMANDS.VIEW_REMOTE_AGENT_PROMPT]: (data) =>
        this.agentHandlers.handleViewRemoteAgentPrompt(data),

      // Custom agent directory
      [SETTINGS_VIEW_COMMANDS.GET_CUSTOM_AGENT_DIR]: () =>
        this.withActiveWebview((w) => this.agentHandlers.sendCustomAgentDir(w)),
      [SETTINGS_VIEW_COMMANDS.SET_CUSTOM_AGENT_DIR]: () =>
        this.agentHandlers.handleSetCustomAgentDir(),
      [SETTINGS_VIEW_COMMANDS.RESET_CUSTOM_AGENT_DIR]: () =>
        this.agentHandlers.handleResetCustomAgentDir(),

      // Agent teams
      [SETTINGS_VIEW_COMMANDS.GET_AGENT_MODE_PRESETS]: () =>
        this.withActiveWebview((w) =>
          this.agentHandlers.sendAgentModePresets(w),
        ),
      [SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET]: (data) =>
        this.agentHandlers.handleApplyAgentModePreset(data),
      [SETTINGS_VIEW_COMMANDS.SAVE_AGENT_MODE_PRESET]: (data) =>
        this.agentHandlers.handleSaveAgentModePreset(data),
      [SETTINGS_VIEW_COMMANDS.DELETE_AGENT_MODE_PRESET]: (data) =>
        this.agentHandlers.handleDeleteAgentModePreset(data),

      // Git author settings handlers
      [SETTINGS_VIEW_COMMANDS.GET_GIT_AUTHOR_SETTINGS]: () =>
        this.withActiveWebview((w) => this.sendGitAuthorSettings(w)),
      [SETTINGS_VIEW_COMMANDS.SET_GIT_MARK_COMMITS]: (data) =>
        this.updateGitAuthorSetting(
          WorkspaceStateKey.GIT_MARK_COMMITS,
          data.enabled,
        ),
      [SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_NAME]: (data) =>
        this.updateGitAuthorSetting(
          WorkspaceStateKey.GIT_AUTHOR_NAME,
          data.name,
        ),
      [SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_EMAIL]: (data) =>
        this.updateGitAuthorSetting(
          WorkspaceStateKey.GIT_AUTHOR_EMAIL,
          data.email,
        ),
      [SETTINGS_VIEW_COMMANDS.SET_GIT_WORKTREE_SUPPORT]: (data) =>
        this.updateGitAuthorSetting(
          WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
          data.enabled,
        ),

      // GitHub token handlers
      [SETTINGS_VIEW_COMMANDS.GET_GITHUB_TOKEN_STATUS]: () =>
        this.withActiveWebview((w) =>
          this.githubHandlers.sendGitHubTokenStatus(w),
        ),
      [SETTINGS_VIEW_COMMANDS.SET_GITHUB_TOKEN]: () =>
        this.githubHandlers.handleSetGitHubToken(),
      [SETTINGS_VIEW_COMMANDS.REMOVE_GITHUB_TOKEN]: () =>
        this.githubHandlers.handleRemoveGitHubToken(),
      [SETTINGS_VIEW_COMMANDS.OPEN_GITHUB_TOKEN_URL]: () =>
        this.githubHandlers.openGitHubTokenUrl(),

      // ChatGPT subscription sign-in handlers
      [SETTINGS_VIEW_COMMANDS.GET_CHATGPT_AUTH_STATUS]: () =>
        this.withActiveWebview((w) =>
          this.chatgptHandlers.sendChatGptAuthStatus(w),
        ),
      [SETTINGS_VIEW_COMMANDS.SIGN_IN_CHATGPT]: () =>
        this.chatgptHandlers.handleSignInChatGpt(),
      [SETTINGS_VIEW_COMMANDS.SIGN_OUT_CHATGPT]: () =>
        this.chatgptHandlers.handleSignOutChatGpt(),
      [SETTINGS_VIEW_COMMANDS.GET_PR_SUBSCRIPTIONS]: () =>
        this.withActiveWebview((w) =>
          this.githubHandlers.sendPRSubscriptions(w),
        ),
      [SETTINGS_VIEW_COMMANDS.UNSUBSCRIBE_PR]: (data) =>
        this.githubHandlers.handleUnsubscribePR(data),
      [SETTINGS_VIEW_COMMANDS.OPEN_PR_SUBSCRIPTION_STREAM]: (data) =>
        this.githubHandlers.handleOpenPRSubscriptionStream(data),

      // ── Delegated to LatexSettingsHandlers ──

      [SETTINGS_VIEW_COMMANDS.GET_LATEX_SETTINGS_STATUS]: () =>
        this.withActiveWebview((w) =>
          this.latexHandlers.sendLatexSettingsStatus(w),
        ),
      [SETTINGS_VIEW_COMMANDS.APPLY_LATEX_SETTINGS]: (data) =>
        this.latexHandlers.handleApplyLatexSettings(data),
      [SETTINGS_VIEW_COMMANDS.INSTALL_LATEX_WORKSHOP]: () =>
        this.latexHandlers.handleInstallLatexWorkshop(),
      [SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND]: (data) =>
        this.latexHandlers.handleRunInstallCommand(data),
      [SETTINGS_VIEW_COMMANDS.GET_LATEX_CONFIG_VALUES]: () =>
        this.withActiveWebview((w) =>
          this.latexHandlers.sendLatexConfigValues(w),
        ),
      [SETTINGS_VIEW_COMMANDS.SET_LATEX_CONFIG_VALUE]: (data) =>
        this.latexHandlers.handleSetLatexConfigValue(data),
      [SETTINGS_VIEW_COMMANDS.GET_INLINE_CRITICISM_ENABLED]: () =>
        this.withActiveWebview((w) => this.sendInlineCriticismEnabled(w)),
      [SETTINGS_VIEW_COMMANDS.SET_INLINE_CRITICISM_ENABLED]: (data) =>
        this.handleSetInlineCriticismEnabled(data.enabled),

      // Approval settings handlers
      [SETTINGS_VIEW_COMMANDS.GET_APPROVAL_SETTINGS]: () =>
        this.withActiveWebview((w) => this.sendApprovalSettings(w)),
      [SETTINGS_VIEW_COMMANDS.SET_BASH_APPROVAL_ENABLED]: (data) =>
        this.handleSetApprovalEnabled(data.enabled),
      [SETTINGS_VIEW_COMMANDS.SET_CODEX_SANDBOX_MODE]: (data) =>
        this.updateAgentSetting(
          WorkspaceStateKey.CODEX_SANDBOX_MODE,
          data.mode,
        ),
      [SETTINGS_VIEW_COMMANDS.SET_CODEX_REASONING_EFFORT]: (data) =>
        this.updateAgentSetting(
          WorkspaceStateKey.CODEX_REASONING_EFFORT,
          data.effort,
        ),
      [SETTINGS_VIEW_COMMANDS.SET_CODEX_APPROVAL_POLICY]: (data) =>
        this.updateAgentSetting(
          WorkspaceStateKey.CODEX_APPROVAL_POLICY,
          data.policy,
        ),
      [SETTINGS_VIEW_COMMANDS.SET_CLAUDE_AGENT_MODEL]: (data) =>
        this.updateAgentSetting(
          WorkspaceStateKey.CLAUDE_AGENT_MODEL,
          data.model,
        ),
      [SETTINGS_VIEW_COMMANDS.SET_CLAUDE_AGENT_PERMISSION_MODE]: (data) =>
        this.updateAgentSetting(
          WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE,
          data.mode,
        ),
      [SETTINGS_VIEW_COMMANDS.SET_CLAUDE_AGENT_EFFORT]: (data) =>
        this.updateAgentSetting(
          WorkspaceStateKey.CLAUDE_AGENT_EFFORT,
          data.effort,
        ),

      // Tool dashboard handlers
      [SETTINGS_VIEW_COMMANDS.GET_TOOL_DASHBOARD_DATA]: () =>
        this.withActiveWebview((w) => this.sendToolDashboardData(w)),
      [SETTINGS_VIEW_COMMANDS.OPEN_TOOL_INSTALL_URL]: async (data) => {
        await vscode.env.openExternal(vscode.Uri.parse(data.url));
      },
      [SETTINGS_VIEW_COMMANDS.INSTALL_TOOL_EXTENSION]: (data) =>
        this.handleInstallToolExtension(data),
      [SETTINGS_VIEW_COMMANDS.RECHECK_TOOL_STATUS]: () =>
        refreshToolAvailability(extensionAgentRuntimeHost),
      [SETTINGS_VIEW_COMMANDS.TOGGLE_TOOL]: async (data) => {
        await setToolEnabled(data.toolId, data.enabled);
        refreshDisabledToolCache();
        // Re-render with cached check results — no network re-probe needed
        await this.withActiveWebview((w) =>
          this.sendToolDashboardData(w, { skipChecks: true }),
        );
      },
      [SETTINGS_VIEW_COMMANDS.RUN_TOOL_COMMAND]: (data) =>
        this.handleRunToolCommand(data),

      [SETTINGS_VIEW_COMMANDS.GET_GOAL_LIST]: () =>
        this.withActiveWebview((w) => this.sendGoalList(w)),
      [SETTINGS_VIEW_COMMANDS.REVEAL_GOAL_STREAM]: (data) =>
        this.handleRevealGoalStream(data.streamId),
    };
  }

  public async sendGoalList(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(this.goalController.getGoalListMessage());
  }

  private async handleRevealGoalStream(streamId: StreamTabId): Promise<void> {
    await revealProgressStream(streamId);
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
  // Helpers
  // ============================================================

  // ============================================================
  // Public methods for external access
  // ============================================================

  public async sendAllData(webview: vscode.Webview): Promise<void> {
    // Tool dashboard involves network I/O (Zotero probe, etc.) — fire async
    // so it doesn't block the initial render. The frontend shows a loading
    // spinner until data arrives.
    void this.sendToolDashboardData(webview);

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

  private async handleSetNestedDelegationMaxDepth(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_NESTED_DELEGATION_MAX_DEPTH>,
  ): Promise<void> {
    await setNestedDelegationMaxDepth(
      { workspaceState: workspaceSM, globalState: globalSM },
      data.value,
    );
    await this.withActiveWebview((w) => this.sendSuperYoloEnabled(w));
  }

  // ============================================================
  // Git author settings handler implementations
  // ============================================================

  private async sendGitAuthorSettings(
    webview: vscode.Webview,
    settings?: ReturnType<typeof readGitAuthorSettings>,
  ): Promise<void> {
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS,
      ...(settings ?? readGitAuthorSettingsFromState(workspaceSM)),
    });
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
    await setBashApprovalEnabledShared(
      {
        workspaceState: workspaceSM,
        globalState: globalSM,
        config: platform().config,
      },
      enabled,
      'global',
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

  private async handleOpenVscodeSettings(): Promise<void> {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      '@ext:texra-ai.texra',
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
        await vscode.commands.executeCommand('markdown.showPreview', fileUri);
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
      await StorageFS.ensureDir(MEMORY_STORAGE_ROOT);
      const absolutePath = StorageFS.fullPath(MEMORY_STORAGE_ROOT);
      await vscode.commands.executeCommand(
        'revealFileInOS',
        vscode.Uri.file(absolutePath),
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
      if (message) {
        await this.withActiveWebview(async (w) => {
          await w.postMessage(message);
        });
      }
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
    if (message) {
      await this.withActiveWebview(async (w) => {
        await w.postMessage(message);
      });
    }
  }

  private async setMemoryPinned(
    storagePath: string,
    pinned: boolean,
  ): Promise<void> {
    try {
      const message = pinned
        ? await this.memoryController.pinMemory(storagePath)
        : await this.memoryController.unpinMemory(storagePath);
      if (message) {
        await this.withActiveWebview(async (w) => {
          await w.postMessage(message);
        });
      }
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

  private async handleSelectAgent(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SELECT_AGENT>,
  ): Promise<void> {
    await selectAgentInMainView(data.agentName, {
      showSuccessMessage: true,
      copyToClipboardOnFailure: false,
    });
  }

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

  private async handleSetProviderKey(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_PROVIDER_KEY>,
  ): Promise<void> {
    await this.runProviderKeyAction(data.provider, 'set', (provider) =>
      this.profileKeyController.setProviderKey(provider),
    );
  }

  private async handleRemoveProviderKey(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.REMOVE_PROVIDER_KEY>,
  ): Promise<void> {
    await this.runProviderKeyAction(data.provider, 'remove', (provider) =>
      this.profileKeyController.removeProviderKey(provider),
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
    await vscode.commands.executeCommand('texra.refreshApiKeyStatus');
    await Promise.all([
      vscode.commands.executeCommand('texra.refreshAllOptions'),
      this.withActiveWebview((w) => this.sendProfileAndModelSelectionData(w)),
    ]);
  }

  /** Re-send settings-view profile data to the active webview. */
  private async refreshProfile(): Promise<void> {
    await this.withActiveWebview((w) => this.sendProfileData(w));
  }

  /** Refresh settings-view agent list and main-view dropdown after agent mutations. */
  private async refreshAfterAgentMutation(): Promise<void> {
    await Promise.all([
      this.withActiveWebview((w) =>
        this.agentHandlers.sendAgentSelectionData(w),
      ),
      vscode.commands.executeCommand('texra.refreshAllOptions'),
    ]);
  }

  private async handleOpenProviderKeyUrl(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.OPEN_PROVIDER_KEY_URL>,
  ): Promise<void> {
    await this.profileKeyController.openProviderKeyUrl(data.provider);
  }

  private async handleSetProviderStreaming(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_PROVIDER_STREAMING>,
  ): Promise<void> {
    await setProviderStreaming(data.provider, data.enabled);
    await this.refreshProfile();
  }

  private async handleSetProviderEndpoint(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_PROVIDER_ENDPOINT>,
  ): Promise<void> {
    await setProviderEndpoint(data.provider, data.endpoint);
    await this.refreshProfile();
  }

  private async handleSetGlobalStreaming(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_GLOBAL_STREAMING>,
  ): Promise<void> {
    await setGlobalStreaming(data.enabled);
    await this.refreshProfile();
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
      await vscode.commands.executeCommand('texra.refreshAllOptions');
    }
  }

  // ============================================================
  // Model selection handler implementations
  // ============================================================

  private async handleSetModelEnabled(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_MODEL_ENABLED>,
  ): Promise<void> {
    await this.modelSelectionController.setModelEnabled({
      modelName: data.modelName,
      enabled: data.enabled,
    });
    invalidateModelOptionsCache();
    await Promise.all([
      vscode.commands.executeCommand('texra.refreshAllOptions'),
      this.withActiveWebview((w) => this.sendModelSelectionData(w)),
    ]);
  }

  private async handleSetHelperModel(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_HELPER_MODEL>,
  ): Promise<void> {
    await this.modelSelectionController.setHelperModel(data.modelName);
    await this.withActiveWebview((w) => this.sendModelSelectionData(w));
  }

  private async handleSetModelReasoningLevel(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_MODEL_REASONING_LEVEL>,
  ): Promise<void> {
    await this.modelSelectionController.setReasoningLevel({
      modelName: data.modelName,
      level: data.level,
    });
    await this.withActiveWebview((w) => this.sendModelSelectionData(w));
  }

  private async handleSetPreferShortModelNames(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_PREFER_SHORT_MODEL_NAMES>,
  ): Promise<void> {
    await this.modelSelectionController.setPreferShortModelNames(data.enabled);
    await this.withActiveWebview((w) => this.sendModelSelectionData(w));
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

  private async handleInstallToolExtension(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.INSTALL_TOOL_EXTENSION>,
  ): Promise<void> {
    await this.latexHandlers.installExtension(data.extensionId);
  }
}
