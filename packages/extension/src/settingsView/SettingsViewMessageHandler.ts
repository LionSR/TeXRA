/**
 * The extension's half of the settings view: the shared settings body
 * (`createSettingsViewBody`) over VS Code's editor, dialogs and webview, plus
 * the commands only VS Code answers (the TeXRA account commands, the Copilot
 * routes, installing extensions and writing VS Code's LaTeX settings).
 */
import * as path from 'node:path';

import * as vscode from 'vscode';
import { Cause, Effect, Exit, Fiber } from 'effect';
import { ModelError, completedTurn } from '@texra-ai/llm/turn';

import type { SessionHandle } from '@agent/runtime';
import { AUTH_COMMANDS } from '@auth/constants';
import type { SubscriptionProviderId } from '@controllers/modelAccess/subscriptionProviders';
import type { SettingsViewInboundHandlerRegistry } from '@controllers/settingsView/settingsViewDispatch';
import { createSettingsViewBody } from '@controllers/settingsView/sharedSettingsCommands';
import { emitAppSignal } from '@eventBus/AppSignals';
import { signInWithSubscription } from '@frontend/auth/subscriptionSignIn';
import { subscribeAppSignal } from '@frontend/events/appSignalSubscriptions';
import { VscodeExternalOpener } from '@frontend/hosts/VscodeExternalOpener';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { syncInlineCriticism } from '@frontend/latex/inlineCriticism';
import { acquireVscodeLanguageModel } from '@frontend/lm/acquireVscodeLanguageModel';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { selectFolder } from '@frontend/ui/dialogs';
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
import type { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { TEXRA_APPROVAL_POLICY_CONFIG_KEY } from '@shared/approvalPolicy';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  SettingsViewInboundMessageSchema,
  type SettingsViewOutboundMessage,
} from '@shared/settingsView/settingsViewMessages';
import { loadRuntimeSkillDisplay } from '@skills/runtimeSkills';
import { ACCOUNT_OUTCOME } from '@ui/copy/accountAuth';
import { allSettledVoid } from '@utils/core/allSettledVoid';
import { hasExtension } from '@utils/core/pathCore';
import { ensureError } from '@utils/errors/errorMessage';
import { normalizeLineEndings } from '@utils/text/stringUtils';
import {
  latexRecommendedStatus,
  vscodeLatexSettingsHandlers,
} from './handlers/latexSettingsHandlers';

/** The webview shapes SettingsView dispatches for. */
type SettingsWebview = vscode.WebviewView | vscode.WebviewPanel;

/**
 * The one foreign edge under this view's transport: VS Code's own
 * `postMessage`, lifted once for every outbound settings message. A panel
 * disposed mid-post rejects it, and that reaches the program as a failure
 * instead of an unhandled rejection. The message is typed as the union the
 * webview validates, not `unknown`, so a builder's Effect passed without
 * `yield*` is a compile error rather than a serialized Effect it drops.
 */
export function postToWebview(
  webview: vscode.Webview,
  message: SettingsViewOutboundMessage,
): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      await webview.postMessage(message);
    },
    catch: ensureError,
  });
}

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

  constructor(
    context: vscode.ExtensionContext,
    private readonly globalState: StateStore,
    secrets: PlatformSecrets,
    private readonly runtime: ProcessRuntime,
    private readonly session: SessionHandle,
    private readonly progressView: Pick<
      ProgressViewProvider,
      'refreshCatalogs' | 'refreshApiKeyStatus' | 'revealRun' | 'runLabel'
    >,
  ) {
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
        // An untitled buffer holds the text, so Ctrl+S prompts for a new
        // location instead of writing back over the source.
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
        // The launcher's API-key banner reads the same credential probe from
        // the host snapshot; the funnel follows the banner.
        refreshCredentialStatus: progressView.refreshApiKeyStatus,
        signInSubscription: (providerId) =>
          Effect.asVoid(
            signInWithSubscription(session.roots, this.channel, providerId),
          ),
        revealRun: (runId) => progressView.revealRun(runId),
        runLabel: (runId) => progressView.runLabel(runId),
        // The status-bar tooltip paints the approval policy outside this
        // view's round-trip, so it follows the policy on its own signal.
        stateSettingApplied: (key) => {
          if (key === GlobalStateKey.INLINE_CRITICISM_ENABLED) {
            return syncInlineCriticism();
          }
          if (key !== TEXRA_APPROVAL_POLICY_CONFIG_KEY) return Effect.void;
          return Effect.sync(() =>
            emitAppSignal('approvalPolicyChanged', undefined),
          );
        },
        runInTerminal: (name, command) =>
          Effect.sync(() => {
            const terminal = vscode.window.createTerminal({ name });
            terminal.show();
            terminal.sendText(command);
          }),
        latexRecommendedStatus,
        requiresOpenWorkspace: () => !session.roots.workspace,
      },
    });
    this.handlerRegistry = this.createHandlerRegistry(context);

    const { repaintOn, settle } = this.body;
    const following = runtime.runFork(this.body.followToolAvailability);
    context.subscriptions.push(
      { dispose: () => runtime.runFork(Fiber.interrupt(following)) },
      ...(Object.keys(repaintOn) as Array<keyof typeof repaintOn>).map(
        (signal) =>
          subscribeAppSignal(runtime, signal, (payload) => {
            const work = repaintOn[signal](payload as never);
            if (work) runtime.runFork(settle(work));
          }),
      ),
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
      signIn: () =>
        safeExecuteCommand(AUTH_COMMANDS.SIGN_IN, [], this.viewName),
      signOut: () =>
        safeExecuteCommand(AUTH_COMMANDS.SIGN_OUT, [], this.viewName),
      requestModelAccess: (message) =>
        this.handleRequestModelAccess(message.modelName, context),
      clearCopilotRoute: (message) =>
        this.handleClearCopilotRoute(message.modelName),
      ...vscodeLatexSettingsHandlers(this.body),
    };
  }

  /** Clear the tracked active view. */
  public clearActiveView(): void {
    this.activeView = undefined;
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
   * Validate at the webview edge and settle the selected program; the host's
   * event listener is the one boundary that runs it.
   */
  public handleMessage(
    message: unknown,
    webviewView: SettingsWebview,
  ): Effect.Effect<void, never, ProcessServices> {
    return Effect.suspend(() => {
      this.activeView = webviewView;
      const parsed = SettingsViewInboundMessageSchema.safeParse(message);
      return parsed.success
        ? this.body.handleMessage(parsed.data, this.handlerRegistry)
        : Effect.logDebug('Message validation failed').pipe(
            Effect.annotateLogs({ data: message, error: parsed.error.message }),
            withLogChannel(this.channel),
          );
    });
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
                yield* completedTurn(model.streamTurn(turn));
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
}
