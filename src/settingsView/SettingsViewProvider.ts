// Third-party imports
import * as vscode from 'vscode';

// Local imports - common webview
import { BaseWebviewProvider, SETTINGS_VIEW_COMMANDS } from '@common/webview';

// Local imports - settings view components
import { SettingsViewContentProvider } from './SettingsViewContentProvider';
import { SettingsViewMessageHandler } from './SettingsViewMessageHandler';

// Local imports - shared schemas
import { type SettingsTab } from '@shared/schemas/settingsViewMessages';

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
   */
  public async showSettingsView(tabIndex?: SettingsTab): Promise<void> {
    const isNew = this.createOrShowPanel({
      viewType: SettingsViewProvider.viewType,
      title: 'TeXRA Dashboard',
      viewPath: 'settingsView',
    });

    if (!isNew && this._view) {
      await this.messageHandler.sendAllData(this._view.webview);
    }

    // Switch to requested tab if specified
    if (tabIndex !== undefined && this._view) {
      await this._view.webview.postMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_TAB,
        tabIndex,
      });
    }
  }
}
