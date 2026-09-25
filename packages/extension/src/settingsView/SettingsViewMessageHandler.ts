/**
 * The extension's half of the settings view: the shared settings body
 * (`createSettingsViewBody`) over VS Code's editor, dialogs and webview, plus
 * the commands only VS Code answers (the TeXRA account commands, the Copilot
 * routes, the Tools and LaTeX pages).
 */
import * as path from 'node:path';

import * as vscode from 'vscode';
import { Cause, Effect, Exit, Fiber } from 'effect';
import { ModelError } from '@texra-ai/llm/turn';

import type { SessionHandle } from '@agent/runtime';
import { refresh as refreshAgentCatalog } from '@agent/index';
import { AUTH_COMMANDS } from '@auth/constants';
import { supabaseAuthenticated } from '@auth/SupabaseAuth';
import type { SubscriptionProviderId } from '@controllers/modelAccess/subscriptionProviders';
import type { SettingsViewInboundHandlerRegistry } from '@controllers/settingsView/settingsViewDispatch';
import {
  buildToolDashboardItems,
  planToolTerminalAction,
} from '@controllers/settingsView/ToolDashboardData';
import { createSettingsViewBody } from '@controllers/settingsView/sharedSettingsCommands';
import { emitAppSignal } from '@eventBus/AppSignals';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { withAgentCatalogAuthRefreshDeferred } from '@frontend/auth/agentCatalogRefreshScope';
import { runSignInCommand } from '@frontend/auth/signInCommand';
import { signInWithSubscription } from '@frontend/auth/subscriptionSignIn';
import { subscribeAppSignal } from '@frontend/events/appSignalSubscriptions';
import { VscodeExternalOpener } from '@frontend/hosts/VscodeExternalOpener';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { syncInlineCriticism } from '@frontend/latex/inlineCriticism';
import { acquireVscodeLanguageModel } from '@frontend/lm/acquireVscodeLanguageModel';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import {
  chooseTeamAvailabilityViaDialog,
  selectFolder,
} from '@frontend/ui/dialogs';
import {
  showLoggedErrorMessage,
  showLoggedInfoMessage,
} from '@frontend/ui/errorHandlingUtils';
import { withLogChannel } from '@logger/effectLog';
import {
  discoverCopilotRoutes,
  setCopilotRoutePreference,
} from '@model/copilotRouting';
import type { StateStore } from '@platform/interfaces';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import type { StorageFs } from '@platform/rootedFs';
import type { PlatformSecrets } from '@platform/secrets';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import {
  getProgressRunLabel,
  revealProgressRun,
} from '@progressView/progressNavigation';
import { TEXRA_APPROVAL_POLICY_CONFIG_KEY } from '@shared/approvalPolicy';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { ToolDashboardItem } from '@shared/settingsView/settingsViewMessages';
import { loadRuntimeSkillDisplay } from '@skills/runtimeSkills';
import { getLastCheckResults } from '@tools/toolAvailability';
import { ACCOUNT_OUTCOME } from '@ui/copy/accountAuth';
import { setToolEnabled } from '@utils/config/constants';
import { allSettledVoid } from '@utils/core/allSettledVoid';
import { hasExtension } from '@utils/core/pathCore';
import { ensureError } from '@utils/errors/errorMessage';
import { normalizeLineEndings } from '@utils/text/stringUtils';
import { LatexSettingsHandlers } from './handlers/latexSettingsHandlers';
import {
  postToWebview,
  type SettingsHandlerContext,
} from './handlers/SettingsHandlerContext';

/** The webview shapes SettingsView dispatches for. */
type SettingsWebview = vscode.WebviewView | vscode.WebviewPanel;

/** Show `document` in an editor tab of its own. */
const showDocument = (
  document: () => Thenable<vscode.TextDocument>,
): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: async () => {
      await vscode.window.showTextDocument(await document(), {
        preview: false,
      });
    },
    catch: ensureError,
  });

