/**
 * The extension's half of the settings view: the shared settings body
 * (`createSettingsViewBody`) over VS Code's editor, dialogs and webview, plus
 * the commands only VS Code answers (installing extensions and writing VS
 * Code's LaTeX settings).
 */
import * as path from 'node:path';

import * as vscode from 'vscode';
import { Effect, Fiber, Result, Schema } from 'effect';

import { Skills, hasExtension } from '@texra-ai/harness';
import {
  APPROVAL_POLICY_CONFIG_KEY,
  ensureError,
} from '@texra-ai/harness/schemas';
import { emitAppSignal, onAppSignal } from '@eventBus/AppSignals';
import { VscodeExternalOpener } from '@frontend/hosts/VscodeExternalOpener';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { syncInlineCriticism } from '@frontend/latex/inlineCriticism';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { selectFolder } from '@frontend/ui/dialogs';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { signInWithSubscription } from '@frontend/auth/subscriptionSignIn';
import type { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { TexraStateKey } from '@texra/shared/settingsView/texraSettings';
import {
  SettingsViewInboundMessageSchema,
  type SettingsViewOutboundMessage,
} from '@texra/shared/settingsView/settingsViewMessages';
import { createSettingsViewBody } from '@texra/controllers/settingsView/sharedSettingsCommands';
import type { SettingsViewInboundHandlerRegistry } from '@texra/controllers/settingsView/settingsViewDispatch';
import { ACCOUNT_OUTCOME } from '@ui/copy/accountAuth';
import {
  latexEditorStatus,
  vscodeLatexSettingsHandlers,
} from './handlers/latexSettingsHandlers';
import type {
  StorageFs,
  ProcessRuntime,
  ProcessServices,
  PlatformSecrets,
  WorkspaceRoots,
} from '@texra-ai/harness';

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
  /** The shared settings body: its programs, handlers and repaints. */
  readonly body: ReturnType<typeof createSettingsViewBody>;

  constructor(
    context: vscode.ExtensionContext,
    secrets: PlatformSecrets,
    runtime: ProcessRuntime,
    roots: WorkspaceRoots,
    progressView: Pick<
      ProgressViewProvider,
      'refreshCatalogs' | 'refreshApiKeyStatus' | 'revealRun' | 'runLabel'
    >,
  ) {
    this.body = createSettingsViewBody({
      host: 'vscode',
      roots,
      secrets,
      resourcesPath: path.join(context.extensionPath, 'resources'),
      skillDisplay: Skills.display(roots),
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
              content: text.replaceAll('\r\n', '\n'),
              language: 'yaml',
            }),
          ),
        pickFolder: (title) =>
          Effect.map(
            selectFolder({ title, openLabel: 'Select Folder' }),
            (selected) => selected ?? undefined,
          ),
        refreshCatalogs: (selectedAgent) =>
          progressView.refreshCatalogs({
            agentCatalogAlreadyFresh: true,
            selectedAgent,
          }),
        // The launcher's API-key banner reads the same credential probe from
        // the host snapshot; the funnel follows the banner.
        refreshCredentialStatus: progressView.refreshApiKeyStatus,
        signInSubscription: (providerId) =>
          Effect.asVoid(
            signInWithSubscription(roots, this.channel, providerId),
          ),
        revealRun: (runId) => progressView.revealRun(runId),
        runLabel: (runId) => progressView.runLabel(runId),
        // The status-bar tooltip paints the approval policy outside this
        // view's round-trip, so it follows the policy on its own signal.
        stateSettingApplied: (key) => {
          if (key === TexraStateKey.INLINE_CRITICISM_ENABLED) {
            return syncInlineCriticism();
          }
          if (key !== APPROVAL_POLICY_CONFIG_KEY) return Effect.void;
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
        latexEditorStatus,
        requiresOpenWorkspace: () => !roots.workspace,
      },
    });
    this.handlerRegistry = {
      ...this.body.handlers,
      ...vscodeLatexSettingsHandlers(this.body),
    };

    // One fiber owns the tool-availability follower and every repaint
    // subscription; each child starts at once so it is subscribed before the
    // constructor returns, and disposing interrupts them all.
    const { repaintOn, settle } = this.body;
    const following = runtime.runFork(
      Effect.forEach(
        [
          this.body.followToolAvailability,
          ...(Object.keys(repaintOn) as Array<keyof typeof repaintOn>).map(
            (signal) =>
              onAppSignal(signal, (payload) => {
                const work = repaintOn[signal](payload as never);
                if (work) runtime.runFork(settle(work));
              }),
          ),
        ],
        (subscription) =>
          Effect.forkChild(subscription, { startImmediately: true }),
        { discard: true },
      ).pipe(Effect.andThen(Effect.never)),
    );
    context.subscriptions.push({
      dispose: () => runtime.runFork(Fiber.interrupt(following)),
    });
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
      const parsed = Schema.decodeUnknownResult(
        SettingsViewInboundMessageSchema,
      )(message);
      if (Result.isSuccess(parsed)) {
        return this.body.handleMessage(parsed.success, this.handlerRegistry);
      }
      // The webview's `postMessage` is untyped per command, so a malformed
      // request is a frontend bug the user just triggered with a click:
      // dropping it quietly would leave that click doing nothing.
      const command =
        typeof message === 'object' &&
        message !== null &&
        'command' in message &&
        typeof message.command === 'string'
          ? message.command
          : 'unknown';
      return showLoggedErrorMessage(
        this.channel,
        `Settings could not handle the '${command}' request`,
        parsed.failure.message,
      ).pipe(Effect.asVoid);
    });
  }
}
