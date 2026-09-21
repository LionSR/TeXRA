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
import { VscodeExternalOpener } from '@frontend/hosts/VscodeExternalOpener';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { acquireVscodeLanguageModel } from '@frontend/lm/acquireVscodeLanguageModel';
import {
  showLoggedErrorMessage,
  showLoggedInfoMessage,
} from '@frontend/ui/errorHandlingUtils';
import { subscribeGoalStateChanges } from '@frontend/events/runFactSubscriptions';
import { NotificationFailed } from '@hosts/uiHosts';
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
import type { LanguageModel } from '@platform/languageModel';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
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
import { allSettledVoid } from '@utils/core/allSettledVoid';
import { ensureError } from '@utils/errors/errorMessage';
import { setToolEnabled } from '@utils/config/constants';
import { AgentHandlers } from './handlers/agentHandlers';
import { LatexSettingsHandlers } from './handlers/latexSettingsHandlers';
import { MemoryHandlers } from './handlers/memoryHandlers';
import { GitHubSubscriptionHandlers } from './handlers/githubSubscriptionHandlers';
import { SubscriptionHandlers } from './handlers/subscriptionHandlers';
import {
  postToWebview,
  type SettingsHandlerContext,
} from './handlers/SettingsHandlerContext';

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
  private readonly modelSelectionController: SettingsModelSelectionController<LanguageModel>;
  private readonly profileController: SettingsProfileController;
  private readonly profileKeyController: SettingsProfileKeyController<ProcessServices>;
  /** The typed message and dialog surface this view reports and asks on. */
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
      prompt: vscodeUi,
    });
    this.modelSelectionController = new SettingsModelSelectionController({
      stores: session.roots,
      secrets,
      resolveModelOptions: (stores, models) =>
        Effect.map(
          readModelAvailabilityInputs(stores, models),
          modelOptionsFrom,
        ),
      copilotRoutes: discoveredCopilotRoutes(),
    });
    this.profileController = new SettingsProfileController({
      host: 'vscode',
      // The Models-tab toggles resolve through the catalog's own slots, so the
      // controller takes the session's three stores rather than one store and
      // a config reader.
      stores: session.roots,
      loadProviderKeyStatuses: loadApiKeyStatusMap(secrets, API_PROVIDERS),
    });
    this.subscriptionUsage = new SubscriptionUsageService({
      secrets,
      stores: session.roots,
    });
    this.profileKeyController = new SettingsProfileKeyController({
      secrets,
      prompt: vscodeUi,
      externalOpener: new VscodeExternalOpener(),
      getProviderDisplayName: (provider) =>
        this.profileController.getProviderDisplayName(provider),
      getProviderKeyUrl: (provider) =>
        getProviderKeyUrl(session.roots, provider),
      refreshAfterKeyChange: (provider) =>
        this.refreshAfterProviderKeyChange(provider),
      reportFailure: (message, error) =>
        showLoggedErrorMessage(this.channel, message, error).pipe(
          // On error, still refresh settings view to reflect current key state.
          Effect.andThen(
            this.withActiveWebview((w) =>
              this.sendProfileAndModelSelectionData(w),
            ),
          ),
          Effect.orDie,
        ),
    });
    this.agentHandlers = new AgentHandlers(
      ctx,
      (selectedToolUseAgent, agentCatalogAlreadyFresh) =>
        this.refreshAfterAgentMutation(
          selectedToolUseAgent,
          agentCatalogAlreadyFresh,
        ),
      session.roots,
    );
    this.latexHandlers = new LatexSettingsHandlers(ctx);
    this.memoryHandlers = new MemoryHandlers(
      ctx,
      this.memoryController,
      this.viewName,
      session,
    );
    this.githubHandlers = new GitHubSubscriptionHandlers(ctx, secrets);
    this.chatgptHandlers = new SubscriptionHandlers(
      'chatgpt',
      ctx,
      secrets,
      () => this.refreshAfterSubscriptionAuthChange('chatgpt'),
      session.roots,
    );
    this.grokHandlers = new SubscriptionHandlers(
      'grok',
      ctx,
      secrets,
      () => this.refreshAfterSubscriptionAuthChange(),
      session.roots,
    );
    this.handlerRegistry = this.createHandlerRegistry(context);

    context.subscriptions.push(
      {
        dispose: appSignals.on('githubSubscriptionsChanged', () => {
          this.runtime.runFork(
            this.withActiveWebview((w) =>
              this.githubHandlers.sendPRSubscriptions(w),
            ),
          );
        }),
      },
      {
        dispose: appSignals.on('toolAvailabilityChanged', () => {
          this.runtime.runFork(
            this.withActiveWebview((w) =>
              this.sendToolDashboardData(w, { skipChecks: true }),
            ),
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
          this.runtime.runFork(this.refreshAfterAgentMutation(undefined, true));
        }),
      },
      {
        dispose: appSignals.on('languageModelsChanged', () => {
          this.runtime.runFork(
            this.withActiveWebview((webview) =>
              this.sendModelSelectionData(webview),
            ),
          );
        }),
      },
    );
    const unsubscribeGoals = subscribeGoalStateChanges(
      session,
      () => {
        this.runtime.runFork(
          this.withActiveWebview((w) => this.sendGoalList(w)),
        );
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
    return this.runtime.runPromise(handlers[providerId].handleSignIn());
  }

  /**
   * The inbound registry: one settled program per message arm. `run` is this
   * host's R1 boundary — the dispatcher's `MessageHandler` contract is
   * promise-shaped, so it is the only place a settings message is run, and
   * the delegates reach the same boundary through `SettingsHandlerContext.run`.
   *
   * A tab whose arms all belong to one delegate contributes them as a table it
   * owns (`...delegate.handlers`), as the desktop's controllers do; what is
   * spelled out here is what this host performs itself: the profile and
   * model commands, the Tools dashboard, the generic catalog write, and the
   * two VS Code-only surfaces (Copilot access, extension installation) that
   * have no catalog row to derive an arm from.
   */
  private createHandlerRegistry(
    context: vscode.ExtensionContext,
  ): SettingsViewInboundHandlerRegistry {
    const run = <A, E>(
      program: Effect.Effect<A, E, ProcessServices>,
    ): Promise<A> => this.runtime.runPromise(program);
    return {
      webviewReady: () =>
        run(this.withActiveWebview((w) => this.sendAllData(w))),
      ...this.memoryHandlers.handlers,
      signIn: () =>
        run(safeExecuteCommand(AUTH_COMMANDS.SIGN_IN, [], this.viewName)),
      signOut: () =>
        run(safeExecuteCommand(AUTH_COMMANDS.SIGN_OUT, [], this.viewName)),
      setProviderKey: (message) =>
        run(this.profileKeyController.setProviderKey(message.provider)),
      removeProviderKey: (message) =>
        run(this.profileKeyController.removeProviderKey(message.provider)),
      openProviderKeyUrl: (message) =>
        run(this.profileKeyController.openProviderKeyUrl(message.provider)),
      openExternalUrl: (message) => run(this.openExternalUrl(message.url)),
      setModelEnabled: (message) =>
        run(this.setModelEnabled(message.modelName, message.enabled)),
      setModelReasoningLevel: (message) =>
        run(
          this.modelSelectionController
            .setReasoningLevel({
              modelName: message.modelName,
              level: message.level,
            })
            .pipe(Effect.andThen(this.postModelSelectionData())),
        ),
      requestModelAccess: (message) =>
        this.handleRequestModelAccess(message.modelName, context),
      clearCopilotRoute: (message) =>
        run(this.handleClearCopilotRoute(message.modelName)),
      setAgentEnabled: (message) =>
        run(this.agentHandlers.handleSetAgentEnabled(message)),
      setAllAgentsEnabled: (message) =>
        run(this.agentHandlers.handleSetAllAgentsEnabled(message)),
      openAgentYaml: (message) =>
        run(
          this.agentHandlers.runAgentFileAction(
            'openAgentYaml',
            this.agentHandlers.agentActions.openAgentYaml(message),
          ),
        ),
      openAgentFolder: (message) =>
        run(this.agentHandlers.handleOpenAgentFolder(message)),
      createAgent: (message) =>
        run(this.agentHandlers.handleCreateAgent(message)),
      customizeAgent: (message) =>
        run(
          this.agentHandlers.runAgentFileAction(
            'customizeAgent',
            this.agentHandlers.agentActions.customizeAgent(message),
          ),
        ),
      deleteCustomAgent: (message) =>
        run(this.agentHandlers.handleDeleteCustomAgent(message)),
      revealAgentFile: (message) =>
        run(
          this.agentHandlers.runAgentFileAction(
            'revealAgentFile',
            this.agentHandlers.agentActions.revealAgentFile(message),
          ),
        ),
      viewRemoteAgentPrompt: (message) =>
        run(this.agentHandlers.handleViewRemoteAgentPrompt(message)),
      setCustomAgentDir: () =>
        run(this.agentHandlers.handleSetCustomAgentDir()),
      resetCustomAgentDir: () =>
        run(this.agentHandlers.handleResetCustomAgentDir()),
      applyAgentModePreset: (message) =>
        run(this.agentHandlers.handleApplyAgentModePreset(message)),
      saveAgentModePreset: () =>
        run(this.agentHandlers.handleSaveAgentModePreset()),
      deleteAgentModePreset: (message) =>
        run(this.agentHandlers.handleDeleteAgentModePreset(message)),
      ...this.githubHandlers.handlers,
      signInChatGpt: () => run(this.chatgptHandlers.handleSignIn()),
      signOutChatGpt: () => run(this.chatgptHandlers.handleSignOut()),
      setChatGptPreferSubscription: (message) =>
        run(this.chatgptHandlers.handleSetPreferSubscription(message.enabled)),
      signInGrok: () => run(this.grokHandlers.handleSignIn()),
      signOutGrok: () => run(this.grokHandlers.handleSignOut()),
      setGrokPreferSubscription: (message) =>
        run(this.grokHandlers.handleSetPreferSubscription(message.enabled)),
      getSubscriptionUsage: (message) =>
        run(
          this.withActiveWebview((webview) =>
            this.sendSubscriptionUsage(webview, message.forceRefresh ?? false),
          ),
        ),
      updateStateSetting: (message) =>
        run(this.updateStateSetting(message.key, message.value)),
      openToolInstallUrl: (message) => run(this.openExternalUrl(message.url)),
      installToolExtension: (message) =>
        run(this.latexHandlers.installExtension(message.extensionId)),
      recheckToolStatus: () =>
        run(
          refreshToolAvailability({
            workspaceRoot: this.session.roots.workspace,
            config: this.session.roots.config,
          }),
        ),
      toggleTool: (message) =>
        run(
          setToolEnabled(
            message.toolId,
            message.enabled,
            this.globalState,
          ).pipe(
            Effect.andThen(
              this.withActiveWebview((w) =>
                this.sendToolDashboardData(w, { skipChecks: true }),
              ),
            ),
          ),
        ),
      runToolCommand: (message) => this.handleRunToolCommand(message),
      ...this.latexHandlers.handlers,
      getInlineCriticismEnabled: () =>
        run(this.withActiveWebview((w) => this.sendInlineCriticismEnabled(w))),
      setInlineCriticismEnabled: (message) =>
        run(this.handleSetInlineCriticismEnabled(message.enabled)),
      getGoalList: () =>
        run(this.withActiveWebview((w) => this.sendGoalList(w))),
      revealGoalRun: (message) =>
        run(revealProgressRun(message.runId).pipe(Effect.asVoid)),
    };
  }

  public sendGoalList(webview: vscode.Webview): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const result = yield* Effect.exit(
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
              : Effect.fail(
                  new Error('settings webview is no longer available'),
                ),
          ),
        ),
      );
      if (Exit.isFailure(result)) {
        const reason =
          result.cause.reasons.length === 1
            ? result.cause.reasons[0]
            : undefined;
        yield* showLoggedErrorMessage(
          this.channel,
          'Failed to load goals',
          reason && Cause.isFailReason(reason)
            ? reason.error
            : new Error(Cause.pretty(result.cause), { cause: result.cause }),
        );
      }
    });
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
      run: (program) => this.runtime.runPromise(program),
    };
  }

  /**
   * Run a program with the active view's webview, if available. The view is
   * read when the program runs, not when it is built: a panel disposed
   * between a mutation and its refresh leaves nothing to post to.
   */
  private withActiveWebview<E, R>(
    fn: (webview: vscode.Webview) => Effect.Effect<void, E, R>,
  ): Effect.Effect<void, E, R> {
    return Effect.suspend(() => {
      const view = this.activeView;
      return view ? fn(view.webview) : Effect.void;
    });
  }

  /**
   * Post a message to the active view's webview. A `null` or `undefined`
   * message posts nothing, so callers can forward an optional response
   * payload without a guard of their own.
   */
  private postMessageToActiveWebview(
    message: unknown,
  ): Effect.Effect<void, Error> {
    return message == null
      ? Effect.void
      : this.withActiveWebview((webview) => postToWebview(webview, message));
  }

  /**
   * Show one dispatcher-level notice on a detached fiber. A message surface
   * that refuses it arrives as `NotificationFailed` and is logged, rather
   * than leaving a rejected thenable nobody awaited.
   */
  private forkNotice(notice: Effect.Effect<void, NotificationFailed>): void {
    this.runtime.runFork(
      notice.pipe(
        Effect.catchTag('NotificationFailed', (failure) =>
          Effect.sync(() => {
            this.log.error('Failed to display message notification', {
              data: failure.cause,
            });
          }),
        ),
      ),
    );
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
        this.forkNotice(vscodeUi.showInfoMessage(error.reason));
      } else {
        this.log.error('Error handling message', {
          data: error,
        });
        this.forkNotice(
          vscodeUi.showErrorMessage(
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

  public sendAllData(
    webview: vscode.Webview,
  ): Effect.Effect<void, Error, ProcessServices> {
    return Effect.gen({ self: this }, function* () {
      // Tool dashboard involves network I/O (Zotero probe, etc.) — fire on a
      // detached fiber so it doesn't block the initial render. The frontend
      // shows a loading spinner until data arrives.
      yield* Effect.forkDetach(this.sendToolDashboardData(webview), {
        startImmediately: true,
      });

      yield* postToWebview(webview, {
        command: SETTINGS_VIEW_COMMANDS.SET_UNSUPPORTED_COMMANDS,
        commands: unsupportedCommands(this.handlerRegistry),
      });

      yield* this.sendProfileAndModelSelectionData(webview);

      yield* allSettledVoid<Error, ProcessServices>([
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
    });
  }

  private sendInlineCriticismEnabled(webview: vscode.Webview) {
    return postToWebview(webview, {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_INLINE_CRITICISM_ENABLED,
      enabled: isInlineCriticismEnabled(),
    });
  }

  private handleSetInlineCriticismEnabled(enabled: boolean) {
    return Effect.tryPromise({
      try: () => setInlineCriticismEnabled(enabled),
      catch: ensureError,
    }).pipe(
      Effect.andThen(
        this.withActiveWebview((w) => this.sendInlineCriticismEnabled(w)),
      ),
    );
  }

  private sendProfileData(webview: vscode.Webview) {
    return Effect.flatMap(
      this.profileController.buildProfileMessage(),
      (message) => postToWebview(webview, message),
    );
  }

  private sendModelSelectionData(webview: vscode.Webview) {
    return Effect.flatMap(
      this.modelSelectionController.buildModelSelectionMessage(),
      (message) => postToWebview(webview, message),
    );
  }

  /** Post the model-selection payload to whichever webview is active. */
  private postModelSelectionData() {
    return this.withActiveWebview((w) => this.sendModelSelectionData(w));
  }

  private sendProfileAndModelSelectionData(webview: vscode.Webview) {
    return Effect.andThen(
      this.sendProfileData(webview),
      this.sendModelSelectionData(webview),
    );
  }

  // ============================================================
  // Catalog-derived settings snapshots
  // ============================================================

  /** Post one catalog-derived snapshot. Every field comes from the catalog. */
  private sendSettingsSnapshot(
    webview: vscode.Webview,
    snapshot: DerivedSettingsSnapshot,
  ) {
    return postToWebview(
      webview,
      buildSettingsSnapshotMessage(snapshot, this.session.roots, 'vscode'),
    );
  }

  private rebroadcastSnapshot(snapshot: DerivedSettingsSnapshot) {
    return this.withActiveWebview((w) =>
      this.sendSettingsSnapshot(w, snapshot),
    );
  }

  private sendSkillsList(webview: vscode.Webview) {
    return Effect.flatMap(
      loadRuntimeSkillDisplay(this.session.roots.workspace, this.session.roots),
      (result) =>
        postToWebview(webview, {
          command: SETTINGS_VIEW_COMMANDS.UPDATE_SKILLS_LIST,
          ...result,
        }),
    );
  }

  /**
   * Generic write path for catalog-backed settings-view rows.
   */
  private updateStateSetting(key: string, value: unknown) {
    return Effect.gen({ self: this }, function* () {
      const result = yield* applyStateSettingUpdate(key, value, {
        host: 'vscode',
        stores: this.session.roots,
        // The shared function already gates this hook on
        // `configTarget !== 'global'`; this checks only the workspace half.
        requiresOpenWorkspace: () => !this.session.roots.workspace,
        onApprovalPolicyChanged: (policy) => {
          this.session.setApprovalPolicy(policy);
          appSignals.emit('approvalPolicyChanged', undefined);
        },
      });
      if (result.kind === 'ignored') return;
      const label = result.entry.title ?? result.entry.key;
      if (result.kind === 'rejected') {
        yield* showLoggedErrorMessage(
          this.channel,
          `Invalid value for “${label}”`,
          result.error,
        );
      } else if (result.kind === 'workspace-required') {
        yield* Effect.forkDetach(
          showLoggedInfoMessage(
            this.channel,
            `Open a workspace folder before changing the “${label}” setting.`,
          ),
        );
      } else if (result.kind === 'failed') {
        yield* showLoggedErrorMessage(
          this.channel,
          `Failed to update “${label}”`,
          result.error,
        );
      }
      yield* this.postStateSettingSnapshot(result.entry.surfaces.settingsView);
      if (result.kind !== 'applied') return;
      if (result.entry.onWrite?.invalidatesModelOptions) {
        yield* this.withActiveWebview((w) => this.sendModelSelectionData(w));
        yield* safeExecuteCommand('texra.refreshAllOptions', [], this.viewName);
      }
      if (codingPlanForUsageSetting(key) !== undefined) {
        yield* this.withActiveWebview((w) => this.sendSubscriptionUsage(w));
      }
    });
  }

  /** Fetch and post one sanitized snapshot for every subscription provider. */
  private sendSubscriptionUsage(webview: vscode.Webview, forceRefresh = false) {
    return Effect.flatMap(
      this.subscriptionUsage.getAllUsage({ forceRefresh }),
      (snapshots) =>
        postToWebview(webview, {
          command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE,
          snapshots,
        }),
    );
  }

  private postStateSettingSnapshot(snapshot: SettingsViewSnapshot) {
    const posters: SettingsSnapshotPosters<
      Effect.Effect<void, Error, ProcessServices>
    > = {
      approval: () => this.rebroadcastSnapshot('approval'),
      'git-author': () => this.rebroadcastSnapshot('git-author'),
      latex: () => this.rebroadcastSnapshot('latex'),
      memory: () => this.rebroadcastSnapshot('memory'),
      models: () =>
        this.withActiveWebview((w) => this.sendModelSelectionData(w)),
      'multi-agent': () => this.rebroadcastSnapshot('multi-agent'),
      profile: () => this.withActiveWebview((w) => this.sendProfileData(w)),
      skills: () =>
        Effect.andThen(
          this.rebroadcastSnapshot('skills'),
          this.withActiveWebview((w) => this.sendSkillsList(w)),
        ),
      telemetry: () => this.rebroadcastSnapshot('telemetry'),
    };
    return posters[snapshot]();
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
  private refreshCredentialDependentSurfaces(options: {
    usageProvider?: SubscriptionUsageProvider;
    refreshProfileData: (
      webview: vscode.Webview,
    ) => Effect.Effect<void, Error, ProcessServices>;
  }) {
    return Effect.gen({ self: this }, function* () {
      if (options.usageProvider) {
        this.subscriptionUsage.invalidate(options.usageProvider);
      }
      yield* safeExecuteCommand('texra.refreshApiKeyStatus', [], this.viewName);
      yield* allSettledVoid([
        safeExecuteCommand('texra.refreshAllOptions', [], this.viewName).pipe(
          Effect.asVoid,
        ),
        this.withActiveWebview((w) => options.refreshProfileData(w)),
        ...(options.usageProvider
          ? [this.withActiveWebview((w) => this.sendSubscriptionUsage(w))]
          : []),
      ]);
    });
  }

  /**
   * Refresh main view API key status, model options, and settings-view model/profile
   * data after key changes. Model selection availability depends on provider
   * key state, so keep it paired with the profile refresh.
   */
  public refreshAfterProviderKeyChange(
    provider: string,
  ): Effect.Effect<void, Error, ProcessServices> {
    return Effect.gen({ self: this }, function* () {
      invalidateApiKeyCache();
      const usageProvider = codingPlanForApiProvider(provider)?.usageProvider;
      // The launcher's API-key banner reads the same credential probe from
      // the host snapshot.
      const banners = ProgressViewProvider.getInstance()?.snapshot;
      if (banners) yield* banners.refreshHostBanners;
      yield* this.refreshCredentialDependentSurfaces({
        usageProvider,
        refreshProfileData: (webview) =>
          this.sendProfileAndModelSelectionData(webview),
      });
    });
  }

  /** Subscription auth is a setup credential: same host refresh as API-key changes. */
  private refreshAfterSubscriptionAuthChange(usageProvider?: 'chatgpt') {
    return this.refreshCredentialDependentSurfaces({
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
            ? showLoggedInfoMessage(
                this.channel,
                'This Copilot model is no longer available in VS Code. Refresh the model list and choose another model.',
              )
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
          await this.runtime.runPromise(
            showLoggedInfoMessage(
              this.channel,
              'Copilot access was not granted. TeXRA will leave these models disabled.',
            ),
          );
        } else {
          await this.runtime.runPromise(
            showLoggedErrorMessage(
              this.channel,
              'Could not request Copilot model access',
              new Error(
                Cause.hasInterruptsOnly(result.cause)
                  ? 'The Copilot access request was cancelled.'
                  : Cause.pretty(result.cause),
                { cause: result.cause },
              ),
            ),
          );
        }
      }
    } finally {
      invalidateRuntimeModelRegistry();
      // This arm keeps its own runs: the consent request carries a host
      // deadline as an `AbortSignal`, so it is settled at the boundary above
      // rather than composed into the dispatcher's single run.
      await Promise.all([
        this.runtime.runPromise(
          safeExecuteCommand('texra.refreshAllOptions', [], this.viewName),
        ),
        this.runtime.runPromise(
          this.withActiveWebview((webview) =>
            this.sendModelSelectionData(webview),
          ),
        ),
      ]);
    }
  }

  /** Clear the per-model Copilot route preference (#9659), returning the
   * canonical model to direct-provider routing. */
  private handleClearCopilotRoute(modelName: string) {
    return setCopilotRoutePreference(modelName, false, this.globalState).pipe(
      Effect.andThen(
        allSettledVoid([
          safeExecuteCommand('texra.refreshAllOptions', [], this.viewName).pipe(
            Effect.asVoid,
          ),
          this.withActiveWebview((webview) =>
            this.sendModelSelectionData(webview),
          ),
        ]),
      ),
    );
  }

  /**
   * Refresh settings-view agent list and main-view dropdown after agent
   * mutations. The team presets ride along because every roster mutation can
   * move the effective team: enabling one agent rewrites the selection as
   * `custom`, which retires whatever team was applied.
   */
  private refreshAfterAgentMutation(
    selectedToolUseAgent?: string,
    agentCatalogAlreadyFresh = false,
  ): Effect.Effect<void, Error, ProcessServices> {
    return allSettledVoid([
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
      ).pipe(Effect.asVoid),
    ]);
  }

  // ============================================================
  // Tool dashboard handler implementations
  // ============================================================

  private sendToolDashboardData(
    webview: vscode.Webview,
    options?: { skipChecks?: boolean },
  ) {
    return Effect.gen({ self: this }, function* () {
      const cachedResults = options?.skipChecks
        ? (getLastCheckResults() ?? undefined)
        : undefined;
      const items = yield* buildToolDashboardItems(
        'extension',
        {
          workspaceRoot: this.session.roots.workspace,
          config: this.session.roots.config,
        },
        cachedResults,
      );
      yield* postToWebview(webview, {
        command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
        items,
      });
    });
  }

  private openExternalUrl(url: string) {
    return Effect.tryPromise({
      try: () => vscode.env.openExternal(vscode.Uri.parse(url)),
      catch: ensureError,
    }).pipe(Effect.asVoid);
  }

  private setModelEnabled(modelName: string, enabled: boolean) {
    return this.modelSelectionController
      .setModelEnabled({ modelName, enabled })
      .pipe(
        Effect.andThen(this.postModelSelectionData()),
        // The options cache is invalidated by the writer itself.
        Effect.andThen(
          safeExecuteCommand('texra.refreshAllOptions', [], this.viewName),
        ),
        Effect.asVoid,
      );
  }
}
