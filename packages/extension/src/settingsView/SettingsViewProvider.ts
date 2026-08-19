// Third-party imports
import * as vscode from 'vscode';

// Local imports
import {
  BaseWebviewProvider,
  BundledViewContentProvider,
  getSharedLocalResourceRoots,
} from '@common/webview';
import type { SubscriptionProviderId } from '@controllers/modelAccess/subscriptionProviders';
import { onTexraAuthSessionsChanged } from '@frontend/events/onTexraAuthSessionsChanged';
import {
  isAgentCatalogAuthRefreshDeferred,
  runAfterAgentCatalogAuthRefresh,
} from '@frontend/auth/agentCatalogRefreshScope';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { AgentCategory, SettingsTabPanelName } from '@shared/schemas';

// Local file imports
import { SettingsViewMessageHandler } from './SettingsViewMessageHandler';

export class SettingsViewProvider extends BaseWebviewProvider {
  public static readonly viewType = 'texra.settingsView';
  protected contentProvider: BundledViewContentProvider;
  protected messageHandler: SettingsViewMessageHandler;

  constructor(protected readonly context: vscode.ExtensionContext) {
    super(context);
    this.contentProvider = new BundledViewContentProvider(
      context,
      'SettingsView',
      {
        dist: 'settingsView',
        bundleKey: 'settingsBundleUri',
        styleKey: 'settingsStyleUri',
      },
    );
    this.messageHandler = new SettingsViewMessageHandler(context);

    // Listen for auth state changes to refresh all data
    onTexraAuthSessionsChanged(context, () => {
      if (this._view) {
        if (isAgentCatalogAuthRefreshDeferred()) {
          runAfterAgentCatalogAuthRefresh(() =>
            this.messageHandler.sendAllData(this._view!.webview),
          );
          return;
        }
        void this.messageHandler.sendAllData(this._view.webview);
      }
    });
  }

  /** Sign in to a subscription provider from a command, not the webview. */
  public signInSubscription(providerId: SubscriptionProviderId): Promise<void> {
    return this.messageHandler.signInSubscription(providerId);
  }

  /** Refresh every credential-dependent surface after any API-key mutation. */
  public refreshAfterProviderKeyChange(provider: string): Promise<void> {
    return this.messageHandler.refreshAfterProviderKeyChange(provider);
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
    // 'viewColumn' is unique to WebviewPanel; it narrows the view union and
    // tells an already-open dashboard panel apart from a sidebar WebviewView.
    if (this._view && 'viewColumn' in this._view) {
      const panel = this._view;
      panel.reveal(vscode.ViewColumn.One);
      await this.messageHandler.sendAllData(panel.webview);
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
      panel.webview.html = this.contentProvider.getHtmlContent(panel.webview);
      this._viewDisposables.add(
        panel.webview.onDidReceiveMessage((message) =>
          this.messageHandler.handleMessage(message, panel),
        ),
      );
      this._viewDisposables.add(
        panel.onDidDispose(this.cleanupView.bind(this)),
      );
    }

    if (tab != null && this._view) {
      await this._view.webview.postMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_TAB,
        tab,
        ...(agentSubTab && { agentSubTab }),
      });
    }
  }
}
