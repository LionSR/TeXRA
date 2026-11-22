import * as vscode from 'vscode';
import { Effect, Latch, Predicate } from 'effect';

import { hasExtension } from '@texra-ai/worldline/schemas';
import { withLogChannel } from '@texra-ai/worldline/plugins';
import { vscodeOpener } from '@frontend/hosts/VscodeExternalOpener';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import {
  executeVscodeCommand,
  safeExecuteCommand,
} from '@frontend/system/commandUtils';
import { selectFolder } from '@frontend/ui/dialogs';
import { signInWithSubscription } from '@frontend/auth/subscriptionSignIn';
import type { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { fromHost } from '@texra/controllers/session/hostCallFailure';
import type { HostFailed } from '@texra/hosts/uiHosts';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import type { SubscriptionProviderId } from '@texra/controllers/modelAccess/subscriptionProviders';
import type { SettingsTarget } from '@texra/shared/settingsView/settingsTarget';
import { BundledViewContentProvider } from '../common/webview/BundledViewContentProvider';
import type { SettingsViewOutboundMessage } from '@texra/shared/settingsView/settingsViewMessages';
import { makeSettingsViewBody } from '@texra/controllers/settingsView/settingsViewBody';
import { vscodeEditorIntegration } from '@frontend/vscodeEditorIntegration';
import type { WorkspaceRoots } from '@texra-ai/worldline';
import type {
  ProcessRuntime,
  ProcessServices,
  ScopedFork,
} from '@texra-ai/worldline/host';

/** Lift VS Code's rejected post at the typed settings transport boundary. */
function postToWebview(
  webview: vscode.Webview,
  message: SettingsViewOutboundMessage,
): Effect.Effect<void, HostFailed> {
  return fromHost('webview.postMessage', async () => {
    await webview.postMessage(message);
  });
}

/** Show `document` in an editor tab of its own. */
const showDocument = (
  document: () => Thenable<vscode.TextDocument>,
): Effect.Effect<void, HostFailed> =>
  fromHost('showTextDocument', async () => {
    await vscode.window.showTextDocument(await document(), {
      preview: false,
    });
  });

const CHANNEL = 'SettingsViewProvider';

/** The open settings panel. */
interface SettingsPanel {
  readonly view: vscode.WebviewPanel;
  /** The panel's message and dispose listeners. */
  readonly listeners: vscode.Disposable[];
  /** Opens when the panel's frontend posts `WEBVIEW_READY`. Until then a
   *  message posted to it is dropped, since its document may not have
   *  loaded or mounted a listener yet (#12495), and a tab asked for waits. */
  readonly ready: Latch.Latch;
}

export class SettingsViewProvider {
  public static readonly viewType = 'texra.settingsView';
  private panel?: SettingsPanel;
  private readonly contentProvider: BundledViewContentProvider;
  private readonly body: Effect.Success<
    ReturnType<typeof makeSettingsViewBody>
  >;

  /** The activation's run function: the panel's callbacks start their work
   *  there, and the activation's close ends it. */
  private readonly fork: ScopedFork<ProcessServices>;
  constructor(
    context: vscode.ExtensionContext,
    runtime: ProcessRuntime,
    fork: ScopedFork<ProcessServices>,
    roots: WorkspaceRoots,
    progressView: ProgressViewProvider,
  ) {
    this.fork = fork;
    this.contentProvider = new BundledViewContentProvider(
      context,
      'TeXRA Settings',
      'settingsView',
    );
    this.body = runtime.runSync(
      makeSettingsViewBody({
        roots,
        bindings: {
          // A panel closed or replaced while the message builds has no
          // receiver, and no caller waits on a repaint, so the post is
          // dropped; one disposed during `postMessage` still fails.
          post: (message) =>
            Effect.suspend(() => {
              const panel = this.panel;
              return panel && Latch.isOpen(panel.ready)
                ? Effect.flatMap(message, (built) =>
                    this.panel === panel
                      ? postToWebview(panel.view.webview, built)
                      : Effect.void,
                  )
                : Effect.void;
            }),
          dialogs: vscodeUi,
          externalOpener: vscodeOpener,
          // Markdown opens in preview mode, the read-only rendered view.
          openPath: (filePath) =>
            hasExtension(filePath, '.md')
              ? safeExecuteCommand('markdown.showPreview', [
                  vscode.Uri.file(filePath),
                ]).pipe(Effect.asVoid)
              : showDocument(() => vscode.workspace.openTextDocument(filePath)),
          revealPath: (filePath) =>
            executeVscodeCommand('revealFileInOS', vscode.Uri.file(filePath)),
          pickFolder: (title) =>
            Effect.map(
              selectFolder({ title, openLabel: 'Select Folder' }),
              (selected) => selected ?? undefined,
            ),
          ...progressView.window.settingsRuns,
          signInSubscription: (providerId) =>
            signInWithSubscription(roots, providerId),
          runInTerminal: (name, command) =>
            Effect.sync(() => {
              const terminal = vscode.window.createTerminal({ name });
              terminal.show();
              terminal.sendText(command);
            }),
          editor: vscodeEditorIntegration,
        },
      }),
    );

    // One fiber owns every page follower: the activation's close interrupts
    // them all.
    fork(this.body.follow.pipe(withLogChannel(CHANNEL)));
  }

  /**
   * Sign in to a subscription provider from a command, not the webview,
   * through the same program the Models page's sign-in button runs, so the
   * command palette gets the status round-trip and credential refresh tail.
   */
  public signInSubscription(providerId: SubscriptionProviderId) {
    return this.body.signInSubscription(providerId);
  }

  /**
   * Create and show the webview panel (for command palette activation)
   * @param tab Optional page, or `page/section`, to switch to after showing
   */
  public readonly showSettingsView = Effect.fn(
    'SettingsViewProvider.showSettingsView',
  )({ self: this }, function* (tab?: SettingsTarget): Effect.fn.Return<
    void,
    Error,
    ProcessServices
  > {
    if (this.panel) {
      this.panel.view.reveal(vscode.ViewColumn.One);
      yield* this.body.changed('view');
    } else {
      const view = vscode.window.createWebviewPanel(
        SettingsViewProvider.viewType,
        'TeXRA Settings',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: this.contentProvider.localResourceRoots,
        },
      );
      view.iconPath = new vscode.ThemeIcon('gear');

      this.cleanupView();
      const opened: SettingsPanel = {
        view,
        ready: Latch.makeUnsafe(false),
        listeners: [],
      };
      this.panel = opened;
      opened.listeners.push(
        this.setupWebviewContent(opened),
        view.onDidDispose(this.cleanupView.bind(this)),
      );
    }

    // this.panel can be undefined here: the `changed(view)` above yields, and
    // disposing the dashboard panel meanwhile runs cleanupView.
    const panel = this.panel;
    if (tab == null || !panel) return;
    const postTab = Effect.suspend(() =>
      this.panel === panel
        ? this.postTab(panel.view.webview, tab)
        : Effect.void,
    );
    if (Latch.isOpen(panel.ready)) {
      yield* postTab;
      return;
    }
    // The tab goes once the frontend is ready, off this command. Waiting
    // requests post in the order they were made, so the latest one wins.
    this.fork(panel.ready.whenOpen(postTab).pipe(withLogChannel(CHANNEL)));
  });

  /**
   * Render this provider's HTML into `panel` and route the panel's inbound
   * messages to the shared settings body. The returned disposable removes that
   * listener; the caller keeps it with the view's listeners.
   */
  private setupWebviewContent({
    view: panel,
    ready,
  }: SettingsPanel): vscode.Disposable {
    // The template is read off this tick (it never rejects: a failed render
    // is a reported error page); a panel closed before it lands is not
    // painted.
    this.fork(
      this.contentProvider
        .render(panel.webview, (html) => {
          if (this.panel?.view === panel) panel.webview.html = html;
        })
        .pipe(withLogChannel(CHANNEL)),
    );
    return panel.webview.onDidReceiveMessage((message) => {
      this.fork(
        Effect.gen({ self: this }, function* () {
          if (this.panel?.view !== panel) return;
          // Initial page refreshes must be able to post during ready
          // dispatch; a tab asked for while the panel loaded goes now too.
          if (
            Predicate.hasProperty(message, 'command') &&
            message.command === SETTINGS_VIEW_COMMANDS.WEBVIEW_READY
          ) {
            yield* ready.open;
          }
          yield* this.body.handleMessage(message);
        }).pipe(withLogChannel(CHANNEL)),
      );
    });
  }

  private postTab(webview: vscode.Webview, tab: SettingsTarget) {
    return postToWebview(webview, {
      command: SETTINGS_VIEW_COMMANDS.SET_TAB,
      tab,
    });
  }

  private cleanupView(): void {
    const panel = this.panel;
    this.panel = undefined;
    if (!panel) return;
    // A tab request still waiting finds the panel gone and posts nothing.
    panel.ready.openUnsafe();
    vscode.Disposable.from(...panel.listeners).dispose();
  }
}
