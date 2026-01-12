// Third-party imports
import * as vscode from 'vscode';

// Local imports - common webview
import {
  BaseWebviewProvider,
  getSharedLocalResourceRoots,
} from '@common/webview';

// Local imports - settings view components
import { SettingsViewContentProvider } from './SettingsViewContentProvider';
import { SettingsViewMessageHandler } from './SettingsViewMessageHandler';
import type { SettingsTab } from './schemas';

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
  }

  /**
   * Resolve webview for potential sidebar integration.
   */
  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: getSharedLocalResourceRoots(
        this.context,
        'settingsView',
      ),
    };

    super.resolveWebviewViewInternal(webviewView);
  }

  /**
   * Create and show the webview panel (for command palette activation)
   */
  public async showSettingsView(tab?: SettingsTab): Promise<void> {
    const isNew = this.createOrShowPanel({
      viewType: SettingsViewProvider.viewType,
      title: 'TeXRA Settings',
      viewPath: 'settingsView',
    });

    // Send fresh data when revealing existing panel
    if (!isNew && this._view) {
      await this.messageHandler.sendInitialData(this._view.webview);
    }

    // If a specific tab was requested, select it
    if (tab && this._view) {
      await this.messageHandler.selectTab(this._view.webview, tab);
    }
  }
}
