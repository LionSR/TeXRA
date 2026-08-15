// Third-party imports
import * as vscode from 'vscode';

// Local imports
import {
  BaseWebviewProvider,
  BundledViewContentProvider,
} from '@common/webview';
import { onTexraAuthSessionsChanged } from '@frontend/events/onTexraAuthSessionsChanged';
import {
  isAgentCatalogAuthRefreshDeferred,
  runAfterAgentCatalogAuthRefresh,
} from '@frontend/auth/agentCatalogRefreshScope';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { AgentCategory, SettingsTab } from '@shared/schemas';

// Local file imports
import { SettingsViewMessageHandler } from './SettingsViewMessageHandler';

export class SettingsViewProvider extends BaseWebviewProvider {
  public static readonly viewType = 'texra.settingsView';
  protected contentProvider: BundledViewContentProvider;
  protected messageHandler: SettingsViewMessageHandler;
  public readonly signInChatGpt: () => Promise<void>;

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
    this.signInChatGpt = this.messageHandler.signInChatGpt;

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

  /** Refresh every credential-dependent surface after any API-key mutation. */
  public refreshAfterProviderKeyChange(provider: string): Promise<void> {
    return this.messageHandler.refreshAfterProviderKeyChange(provider);
  }

  /**
   * Create and show the webview panel (for command palette activation)
   * @param tabIndex Optional tab to switch to after showing
   * @param agentSubTab Optional sub-tab for the agents tab ('workflow' | 'toolUse')
   */
  public async showSettingsView(
    tabIndex?: SettingsTab,
    agentSubTab?: AgentCategory,
  ): Promise<void> {
    const isNew = this.createOrShowPanel({
      viewType: SettingsViewProvider.viewType,
      title: 'TeXRA Dashboard',
      viewPath: 'settingsView',
      iconPath: new vscode.ThemeIcon('gear'),
    });

    if (!isNew && this._view) {
      await this.messageHandler.sendAllData(this._view.webview);
    }

    if (tabIndex != null && this._view) {
      await this._view.webview.postMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_TAB,
        tabIndex,
        ...(agentSubTab && { agentSubTab }),
      });
    }
  }
}
