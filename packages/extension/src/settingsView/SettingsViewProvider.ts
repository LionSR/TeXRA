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
import { onTexraAuthSessionsChanged } from '@frontend/events/onTexraAuthSessionsChanged';
import {
  isAgentCatalogAuthRefreshDeferred,
  runAfterAgentCatalogAuthRefresh,
} from '@frontend/auth/agentCatalogRefreshScope';
import { DisposableStore } from '@platform/disposable';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import type { StateStore } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import type { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { AgentCategory } from '@shared/schemas';
import type { SettingsTabPanelName } from '@shared/settingsView/settingsViewMessages';
import { ensureError } from '@utils/errors/errorMessage';

// Local file imports
import { SettingsViewMessageHandler } from './SettingsViewMessageHandler';

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
  private pendingTab?: {
    tab: SettingsTabPanelName;
    agentSubTab?: AgentCategory;
  };
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

    // Listen for auth state changes to refresh all data
    onTexraAuthSessionsChanged(context, () => {
      if (this._view) {
        if (isAgentCatalogAuthRefreshDeferred()) {
          // The panel this repaint belongs to is whichever one is open when
          // the preflight releases it, not the one open when auth changed: a
          // dispose and reopen inside that window must not repaint the dead
          // webview and leave the live one stale.
          runAfterAgentCatalogAuthRefresh(this.runtime, [
            Effect.suspend(() =>
              this._view
                ? this.messageHandler.sendAllData(this._view.webview)
                : Effect.void,
            ),
          ]);
          return;
        }
        this.runtime.runFork(
          this.messageHandler.sendAllData(this._view.webview),
        );
      }
    });
  }

  /** Sign in to a subscription provider from a command, not the webview. */
  public signInSubscription(providerId: SubscriptionProviderId) {
    return this.messageHandler.signInSubscription(providerId);
  }

  /**
   * Refresh every credential-dependent surface after any API-key mutation.
   * The program, not its settlement: the caller that owns the key write runs
   * it as part of that write's own action.
   */
  public refreshAfterProviderKeyChange(
    provider: string,
  ): Effect.Effect<void, Error, ProcessServices> {
    return this.messageHandler.refreshAfterProviderKeyChange(provider);
  }

  /**
   * Create and show the webview panel (for command palette activation)
   * @param tab Optional panel name to switch to after showing
   * @param agentSubTab Optional sub-tab for the agents tab ('workflow' | 'toolUse')
   */
  public showSettingsView(
    tab?: SettingsTabPanelName,
    agentSubTab?: AgentCategory,
  ): Effect.Effect<void, Error, ProcessServices> {
    return Effect.gen({ self: this }, function* () {
      if (this._view) {
        const panel = this._view;
        panel.reveal(vscode.ViewColumn.One);
        yield* this.messageHandler.sendAllData(panel.webview);
      } else {
        const panel = vscode.window.createWebviewPanel(
          SettingsViewProvider.viewType,
          'TeXRA Dashboard',
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
        const webview = this._view.webview;
        yield* Effect.tryPromise({
          try: () => this.postTab(webview, { tab, agentSubTab }),
          catch: ensureError,
        });
      } else {
        this.pendingTab = { tab, agentSubTab };
      }
    });
  }

  private async postTab(
    webview: vscode.Webview,
    { tab, agentSubTab }: NonNullable<SettingsViewProvider['pendingTab']>,
  ): Promise<void> {
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.SET_TAB,
      tab,
      ...(agentSubTab && { agentSubTab }),
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
    return panel.webview.onDidReceiveMessage(async (message) => {
      await this.messageHandler.handleMessage(message, panel);
      if (this._view !== panel || !isReadyMessage(message)) return;
      // The ready handler has repainted the view; the tab asked for while it
      // loaded goes after that data, as a reveal of a live panel orders them.
      this.viewReady = true;
      const pending = this.pendingTab;
      this.pendingTab = undefined;
      if (pending) await this.postTab(panel.webview, pending);
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
