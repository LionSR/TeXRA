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
import { Cause, Effect, Exit, Fiber } from 'effect';
import { ModelError } from '@texra-ai/llm/turn';

// Shared schemas and dispatchers
import type { SessionHandle } from '@agent/runtime';
import { AUTH_COMMANDS } from '@auth/constants';
import {
  settingsViewProgram,
  type SettingsViewInboundHandlerRegistry,
} from '@controllers/settingsView/settingsViewDispatch';
import { SettingsMemoryController } from '@controllers/settingsView/SettingsMemoryController';
import { SettingsModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionController';
import { SubscriptionUsageService } from '@controllers/modelAccess/subscriptionUsage/SubscriptionUsageService';
import type { SubscriptionProviderId } from '@controllers/modelAccess/subscriptionProviders';
import {
  buildToolDashboardItems,
  planToolTerminalAction,
} from '@controllers/settingsView/ToolDashboardData';
import { SettingsProfileKeyController } from '@controllers/settingsView/SettingsProfileKeyController';
import { sharedSettingsCommands } from '@controllers/settingsView/sharedSettingsCommands';
import { SettingsProfileController } from '@controllers/settingsView/SettingsProfileController';
import { emitAppSignal } from '@eventBus/AppSignals';
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
import { subscribeAppSignal } from '@frontend/events/appSignalSubscriptions';
import { subscribeGoalStateChanges } from '@frontend/events/runFactSubscriptions';
import { withLogChannel } from '@logger/effectLog';
import { createLog, type Log } from '@logger/logUtils';
import {
  modelOptionsFrom,
  readModelAvailabilityInputs,
} from '@model/computeModelOptions';
import {
  API_PROVIDERS,
  apiProviderOfSecretName,
  loadApiKeyStatusMap,
} from '@model/apiProviders';
import {
  invalidateRuntimeModelRegistry,
  copilotRouteForModel,
  discoveredCopilotRoutes,
  refreshRuntimeModelRegistry,
} from '@model/runtimeModelRegistry';
import { setCopilotRoutePreference } from '@model/copilotRouting';
import { withSessionFs } from '@platform/rootedFs';
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
import type { SubscriptionUsageProvider } from '@shared/schemas';
import type { SettingsViewSnapshot } from '@shared/state/stateSettings';
import type {
  DerivedSettingsSnapshot,
  SettingsMessageFor,
} from '@shared/settingsView/settingsViewMessages';
import { SettingsViewInboundMessageSchema } from '@shared/settingsView/settingsViewMessages';

import {
  applyStateSettingUpdate,
  type SettingsSnapshotPosters,
} from '@shared/settingsView/handlers/stateSettingWrite';

import {
  UnsupportedCommandError,
  unsupportedCommands,
} from '@shared/utils/dispatcher';
import { buildSettingsSnapshotMessage } from '@shared/settingsView/handlers/settingsSnapshot';
import { loadRuntimeSkillDisplay } from '@skills/runtimeSkills';
import { getLastCheckResults } from '@tools/toolAvailability';
import { goalList } from '@tools/goal';
import { getProviderKeyUrl } from '@utils/config/providerConfig';
import { allSettledVoid } from '@utils/core/allSettledVoid';
import { setToolEnabled } from '@utils/config/constants';
import { ensureError } from '@utils/errors/errorMessage';
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
  private readonly externalOpener = new VscodeExternalOpener();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly globalState: StateStore,
    secrets: PlatformSecrets,
    private readonly runtime: ProcessRuntime,
    private readonly session: SessionHandle,
    private readonly progressView: Pick<
      ProgressViewProvider,
      'refreshCatalogs' | 'refreshApiKeyStatus' | 'refreshOnboardingFunnel'
    >,
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
      externalOpener: this.externalOpener,
      getProviderDisplayName: (provider) =>
        this.profileController.getProviderDisplayName(provider),
      getProviderKeyUrl: (provider) =>
        getProviderKeyUrl(session.roots, provider),
      refreshAfterKeyChange: (provider) =>
        this.refreshAfterProviderKeyChange(provider),
    });
    this.agentHandlers = new AgentHandlers(
      ctx,
      (selectedToolUseAgent, agentCatalogAlreadyFresh) =>
        this.refreshAfterAgentMutation(
          selectedToolUseAgent,
          agentCatalogAlreadyFresh,
        ),
      session.roots,
      () => this.progressView.refreshCatalogs(),
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
      subscribeAppSignal(this.runtime, 'githubSubscriptionsChanged', () => {
        this.runtime.runFork(
          this.withActiveWebview((w) =>
            this.githubHandlers.sendPRSubscriptions(w),
          ),
        );
      }),
      subscribeAppSignal(this.runtime, 'toolAvailabilityChanged', () => {
        this.runtime.runFork(
          this.withActiveWebview((w) =>
            this.sendToolDashboardData(w, { skipChecks: true }),
          ),
        );
      }),
      // `apply_team` writes the roster straight from the setup agent, so the
      // open view is showing agents and a team it just replaced. The catalog
      // is already fresh: a team change moves no agent files, and the
      // agent-creator reloads before it emits. Without that flag this listener
      // would rescan the YAML and re-fetch the remote catalog on every roster
      // write.
      subscribeAppSignal(this.runtime, 'agentRosterChanged', () => {
        this.runtime.runFork(this.refreshAfterAgentMutation(undefined, true));
      }),
      // Every provider-key writer lands here, not just this view's own
      // round-trip: the setup agent's `unset_api_key`, the command palette,
      // another window. An OAuth or GitHub token write is not a provider key.
      subscribeAppSignal(this.runtime, 'credentialChanged', ({ key }) => {
        const provider = apiProviderOfSecretName(key);
        if (provider === undefined) return;
        this.runtime.runFork(this.refreshAfterProviderKeyChange(provider));
      }),
      subscribeAppSignal(this.runtime, 'languageModelsChanged', () => {
        this.runtime.runFork(
          this.withActiveWebview((webview) =>
            this.sendModelSelectionData(webview),
          ),
        );
      }),
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

  /** Each command builds a program; the message entry runs the selected one. */
  private createHandlerRegistry(
    context: vscode.ExtensionContext,
  ): SettingsViewInboundHandlerRegistry {
    return {
      webviewReady: () => this.withActiveWebview((w) => this.sendAllData(w)),
      ...this.memoryHandlers.handlers,
      signIn: () =>
        safeExecuteCommand(AUTH_COMMANDS.SIGN_IN, [], this.viewName),
      signOut: () =>
        safeExecuteCommand(AUTH_COMMANDS.SIGN_OUT, [], this.viewName),
      ...sharedSettingsCommands({
        profileKeys: this.profileKeyController,
        modelSelection: this.modelSelectionController,
        externalOpener: this.externalOpener,
        toolProbes: {
          workspaceRoot: this.session.roots.workspace,
          config: this.session.roots.config,
        },
        host: {
          postModelSelection: () =>
            this.withActiveWebview((w) => this.sendModelSelectionData(w)),
          refreshModelCatalog: () =>
            this.progressView.refreshCatalogs().pipe(Effect.asVoid),
          // A failed key write leaves the profile and the Models tab showing
          // the key as it was before the attempt. The error dialog is the
          // report: a repaint that fails after it (a view closed meanwhile)
          // is logged, not raised as a second, generic dialog.
          reportProviderKeyFailure: (error) =>
            Effect.andThen(
              showLoggedErrorMessage(this.channel, error.message, error.cause),
              this.withActiveWebview((w) =>
                this.sendProfileAndModelSelectionData(w),
              ).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning(
                    'Could not repaint the profile after a failed key write',
                  ).pipe(
                    Effect.annotateLogs({ data: cause }),
                    withLogChannel(this.channel),
                  ),
                ),
              ),
            ),
        },
      }),
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
      ...this.githubHandlers.handlers,
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
      installToolExtension: (message) =>
        this.latexHandlers.installExtension(message.extensionId),
      toggleTool: (message) =>
        setToolEnabled(message.toolId, message.enabled, this.globalState).pipe(
          Effect.andThen(
            this.withActiveWebview((w) =>
              this.sendToolDashboardData(w, { skipChecks: true }),
            ),
          ),
        ),
      runToolCommand: (message) =>
        Effect.sync(() => this.handleRunToolCommand(message)),
      ...this.latexHandlers.handlers,
      getInlineCriticismEnabled: () =>
        this.withActiveWebview((w) => this.sendInlineCriticismEnabled(w)),
      setInlineCriticismEnabled: (message) =>
        setInlineCriticismEnabled(message.enabled).pipe(
          Effect.andThen(
            this.withActiveWebview((w) => this.sendInlineCriticismEnabled(w)),
          ),
        ),
      getGoalList: () => this.withActiveWebview((w) => this.sendGoalList(w)),
      revealGoalRun: (message) =>
        revealProgressRun(message.runId).pipe(Effect.asVoid),
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
          catch: ensureError,
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
    data: SettingsMessageFor<typeof SETTINGS_VIEW_COMMANDS.RUN_TOOL_COMMAND>,
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

  /** Validate at the webview edge and run the selected program once. */
  public handleMessage(
    message: unknown,
    webviewView: SettingsWebview,
  ): Promise<void> {
    this.activeView = webviewView;
    const parsed = SettingsViewInboundMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.log.debug('Message validation failed', { data: parsed.error });
      return Promise.resolve();
    }
    return this.runtime.runPromise(
      withSessionFs(
        this.session.roots,
        settingsViewProgram(parsed.data, this.handlerRegistry),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.gen({ self: this }, function* () {
            if (Cause.hasInterruptsOnly(cause)) return;
            const error = Cause.squash(cause);
            const report = Effect.gen({ self: this }, function* () {
              if (error instanceof UnsupportedCommandError) {
                yield* vscodeUi.showInfoMessage(error.reason);
              } else {
                this.log.error('Error handling message', { data: error });
                yield* vscodeUi.showErrorMessage(
                  `TeXRA could not handle a ${this.viewName} message. See the TeXRA output for details.`,
                );
              }
            });
            const reported = yield* Effect.exit(report);
            if (
              Exit.isFailure(reported) &&
              !Cause.hasInterruptsOnly(reported.cause)
            ) {
              this.log.error('Failed to report settings message error', {
                data: Cause.squash(reported.cause),
              });
            }
          }),
        ),
        Effect.asVoid,
      ),
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
      // shows a loading spinner until data arrives, so a failed build still
      // posts an empty dashboard to end it, and nothing joins this fiber, so
      // each failure is logged on it.
      yield* Effect.forkDetach(
        this.sendToolDashboardData(webview).pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              'The tool dashboard could not be built; showing it empty.',
            ).pipe(
              Effect.annotateLogs({ data: error }),
              withLogChannel(this.channel),
              Effect.andThen(
                postToWebview(webview, {
                  command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
                  items: [],
                }),
              ),
            ),
          ),
          Effect.ignore({
            log: 'Warn',
            message: 'The empty tool dashboard could not be posted either.',
          }),
        ),
        { startImmediately: true },
      );

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
    return Effect.flatMap(isInlineCriticismEnabled(), (enabled) =>
      postToWebview(webview, {
        command: SETTINGS_VIEW_COMMANDS.UPDATE_INLINE_CRITICISM_ENABLED,
        enabled,
      }),
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
          emitAppSignal('approvalPolicyChanged', undefined);
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
        yield* this.progressView.refreshCatalogs();
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
   * auth): drop the cached usage, refresh status and catalogs, and push
   * fresh profile/model/usage data to the active webview. Model selection
   * availability depends on key state, so status and onboarding refresh finish
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
      yield* Effect.andThen(
        this.progressView.refreshApiKeyStatus,
        this.progressView.refreshOnboardingFunnel(),
      );
      yield* allSettledVoid([
        this.progressView.refreshCatalogs().pipe(Effect.asVoid),
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

  private handleRequestModelAccess(
    modelName: string,
    context: vscode.ExtensionContext,
  ) {
    return Effect.gen({ self: this }, function* () {
      const discovery = yield* Effect.exit(
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
        result = yield* Effect.scoped(
          Effect.gen(function* () {
            // Await this fiber's complete exit: timeoutOrElse discards a release
            // defect when its timeout wins, but native consent must retain it.
            const pending = yield* Effect.forkScoped(
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
            );
            yield* Effect.forkScoped(
              Effect.sleep(120_000).pipe(
                Effect.andThen(Fiber.interrupt(pending)),
              ),
            );
            return yield* Fiber.await(pending);
          }),
        );
      }
      if (Exit.isSuccess(result)) {
        // Two different programs: the notice is a host dialog, the preference
        // is a state write. The boundary composes whichever it chose.
        const settle: Effect.Effect<unknown, Error> =
          !route || route.access === 'unavailable'
            ? showLoggedInfoMessage(
                this.channel,
                'This Copilot model is no longer available in VS Code. Refresh the model list and choose another model.',
              )
            : setCopilotRoutePreference(modelName, true, this.globalState);
        result = yield* Effect.exit(settle);
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
          yield* showLoggedInfoMessage(
            this.channel,
            'Copilot access was not granted. TeXRA will leave these models disabled.',
          );
        } else {
          yield* showLoggedErrorMessage(
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
    }).pipe(
      Effect.ensuring(
        Effect.gen({ self: this }, function* () {
          invalidateRuntimeModelRegistry();
          yield* allSettledVoid([
            this.progressView.refreshCatalogs(),
            this.withActiveWebview((webview) =>
              this.sendModelSelectionData(webview),
            ),
          ]).pipe(Effect.orDie);
        }),
      ),
    );
  }

  /** Clear the per-model Copilot route preference (#9659), returning the
   * canonical model to direct-provider routing. */
  private handleClearCopilotRoute(modelName: string) {
    return setCopilotRoutePreference(modelName, false, this.globalState).pipe(
      Effect.andThen(
        allSettledVoid([
          this.progressView.refreshCatalogs().pipe(Effect.asVoid),
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
      this.progressView
        .refreshCatalogs({ selectedToolUseAgent, agentCatalogAlreadyFresh })
        .pipe(Effect.asVoid),
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
        ? (getLastCheckResults(this.session.roots.workspace) ?? undefined)
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
}
