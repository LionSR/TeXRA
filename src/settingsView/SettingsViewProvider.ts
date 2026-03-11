// Third-party imports
import * as vscode from 'vscode';

// Local imports - common webview
import { BaseWebviewProvider, SETTINGS_VIEW_COMMANDS } from '@common/webview';
import type { SettingsTab } from '@shared/schemas/settingsViewMessages';

// Local imports - settings view components
import type { AgentCategory } from '@shared/schemas/agent';
import { SettingsViewContentProvider } from './SettingsViewContentProvider';
import { SettingsViewMessageHandler } from './SettingsViewMessageHandler';

export class SettingsViewProvider
  extends BaseWebviewProvider
  implements vscode.WebviewViewProvider
{
  public static readonly viewType = 'texra.settingsView';
  protected contentProvider: SettingsViewContentProvider;
  protected messageHandler: SettingsViewMessageHandler;

  constructor(protected readonly context: vscode.ExtensionContext) {
    super(context);
    this.contentProvider = new SettingsViewContentProvider(context);
    this.messageHandler = new SettingsViewMessageHandler(context);

    // Listen for auth state changes to refresh all data
    context.subscriptions.push(
      vscode.authentication.onDidChangeSessions((e) => {
        if (e.provider.id === 'texra-supabase' && this._view) {
          void this.messageHandler.sendAllData(this._view.webview);
        }
      }),
    );
  }

  protected override getViewPath(): string {
    return 'settingsView';
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