export class SettingsViewMessageHandler {
  private readonly viewName = 'SettingsView';
  private readonly channel = `${this.viewName}MessageHandler`;

  /** Active webview reference, tracked on every dispatch. */
  private activeView: SettingsWebview | undefined;

  private readonly handlerRegistry: SettingsViewInboundHandlerRegistry<
    ProcessServices | StorageFs
  >;
  private readonly body: ReturnType<typeof createSettingsViewBody>;
  private readonly latexHandlers: LatexSettingsHandlers;

  constructor(
    context: vscode.ExtensionContext,
    private readonly globalState: StateStore,
    secrets: PlatformSecrets,
    private readonly runtime: ProcessRuntime,
    private readonly session: SessionHandle,
    private readonly progressView: Pick<
      ProgressViewProvider,
      'refreshCatalogs' | 'refreshApiKeyStatus' | 'refreshOnboardingFunnel'
    >,
  ) {
    const ctx: SettingsHandlerContext = {
      channel: this.channel,
      withActiveWebview: (fn) => this.withActiveWebview(fn),
    };
    this.latexHandlers = new LatexSettingsHandlers(ctx, runtime);
    this.body = createSettingsViewBody({
      host: 'vscode',
      session,
      secrets,
      resourcesPath: path.join(context.extensionPath, 'resources'),
      skillDisplay: loadRuntimeSkillDisplay(
        session.roots.workspace,
        session.roots,
      ),
      accountCopy: ACCOUNT_OUTCOME,
      bindings: {
        post: (message) =>
          this.withActiveWebview((webview) =>
            Effect.flatMap(message, (built) => postToWebview(webview, built)),
          ),
        notify: vscodeUi,
        prompt: vscodeUi,
        externalOpener: new VscodeExternalOpener(),
        // Markdown opens in preview mode, the read-only rendered view.
        openPath: (filePath) =>
          hasExtension(filePath, '.md')
            ? safeExecuteCommand(
                'markdown.showPreview',
                [vscode.Uri.file(filePath)],
                this.viewName,
              ).pipe(Effect.asVoid)
            : showDocument(() => vscode.workspace.openTextDocument(filePath)),
        revealPath: (filePath) =>
          Effect.tryPromise({
            try: () =>
              vscode.commands.executeCommand(
                'revealFileInOS',
                vscode.Uri.file(filePath),
              ),
            catch: ensureError,
          }),
        // An untitled buffer, so Ctrl+S never writes back over the source.
        showReadOnlyYaml: (_fileName, text) =>
          showDocument(() =>
            vscode.workspace.openTextDocument({
              content: normalizeLineEndings(text),
              language: 'yaml',
            }),
          ),
        pickFolder: (title) =>
          Effect.map(
            selectFolder({ title, openLabel: 'Select Folder' }),
            (selected) => selected ?? undefined,
          ),
        refreshCatalogs: (selectedToolUseAgent) =>
          progressView
            .refreshCatalogs({
              agentCatalogAlreadyFresh: true,
              selectedToolUseAgent,
            })
            .pipe(Effect.asVoid),
        // The launcher's API-key banner reads this probe from the snapshot.
        refreshCredentialStatus: Effect.suspend(() =>
          Effect.all(
            [
              ProgressViewProvider.getInstance()?.snapshot.refreshHostBanners ??
                Effect.void,
              progressView.refreshApiKeyStatus,
              progressView.refreshOnboardingFunnel(),
            ],
            { discard: true },
          ),
        ),
        signInSubscription: (providerId) =>
          Effect.asVoid(
            signInWithSubscription(session.roots, this.channel, providerId),
          ),
        createAgentWithAI: (category) =>
          Effect.tryPromise({
            try: () =>
              vscode.commands.executeCommand(
                'texra.createAgentWithAI',
                category,
              ),
            catch: ensureError,
          }),
        customAgentDirChanged: Effect.gen(function* () {
          yield* agentDirectories.refreshAfterDirChange();
          const { refreshCustomAgentRoot } = yield* Effect.promise(
            () => import('@frontend/setup'),
          );
          yield* refreshCustomAgentRoot();
        }),
        remoteCatalog: {
          canAccess: () => supabaseAuthenticated,
          signIn: runSignInCommand,
        },
        chooseTeamAvailability: (prompt) =>
          chooseTeamAvailabilityViaDialog(prompt, { modal: true }),
        revealRun: revealProgressRun,
        runLabel: getProgressRunLabel,
        // The status-bar tooltip follows the approval policy on its signal.
        stateSettingApplied: (key) => {
          if (key === GlobalStateKey.INLINE_CRITICISM_ENABLED) {
            return syncInlineCriticism();
          }
          if (key !== TEXRA_APPROVAL_POLICY_CONFIG_KEY) return Effect.void;
          return Effect.sync(() =>
            emitAppSignal('approvalPolicyChanged', undefined),
          );
        },
        postHostStartup: Effect.gen({ self: this }, function* () {
          // The dashboard probes the network (Zotero, …) on a detached fiber
          // off the first render; a failed build still posts an empty one to
          // end the view's spinner.
          yield* Effect.forkDetach(
            this.sendToolDashboardData().pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  'The tool dashboard could not be built; showing it empty.',
                ).pipe(
                  Effect.annotateLogs({ data: error }),
                  withLogChannel(this.channel),
                  Effect.andThen(this.postToolDashboard([])),
                ),
              ),
              Effect.ignore({
                log: 'Warn',
                message: 'The empty tool dashboard could not be posted either.',
              }),
            ),
            { startImmediately: true },
          );
          yield* this.withActiveWebview((webview) =>
            this.latexHandlers.sendLatexSettingsStatus(webview),
          );
        }),
        requiresOpenWorkspace: () => !session.roots.workspace,
      },
    });
    this.handlerRegistry = this.createHandlerRegistry(context);

    const { repaintOn, settle } = this.body;
    context.subscriptions.push(
      ...(Object.keys(repaintOn) as Array<keyof typeof repaintOn>).map(
        (signal) =>
          subscribeAppSignal(runtime, signal, (payload) => {
            const work = repaintOn[signal](payload as never);
            if (work) runtime.runFork(settle(work));
          }),
      ),
      subscribeAppSignal(runtime, 'toolAvailabilityChanged', () => {
        runtime.runFork(this.sendToolDashboardData({ skipChecks: true }));
      }),
    );
  }

  /**
   * Sign in to a subscription provider from outside the settings webview,
   * through the same program the Models page's sign-in button runs, so the
   * command palette gets the status round-trip and credential refresh tail.
   */
  public signInSubscription(providerId: SubscriptionProviderId) {
    return this.body.signInSubscription(providerId);
  }

  /** Repaint every credential-dependent surface after an API-key change. */
  public refreshAfterProviderKeyChange(
    provider: string,
  ): Effect.Effect<void, Error, ProcessServices> {
    return this.body.refreshAfterProviderKeyChange(provider);
  }

  /** Repaint what a TeXRA account change touches. */
  public readonly refreshAfterAuthChange = () =>
    this.body.refreshAfterAuthChange();

  /** Every page's opening data, posted to the active view. */
  public readonly sendAllData = () => this.body.postAll;

  private createHandlerRegistry(
    context: vscode.ExtensionContext,
  ): SettingsViewInboundHandlerRegistry<ProcessServices | StorageFs> {
    return {
      ...this.body.handlers,
      // The team preflight's catalog fetch holds the auth listeners off.
      applyAgentModePreset: (message) =>
        withAgentCatalogAuthRefreshDeferred(
          this.body.handlers.applyAgentModePreset(message),
        ),
      signIn: () =>
        safeExecuteCommand(AUTH_COMMANDS.SIGN_IN, [], this.viewName),
      signOut: () =>
        safeExecuteCommand(AUTH_COMMANDS.SIGN_OUT, [], this.viewName),
      requestModelAccess: (message) =>
        this.handleRequestModelAccess(message.modelName, context),
      clearCopilotRoute: (message) =>
        this.handleClearCopilotRoute(message.modelName),
      installToolExtension: (message) =>
        this.latexHandlers.installExtension(message.extensionId),
      toggleTool: (message) =>
        setToolEnabled(message.toolId, message.enabled, this.globalState).pipe(
          // A plugin's bundled agents follow its switch.
          Effect.andThen(refreshAgentCatalog()),
          Effect.andThen(this.sendToolDashboardData({ skipChecks: true })),
        ),
      runToolCommand: (data) => {
        const action = planToolTerminalAction({
          toolId: data.toolId,
          commandKind: data.kind,
        });
        if (action.kind === 'none') {
          return Effect.logDebug('No command for tool').pipe(
            Effect.annotateLogs({ data: { ...data, reason: action.reason } }),
            withLogChannel(this.channel),
          );
        }
        return Effect.sync(() => {
          const terminal = vscode.window.createTerminal({ name: action.name });
          terminal.show();
          terminal.sendText(action.command);
        });
      },
      ...this.latexHandlers.handlers,
    };
  }

  /** Clear the tracked active view. */
  public clearActiveView(): void {
    this.activeView = undefined;
  }

  /**
   * Run a program with the active webview, read when the program runs (not
   * when built): a panel disposed before its refresh leaves nothing to post.
   */
  private withActiveWebview<E, R>(
    fn: (webview: vscode.Webview) => Effect.Effect<void, E, R>,
  ): Effect.Effect<void, E, R> {
    return Effect.suspend(() => {
      const view = this.activeView;
      return view ? fn(view.webview) : Effect.void;
    });
  }

  /** Validate at the webview edge and run the selected program once. */
  public handleMessage(
    message: unknown,
    webviewView: SettingsWebview,
  ): Promise<void> {
    this.activeView = webviewView;
    const program =
      this.body.handleMessage(message, this.handlerRegistry) ??
      Effect.logDebug('Message validation failed').pipe(
        Effect.annotateLogs({ data: message }),
        withLogChannel(this.channel),
      );
    return this.runtime.runPromise(program);
  }

  private handleRequestModelAccess(
    modelName: string,
    context: vscode.ExtensionContext,
  ) {
    return Effect.gen({ self: this }, function* () {
      // Discover now: authorization acts only on the route the editor
      // reports for this request, and a failed probe fails the program.
      const discovery = yield* Effect.exit(
        Effect.map(discoverCopilotRoutes(), (routes) => routes.get(modelName)),
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
        // A host dialog or a state write; the boundary composes the choice.
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
    }).pipe(Effect.ensuring(this.refreshCopilotRoutes().pipe(Effect.orDie)));
  }

  /** Clear the per-model Copilot route preference (#9659), returning the
   * canonical model to direct-provider routing. */
  private handleClearCopilotRoute(modelName: string) {
    return setCopilotRoutePreference(modelName, false, this.globalState).pipe(
      Effect.andThen(this.refreshCopilotRoutes()),
    );
  }

  private refreshCopilotRoutes() {
    return allSettledVoid<Error, ProcessServices>([
      this.progressView.refreshCatalogs().pipe(Effect.asVoid),
      this.body.postModelSelection,
    ]);
  }

  // ============================================================
  // Tools page
  // ============================================================

  private postToolDashboard(items: ToolDashboardItem[]) {
    return this.withActiveWebview((webview) =>
      postToWebview(webview, {
        command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
        items,
      }),
    );
  }

  private sendToolDashboardData(options?: { skipChecks?: boolean }) {
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
      yield* this.postToolDashboard(items);
    });
  }
}
