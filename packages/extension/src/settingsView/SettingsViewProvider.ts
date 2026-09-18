// Third-party imports
import type { Effect } from 'effect';
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
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { AgentCategory, SettingsTabPanelName } from '@shared/schemas';

// Local file imports
import { SettingsViewMessageHandler } from './SettingsViewMessageHandler';

export class SettingsViewProvider {
  public static readonly viewType = 'texra.settingsView';
  private _view?: vscode.WebviewPanel;
  private _viewDisposables = new DisposableStore();
  private readonly contentProvider: BundledViewContentProvider;
  private readonly messageHandler: SettingsViewMessageHandler;

  constructor(
    private readonly context: vscode.ExtensionContext,
    globalState: StateStore,
    secrets: PlatformSecrets,
    private readonly runtime: ProcessRuntime,
    session: SessionHandle,
  ) {
    this.contentProvider = new BundledViewContentProvider(
      context,
      runtime,
      'SettingsView',
      'settingsView',
    );
    this.messageHandler = new SettingsViewMessageHandler(
      context,
      globalState,
      secrets,
      runtime,
      session,
    );

    // Listen for auth state changes to refresh all data
    onTexraAuthSessionsChanged(context, () => {
      if (this._view) {
        if (isAgentCatalogAuthRefreshDeferred()) {
          runAfterAgentCatalogAuthRefresh(() =>
            this.postAllData(this._view!.webview),
          );
          return;
        }
        void this.postAllData(this._view.webview);
      }
    });
  }

  /** Sign in to a subscription provider from a command, not the webview. */
  public signInSubscription(providerId: SubscriptionProviderId): Promise<void> {
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

  /** Settle a full repaint of `webview` on this view's process runtime. */
  private postAllData(webview: vscode.Webview): Promise<void> {
    return this.runtime.runPromise(this.messageHandler.sendAllData(webview));
  }

  /**
   * Create and show the webview panel (for command palette activation)
   * @param tab Optional panel name to switch to after showing
   * @param agentSubTab Optional sub-tab for the agents tab ('workflow' | 'toolUse')
   */
  public async showSettingsView(
    tab?: SettingsTabPanelName,
    agentSubTab?: AgentCategory,
  ): Promise<void> {
    if (this._view) {
      const panel = this._view;
      panel.reveal(vscode.ViewColumn.One);
      await this.postAllData(panel.webview);
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

    // this._view can be undefined here: the awaited sendAllData above yields,
    // and disposing the dashboard panel during that await runs cleanupView.
    if (tab != null && this._view) {
      await this._view.webview.postMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_TAB,
        tab,
        ...(agentSubTab && { agentSubTab }),
      });
    }
  }

  /**
   * Render this provider's HTML into `panel` and route the panel's inbound
   * messages to this provider's handler. The returned disposable removes that
   * listener; the caller keeps it in the view disposable store.
   */
  private setupWebviewContent(panel: vscode.WebviewPanel): vscode.Disposable {
    // The template is read off this tick (it never rejects: a failed render
    // is a logged error page); a panel closed before it lands is not painted.
    void this.contentProvider.getHtmlContent(panel.webview).then((html) => {
      if (this._view === panel) panel.webview.html = html;
    });
    return panel.webview.onDidReceiveMessage((message) =>
      this.messageHandler.handleMessage(message, panel),
    );
  }

  private cleanupView(): void {
    const disposables = this._viewDisposables;
    this._viewDisposables = new DisposableStore();
    try {
      disposables.dispose();
    } finally {
      this._view = undefined;
      this.messageHandler.clearActiveView();
    }
  }
}
