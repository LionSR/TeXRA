// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import type { SessionHandle } from '@agent/runtime';
import {
  BundledViewContentProvider,
  getSharedLocalResourceRoots,
} from '@common/webview';
import type { SubscriptionProviderId } from '@controllers/modelAccess/subscriptionProviders';
import { DisposableStore } from '@platform/disposable';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import type { StateStore } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import type { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsTarget } from '@shared/settingsView/settingsViewMessages';

// Local file imports
import {
  postToWebview,
  SettingsViewMessageHandler,
} from './SettingsViewMessageHandler';

function isReadyMessage(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    'command' in message &&
    message.command === SETTINGS_VIEW_COMMANDS.WEBVIEW_READY
  );
}

export class SettingsViewProvider {
  public static readonly viewType = 'texra.settingsView';
  private _view?: vscode.WebviewPanel;
  private _viewDisposables = new DisposableStore();
  /** Whether the panel's frontend has posted `WEBVIEW_READY`. Until then a
   *  message posted to it is dropped, since its document may not have
   *  loaded or mounted a listener yet (#12495). */
  private viewReady = false;
  /** The latest tab asked for before the panel was ready, posted on ready. */
  private pendingTab?: SettingsTarget;
  private readonly contentProvider: BundledViewContentProvider;
  private readonly messageHandler: SettingsViewMessageHandler;

  constructor(
    private readonly context: vscode.ExtensionContext,
    globalState: StateStore,
    secrets: PlatformSecrets,
    private readonly runtime: ProcessRuntime,
    session: SessionHandle,
    progressView: ProgressViewProvider,
  ) {
    this.contentProvider = new BundledViewContentProvider(
      context,
      'SettingsView',
      'settingsView',
    );
    this.messageHandler = new SettingsViewMessageHandler(
      context,
      globalState,
      secrets,
      runtime,
      session,
      progressView,
    );
  }

  /** Sign in to a subscription provider from a command, not the webview. */
  public signInSubscription(providerId: SubscriptionProviderId) {
    return this.messageHandler.signInSubscription(providerId);
  }

  /**
   * Create and show the webview panel (for command palette activation)
   * @param tab Optional page, or `page/section`, to switch to after showing
   */
  public showSettingsView(
    tab?: SettingsTarget,
  ): Effect.Effect<void, Error, ProcessServices> {
    return Effect.gen({ self: this }, function* () {
      if (this._view) {
        const panel = this._view;
        panel.reveal(vscode.ViewColumn.One);
        yield* this.messageHandler.sendAllData();
      } else {
        const panel = vscode.window.createWebviewPanel(
          SettingsViewProvider.viewType,
          'TeXRA Settings',
          vscode.ViewColumn.One,
          {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: getSharedLocalResourceRoots(
              this.context,
              'settingsView',
            ),
          },
        );
        panel.iconPath = new vscode.ThemeIcon('gear');

        this.cleanupView();
        this._view = panel;
        this._viewDisposables.add(this.setupWebviewContent(panel));
        this._viewDisposables.add(
          panel.onDidDispose(this.cleanupView.bind(this)),
        );
      }

      // this._view can be undefined here: the sendAllData above yields, and
      // disposing the dashboard panel meanwhile runs cleanupView.
      if (tab == null || !this._view) return;
      if (this.viewReady) {
        yield* this.postTab(this._view.webview, tab);
      } else {
        this.pendingTab = tab;
      }
    });
  }

  /**
   * Render this provider's HTML into `panel` and route the panel's inbound
   * messages to this provider's handler. The returned disposable removes that
   * listener; the caller keeps it in the view disposable store.
   */
  private setupWebviewContent(panel: vscode.WebviewPanel): vscode.Disposable {
    // The template is read off this tick (it never rejects: a failed render
    // is a logged error page); a panel closed before it lands is not painted.
    this.runtime.runFork(
      this.contentProvider.getHtmlContent(panel.webview).pipe(
        Effect.flatMap((html) =>
          Effect.sync(() => {
            if (this._view === panel) panel.webview.html = html;
          }),
        ),
      ),
    );
    return panel.webview.onDidReceiveMessage((message) => {
      this.runtime.runFork(
        Effect.gen({ self: this }, function* () {
          yield* this.messageHandler.handleMessage(message, panel);
          if (this._view !== panel || !isReadyMessage(message)) return;
          // The ready handler has repainted the view; the tab asked for while
          // it loaded goes after that data, as a reveal of a live panel
          // orders them.
          this.viewReady = true;
          const pending = this.pendingTab;
          this.pendingTab = undefined;
          if (pending) yield* this.postTab(panel.webview, pending);
        }),
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
    const disposables = this._viewDisposables;
    this._viewDisposables = new DisposableStore();
    try {
      disposables.dispose();
    } finally {
      this._view = undefined;
      this.viewReady = false;
      this.pendingTab = undefined;
      this.messageHandler.clearActiveView();
    }
  }
}
