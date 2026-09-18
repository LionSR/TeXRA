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
import { Cause, Effect, Exit } from 'effect';
import { ZodError } from 'zod';
import { ModelError } from '@texra-ai/llm/turn';

// Shared schemas and dispatchers
import type { SessionHandle } from '@agent/runtime';
import { AUTH_COMMANDS } from '@auth/constants';
import { SettingsMemoryController } from '@controllers/settingsView/SettingsMemoryController';
import { SettingsModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionController';
import { getChatGptAuthStatus } from '@controllers/modelAccess/chatGptAuthStatus';
import { getGrokAuthStatus } from '@controllers/modelAccess/grokAuthStatus';
import { SubscriptionUsageService } from '@controllers/modelAccess/subscriptionUsage/SubscriptionUsageService';
import type { SubscriptionProviderId } from '@controllers/modelAccess/subscriptionProviders';
import {
  buildToolDashboardItems,
  planToolTerminalAction,
} from '@controllers/settingsView/ToolDashboardData';
import { SettingsProfileKeyController } from '@controllers/settingsView/SettingsProfileKeyController';
import { SettingsProfileController } from '@controllers/settingsView/SettingsProfileController';
import { appSignals } from '@eventBus/AppSignals';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import {
  isInlineCriticismEnabled,
  setInlineCriticismEnabled,
} from '@frontend/latex/inlineCriticism';
import { VscodePromptHost } from '@frontend/hosts/VscodePromptHost';
import { VscodeExternalOpener } from '@frontend/hosts/VscodeExternalOpener';
import { acquireVscodeLanguageModel } from '@frontend/lm/acquireVscodeLanguageModel';
import {
  showLoggedErrorMessage,
  showLoggedInfoMessage,
} from '@frontend/ui/errorHandlingUtils';
import { subscribeGoalStateChanges } from '@frontend/events/runFactSubscriptions';
import { createLog, type Log } from '@logger/logUtils';
import {
  modelOptionsFrom,
  readModelAvailabilityInputs,
} from '@model/computeModelOptions';
import {
  API_PROVIDERS,
  invalidateApiKeyCache,
  loadApiKeyStatusMap,
} from '@model/apiProviders';
import {
  invalidateRuntimeModelRegistry,
  copilotRouteForModel,
  discoveredCopilotRoutes,
  refreshRuntimeModelRegistry,
} from '@model/runtimeModelRegistry';
import { setCopilotRoutePreference } from '@model/copilotRouting';
import type { StateStore } from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import { revealProgressRun } from '@progressView/progressNavigation';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
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

import {
  applyStateSettingUpdate,
  type SettingsSnapshotPosters,
} from '@shared/settingsView/handlers/stateSettingWrite';

import {
  UnsupportedCommandError,
  unsupportedCommands,
  type DispatcherFn,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';
import { buildSettingsSnapshotMessage } from '@shared/settingsView/handlers/settingsSnapshot';
import { loadRuntimeSkillDisplay } from '@skills/runtimeSkills';
import {
  getLastCheckResults,
  refreshToolAvailability,
} from '@tools/toolAvailability';
import { goalList } from '@tools/goal';
import { getProviderKeyUrl } from '@utils/config/providerConfig';
import { setToolEnabled } from '@utils/config/constants';
import { AgentHandlers } from './handlers/agentHandlers';
import { LatexSettingsHandlers } from './handlers/latexSettingsHandlers';
import { MemoryHandlers } from './handlers/memoryHandlers';
import { GitHubSubscriptionHandlers } from './handlers/githubSubscriptionHandlers';
import { SubscriptionHandlers } from './handlers/subscriptionHandlers';
import type { SettingsHandlerContext } from './handlers/SettingsHandlerContext';

/** The webview shapes SettingsView dispatches for. */
type SettingsWebview = vscode.WebviewView | vscode.WebviewPanel;

/** Type guard to check if a message has a command field. */
function isCommandMessage(
  message: unknown,
): message is { command: string; [key: string]: unknown } {
  return (
    typeof message === 'object' &&
    message !== null &&
    'command' in message &&
    typeof (message as Record<string, unknown>).command === 'string'
  );
}

export class SettingsViewMessageHandler {
  private readonly viewName = 'SettingsView';
  private readonly channel = `${this.viewName}MessageHandler`;
  private readonly log: Log = createLog(this.channel);

  /** Active webview reference, tracked on every dispatch. */
  private activeView: SettingsWebview | undefined;

  private readonly handlerRegistry: SettingsViewInboundHandlerRegistry;

  // Domain-specific handler delegates
  private readonly agentHandlers: AgentHandlers;
  private readonly latexHandlers: LatexSettingsHandlers;
  private readonly memoryHandlers: MemoryHandlers;
  private readonly githubHandlers: GitHubSubscriptionHandlers;
  private readonly chatgptHandlers: SubscriptionHandlers;
  private readonly grokHandlers: SubscriptionHandlers;
  private readonly memoryController: SettingsMemoryController;
  private readonly modelSelectionController: SettingsModelSelectionController;
  private readonly profileController: SettingsProfileController;
  private readonly profileKeyController: SettingsProfileKeyController;
  private readonly subscriptionUsage: SubscriptionUsageService;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly globalState: StateStore,
    secrets: PlatformSecrets,
    private readonly runtime: ProcessRuntime,
    private readonly session: SessionHandle,
  ) {
    const ctx: SettingsHandlerContext = this.handlerContext();

    this.memoryController = new SettingsMemoryController({
      prompt: new VscodePromptHost(),
    });
    this.modelSelectionController = new SettingsModelSelectionController({
      stores: session.roots,
      secrets,
      // The availability read is an Effect; this is the boundary that holds a
      // runtime to run it on, so the controller takes its rows as data.
      resolveModelOptions: async (stores, models) =>
        modelOptionsFrom(
          await this.runtime.runPromise(
            readModelAvailabilityInputs(stores, models),
          ),
        ),
      // The route catalogue read is an Effect for the same reason.
      getCopilotRoutes: () =>
        this.runtime.runPromise(discoveredCopilotRoutes()),
    });
    this.profileController = new SettingsProfileController({
      host: 'vscode',
      // The Models-tab toggles resolve through the catalog's own slots, so the
      // controller takes the session's three stores rather than one store and
      // a config reader.
      stores: session.roots,
      // The key-status read is an Effect; this is the boundary that holds a
      // runtime to settle it on.
      loadProviderKeyStatuses: () =>
        this.runtime.runPromise(loadApiKeyStatusMap(secrets, API_PROVIDERS)),
    });
    this.subscriptionUsage = new SubscriptionUsageService({
      secrets,
      stores: session.roots,
    });
    this.profileKeyController = new SettingsProfileKeyController({
      secrets,
      prompt: new VscodePromptHost(),
      externalOpener: new VscodeExternalOpener(),
      getProviderDisplayName: (provider) =>
        this.profileController.getProviderDisplayName(provider),
      getProviderKeyUrl: (provider) =>
        getProviderKeyUrl(session.roots, provider),
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
      session.roots,
      this.runtime,
    );
    this.latexHandlers = new LatexSettingsHandlers(ctx);
    this.memoryHandlers = new MemoryHandlers(
      ctx,
      this.memoryController,
      this.viewName,
      this.runtime,
      session,
    );
    this.githubHandlers = new GitHubSubscriptionHandlers(
      ctx,
      secrets,
      this.runtime,
    );
    this.chatgptHandlers = new SubscriptionHandlers(
      'chatgpt',
      async () => ({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_CHATGPT_AUTH_STATUS,
        status: await this.runtime.runPromise(
          getChatGptAuthStatus(session.roots, secrets),
        ),
      }),
      ctx,
      secrets,
      () => this.refreshAfterSubscriptionAuthChange('chatgpt'),
      this.runtime,
      session.roots,
    );
    this.grokHandlers = new SubscriptionHandlers(
      'grok',
      async () => ({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_GROK_AUTH_STATUS,
        status: await this.runtime.runPromise(
          getGrokAuthStatus(session.roots, secrets),
        ),
      }),
      ctx,
      secrets,
      () => this.refreshAfterSubscriptionAuthChange(),
      this.runtime,
      session.roots,
    );
    this.handlerRegistry = this.createHandlerRegistry(context);

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
        // `apply_team` writes the roster straight from the setup agent, so
        // the open view is showing agents and a team it just replaced. The
        // catalog is already fresh: a team change moves no agent files, and
        // the agent-creator reloads before it emits. Without that flag this
        // listener would rescan the YAML and re-fetch the remote catalog on
        // every roster write.
        dispose: appSignals.on('agentRosterChanged', () => {
          void this.refreshAfterAgentMutation(undefined, true);
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
    const unsubscribeGoals = subscribeGoalStateChanges(
      session,
      () => {
        void this.withActiveWebview((w) => this.sendGoalList(w));
      },
      this.runtime,
    );
    context.subscriptions.push({ dispose: unsubscribeGoals });
  }

  /**
   * Sign in to a subscription provider from outside the settings webview.
   * Routes to the same handler the Settings → Subscriptions button runs, so
   * the command palette gets the status round-trip and credential refresh
   * tail instead of a bespoke sign-in that leaves both stale.
   */
  public signInSubscription(providerId: SubscriptionProviderId): Promise<void> {
    const handlers = { chatgpt: this.chatgptHandlers, grok: this.grokHandlers };
    return handlers[providerId].handleSignIn();
  }

  private createHandlerRegistry(
    context: vscode.ExtensionContext,
  ): SettingsViewInboundHandlerRegistry {
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
      pinMemory: (message) =>
        this.memoryHandlers.setMemoryPinned(message.storagePath, true),
      unpinMemory: (message) =>
        this.memoryHandlers.setMemoryPinned(message.storagePath, false),
      signIn: () =>
        safeExecuteCommand(AUTH_COMMANDS.SIGN_IN, [], this.viewName),
      signOut: () =>
        safeExecuteCommand(AUTH_COMMANDS.SIGN_OUT, [], this.viewName),
      setProviderKey: (message) =>
        this.runtime.runPromise(
          this.profileKeyController.setProviderKey(message.provider),
        ),
      removeProviderKey: (message) =>
        this.runtime.runPromise(
          this.profileKeyController.removeProviderKey(message.provider),
        ),
      openProviderKeyUrl: (message) =>
        this.runtime.runPromise(
          this.profileKeyController.openProviderKeyUrl(message.provider),
        ),
      openExternalUrl: (message) => this.openExternalUrl(message.url),
      setModelEnabled: (message) =>
        this.setModelEnabled(message.modelName, message.enabled),
      setModelReasoningLevel: async (message) => {
        await this.runtime.runPromise(
          this.modelSelectionController.setReasoningLevel({
            modelName: message.modelName,
            level: message.level,
          }),
        );
        await this.postModelSelectionData();
      },
      requestModelAccess: (message) =>
        this.handleRequestModelAccess(message.modelName, context),
      clearCopilotRoute: (message) =>
        this.handleClearCopilotRoute(message.modelName),
      setAgentEnabled: (message) =>
        this.agentHandlers.handleSetAgentEnabled(message),
      setAllAgentsEnabled: (message) =>
        this.agentHandlers.handleSetAllAgentsEnabled(message),
      openAgentYaml: (message) =>
        this.agentHandlers.runAgentFileAction(
          'openAgentYaml',
          this.agentHandlers.agentActions.openAgentYaml(message),
        ),
      openAgentFolder: (message) =>
        this.agentHandlers.handleOpenAgentFolder(message),
      createAgent: (message) => this.agentHandlers.handleCreateAgent(message),
      customizeAgent: (message) =>
        this.agentHandlers.runAgentFileAction(
          'customizeAgent',
          this.agentHandlers.agentActions.customizeAgent(message),
        ),
      deleteCustomAgent: (message) =>
        this.agentHandlers.handleDeleteCustomAgent(message),
      revealAgentFile: (message) =>
        this.agentHandlers.runAgentFileAction(
          'revealAgentFile',
          this.agentHandlers.agentActions.revealAgentFile(message),
        ),
      viewRemoteAgentPrompt: (message) =>
        this.agentHandlers.handleViewRemoteAgentPrompt(message),
      setCustomAgentDir: () => this.agentHandlers.handleSetCustomAgentDir(),
      resetCustomAgentDir: () => this.agentHandlers.handleResetCustomAgentDir(),
      applyAgentModePreset: (message) =>
        this.agentHandlers.handleApplyAgentModePreset(message),
      saveAgentModePreset: () => this.agentHandlers.handleSaveAgentModePreset(),
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
          this.sendSubscriptionUsage(webview, message.forceRefresh ?? false),
        ),
      updateStateSetting: (message) =>
        this.updateStateSetting(message.key, message.value),
      openToolInstallUrl: (message) => this.openExternalUrl(message.url),
      installToolExtension: (message) =>
        this.latexHandlers.installExtension(message.extensionId),
      recheckToolStatus: () =>
        this.runtime.runPromise(
          refreshToolAvailability(this.session.roots.workspace),
        ),
      toggleTool: async (message) => {
        await this.runtime.runPromise(
          setToolEnabled(message.toolId, message.enabled, this.globalState),
        );
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
      revealGoalRun: async (message) => {
        await revealProgressRun(message.runId);
      },
    };
  }

  public async sendGoalList(webview: vscode.Webview): Promise<void> {
    const result = await this.runtime.runPromiseExit(
      Effect.tryPromise({
        try: () =>
          webview.postMessage({
            command: SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST,
            items: goalList(this.session),
          }),
        catch: (error) => error,
      }).pipe(
        Effect.flatMap((delivered) =>
          delivered
            ? Effect.void
            : Effect.fail(new Error('settings webview is no longer available')),
        ),
      ),
    );
    if (Exit.isFailure(result)) {
      const reason =
        result.cause.reasons.length === 1 ? result.cause.reasons[0] : undefined;
      await showLoggedErrorMessage(
        this.channel,
        'Failed to load goals',
        reason && Cause.isFailReason(reason)
          ? reason.error
          : new Error(Cause.pretty(result.cause), { cause: result.cause }),
      );
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
      this.log.debug('No command for tool', {
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

  // ============================================================
  // Inbound dispatch — SettingsViewProvider's entry point
  // ============================================================

  /** Clear the tracked active view. */
  public clearActiveView(): void {
    this.activeView = undefined;
  }

  /**
   * Bind the slice-visible subset of this handler for the command delegates.
   */
  private handlerContext(): SettingsHandlerContext {
    return {
      channel: this.channel,
      log: this.log,
      extensionContext: this.context,
      withActiveWebview: (fn) => this.withActiveWebview(fn),
      postMessageToActiveWebview: (message) =>
        this.postMessageToActiveWebview(message),
    };
  }

  /** Run a callback with the active view's webview, if available. */
  private async withActiveWebview(
    fn: (webview: vscode.Webview) => Promise<void> | void,
  ): Promise<void> {
    const view = this.activeView;
    if (view) await fn(view.webview);
  }

  /**
   * Post a message to the active view's webview, awaiting delivery. A `null`
   * or `undefined` message posts nothing, so callers can forward an optional
   * response payload without a guard of their own. This resolves only after
   * the post settles — mutation paths that run a follow-up step depend on
   * that ordering.
   */
  private async postMessageToActiveWebview(message: unknown): Promise<void> {
    if (message == null) return;
    await this.withActiveWebview(async (webview) => {
      await webview.postMessage(message);
    });
  }

  /** Keep a failed notification from becoming an unhandled host rejection. */
  private reportNotificationFailure(notification: PromiseLike<unknown>): void {
    void notification.then(undefined, (error: unknown) => {
      this.log.error('Failed to display message notification', {
        data: error,
      });
    });
  }

  /**
   * Schema-driven dispatch through the view's typed {@link DispatcherFn}.
   * Tracks the active view, runs the dispatcher, logs Zod validation failures
   * at debug (expected, frequent) and handler exceptions at error (a real
   * bug), and warns on commands with no handler.
   */
  private async dispatchInbound<TMessage extends { command: string }>(
    message: unknown,
    webviewView: SettingsWebview,
    dispatcher: DispatcherFn<TMessage>,
    handlers: HandlerRegistry<TMessage>,
  ): Promise<void> {
    this.activeView = webviewView;

    let unsupported = false;
    const handled = dispatcher(message, handlers, (error) => {
      if (error instanceof ZodError) {
        this.log.debug('Message validation failed', {
          data: error,
        });
      } else if (error instanceof UnsupportedCommandError) {
        // Declared `unsupported(...)` in this host's registry: visible
        // feedback (toast), not a silent drop or an error-level log.
        unsupported = true;
        this.log.debug(error.message);
        this.reportNotificationFailure(
          vscode.window.showInformationMessage(error.reason),
        );
      } else {
        this.log.error('Error handling message', {
          data: error,
        });
        this.reportNotificationFailure(
          vscode.window.showErrorMessage(
            `TeXRA could not handle a ${this.viewName} message. See the TeXRA output for details.`,
          ),
        );
      }
    });

    if (!handled && !unsupported && isCommandMessage(message)) {
      this.log.warn(`Unhandled command: ${message.command}`);
    }
  }

  public async handleMessage(
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

    await this.sendProfileAndModelSelectionData(webview);

    await Promise.all([
      this.memoryHandlers.sendMemoryData(webview),
      this.sendSettingsSnapshot(webview, 'memory'),
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
      this.sendSettingsSnapshot(webview, 'skills'),
      this.sendSkillsList(webview),
      this.sendSettingsSnapshot(webview, 'telemetry'),
      this.latexHandlers.sendLatexSettingsStatus(webview),
      this.sendSettingsSnapshot(webview, 'latex'),
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
      await this.runtime.runPromise(
        this.profileController.buildProfileMessage(),
      ),
    );
  }

  private async sendModelSelectionData(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(
      await this.modelSelectionController.buildModelSelectionMessage(),
    );
  }

  /** Post the model-selection payload to whichever webview is active. */
  private async postModelSelectionData(): Promise<void> {
    await this.postMessageToActiveWebview(
      await this.modelSelectionController.buildModelSelectionMessage(),
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

  /** Post one catalog-derived snapshot. Every field comes from the catalog. */
  private async sendSettingsSnapshot(
    webview: vscode.Webview,
    snapshot: DerivedSettingsSnapshot,
  ): Promise<void> {
    await webview.postMessage(
      buildSettingsSnapshotMessage(snapshot, this.session.roots, 'vscode'),
    );
  }

  private rebroadcastSnapshot(
    snapshot: DerivedSettingsSnapshot,
  ): Promise<void> {
    return this.withActiveWebview((w) =>
      this.sendSettingsSnapshot(w, snapshot),
    );
  }

  private async sendSkillsList(webview: vscode.Webview): Promise<void> {
    const result = await loadRuntimeSkillDisplay(this.session.roots.workspace);
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_SKILLS_LIST,
      ...result,
    });
  }

  /**
   * Generic write path for catalog-backed settings-view rows.
   */
  private async updateStateSetting(key: string, value: unknown): Promise<void> {
    const result = await this.runtime.runPromise(
      applyStateSettingUpdate(key, value, {
        host: 'vscode',
        stores: this.session.roots,
        // The shared function already gates this hook on
        // `configTarget !== 'global'`; this checks only the workspace half.
        requiresOpenWorkspace: () => !this.session.roots.workspace,
        onApprovalPolicyChanged: (policy) => {
          this.session.setApprovalPolicy(policy);
          appSignals.emit('approvalPolicyChanged', undefined);
        },
      }),
    );
    if (result.kind === 'ignored') return;
    const label = result.entry.title ?? result.entry.key;
    if (result.kind === 'rejected') {
      await showLoggedErrorMessage(
        this.channel,
        `Invalid value for “${label}”`,
        result.error,
      );
    } else if (result.kind === 'workspace-required') {
      void showLoggedInfoMessage(
        this.channel,
        `Open a workspace folder before changing the “${label}” setting.`,
      );
    } else if (result.kind === 'failed') {
      await showLoggedErrorMessage(
        this.channel,
        `Failed to update “${label}”`,
        result.error,
      );
    }
    await this.postStateSettingSnapshot(result.entry.surfaces.settingsView);
    if (result.kind !== 'applied') return;
    if (result.entry.onWrite?.invalidatesModelOptions) {
      await this.withActiveWebview((w) => this.sendModelSelectionData(w));
      await safeExecuteCommand('texra.refreshAllOptions', [], this.viewName);
    }
    if (codingPlanForUsageSetting(key) !== undefined) {
      await this.withActiveWebview((w) => this.sendSubscriptionUsage(w));
    }
  }

  /** Fetch and post one sanitized snapshot for every subscription provider.
   *  The usage read is an Effect; this is the boundary that holds a runtime to
   *  settle it on. */
  private async sendSubscriptionUsage(
    webview: vscode.Webview,
    forceRefresh = false,
  ): Promise<void> {
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE,
      snapshots: await this.runtime.runPromise(
        this.subscriptionUsage.getAllUsage({ forceRefresh }),
      ),
    });
  }

  private async postStateSettingSnapshot(
    snapshot: SettingsViewSnapshot,
  ): Promise<void> {
    const posters: SettingsSnapshotPosters = {
      approval: () => this.rebroadcastSnapshot('approval'),
      'git-author': () => this.rebroadcastSnapshot('git-author'),
      latex: () => this.rebroadcastSnapshot('latex'),
      memory: () => this.rebroadcastSnapshot('memory'),
      models: () =>
        this.withActiveWebview((w) => this.sendModelSelectionData(w)),
      'multi-agent': () => this.rebroadcastSnapshot('multi-agent'),
      profile: () => this.withActiveWebview((w) => this.sendProfileData(w)),
      skills: async () => {
        await this.rebroadcastSnapshot('skills');
        await this.withActiveWebview((w) => this.sendSkillsList(w));
      },
      telemetry: () => this.rebroadcastSnapshot('telemetry'),
    };
    await posters[snapshot]();
  }

  // ============================================================
  // Profile handler implementations
  // ============================================================

  /**
   * The shared refresh tail for a credential change (API key or subscription
   * auth): drop the cached usage, re-run the host refresh commands, and push
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
    if (options.usageProvider) {
      this.subscriptionUsage.invalidate(options.usageProvider);
    }
    await safeExecuteCommand('texra.refreshApiKeyStatus', [], this.viewName);
    await Promise.all([
      safeExecuteCommand('texra.refreshAllOptions', [], this.viewName),
      this.withActiveWebview((w) => options.refreshProfileData(w)),
      ...(options.usageProvider
        ? [this.withActiveWebview((w) => this.sendSubscriptionUsage(w))]
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
    // The launcher's API-key banner reads the same credential probe from
    // the host snapshot.
    await ProgressViewProvider.getInstance()?.refreshHostBanners();
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

  private async handleRequestModelAccess(
    modelName: string,
    context: vscode.ExtensionContext,
  ): Promise<void> {
    try {
      const discovery = await this.runtime.runPromiseExit(
        Effect.gen(function* () {
          // Retry one superseded discovery, then fail closed rather than
          // authorize from the retained presentation catalogue. A failed
          // probe fails the program: authorization never falls back to the
          // retained catalogue.
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const result = yield* refreshRuntimeModelRegistry({
              forceDiscovery: true,
            });
            if (result === 'current') return copilotRouteForModel(modelName);
          }
          return undefined;
        }),
      );
      const route = Exit.isSuccess(discovery) ? discovery.value : undefined;
      let result: Exit.Exit<unknown, unknown> = discovery;
      if (route?.access === 'consent-required') {
        result = await this.runtime.runPromiseExit(
          Effect.gen(function* () {
            const model = yield* acquireVscodeLanguageModel(
              context,
              {
                protocol: 'vscode-lm',
                requestedModel: route.reference.id,
                deployment: {
                  vendor: route.reference.vendor,
                  version: route.version,
                },
                supportsImageInput: false,
                supportsToolCalling: false,
                defaults: { justification: 'Use Copilot models in TeXRA.' },
              },
              'request-on-send',
            );
            const turn = yield* model.prepareTurn({
              messages: [
                {
                  role: 'user',
                  content: [
                    {
                      kind: 'text',
                      text: 'Reply with OK to confirm language-model access for TeXRA.',
                    },
                  ],
                },
              ],
            });
            if (turn.mode !== 'foreground') {
              return yield* new ModelError({
                kind: 'unsupported',
                message: 'Editor access requires a foreground request.',
              });
            }
            // Consume completion; partial output does not establish access.
            yield* model.generateTurn(turn);
          }).pipe(Effect.scoped),
          // Preserve the post-discovery deadline at the host boundary. Direct
          // interruption joins cleanup and retains any distinct release failure.
          { signal: AbortSignal.timeout(120_000) },
        );
      }
      if (Exit.isSuccess(result)) {
        // Two different programs: the notice is a host dialog, the preference
        // is a state write. The boundary composes whichever it chose.
        const settle: Effect.Effect<unknown, unknown> =
          !route || route.access === 'unavailable'
            ? Effect.tryPromise({
                try: () =>
                  showLoggedInfoMessage(
                    this.channel,
                    'This Copilot model is no longer available in VS Code. Refresh the model list and choose another model.',
                  ),
                catch: (error) => error,
              })
            : setCopilotRoutePreference(modelName, true, this.globalState);
        result = await this.runtime.runPromiseExit(settle);
      }
      if (Exit.isFailure(result)) {
        const reason =
          result.cause.reasons.length === 1
            ? result.cause.reasons[0]
            : undefined;
        const error =
          reason && Cause.isFailReason(reason) ? reason.error : undefined;
        if (
          error instanceof ModelError &&
          error.providerEvidence?.kind === 'vscode-lm' &&
          error.providerEvidence.code === 'NoPermissions'
        ) {
          await showLoggedInfoMessage(
            this.channel,
            'Copilot access was not granted. TeXRA will leave these models disabled.',
          );
        } else {
          await showLoggedErrorMessage(
            this.channel,
            'Could not request Copilot model access',
            new Error(
              Cause.hasInterruptsOnly(result.cause)
                ? 'The Copilot access request was cancelled.'
                : Cause.pretty(result.cause),
              { cause: result.cause },
            ),
          );
        }
      }
    } finally {
      invalidateRuntimeModelRegistry();
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
    // The write is a program, not a promise: the boundary runs it, and a
    // refused write reaches the caller as this method's rejection.
    await this.runtime.runPromise(
      setCopilotRoutePreference(modelName, false, this.globalState),
    );
    await Promise.all([
      safeExecuteCommand('texra.refreshAllOptions', [], this.viewName),
      this.withActiveWebview((webview) => this.sendModelSelectionData(webview)),
    ]);
  }

  /**
   * Refresh settings-view agent list and main-view dropdown after agent
   * mutations. The team presets ride along because every roster mutation can
   * move the effective team: enabling one agent rewrites the selection as
   * `custom`, which retires whatever team was applied.
   */
  private async refreshAfterAgentMutation(
    selectedToolUseAgent?: string,
    agentCatalogAlreadyFresh = false,
  ): Promise<void> {
    await Promise.all([
      this.withActiveWebview((w) =>
        this.agentHandlers.sendAgentSelectionData(w),
      ),
      this.withActiveWebview((w) => this.agentHandlers.sendAgentModePresets(w)),
      safeExecuteCommand(
        'texra.refreshAllOptions',
        selectedToolUseAgent || agentCatalogAlreadyFresh
          ? [{ selectedToolUseAgent, agentCatalogAlreadyFresh }]
          : [],
        this.viewName,
      ),
    ]);
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
    const items = await this.runtime.runPromise(
      buildToolDashboardItems(
        'extension',
        this.session.roots.workspace,
        cachedResults,
      ),
    );
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
      items,
    });
  }

  private async openExternalUrl(url: string): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  private async setModelEnabled(
    modelName: string,
    enabled: boolean,
  ): Promise<void> {
    await this.runtime.runPromise(
      this.modelSelectionController.setModelEnabled({ modelName, enabled }),
    );
    await this.postModelSelectionData();
    // The options cache is invalidated by the writer itself.
    await safeExecuteCommand('texra.refreshAllOptions', [], this.viewName);
  }
}
