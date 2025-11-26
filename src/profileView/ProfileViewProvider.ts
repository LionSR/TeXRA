// Third-party imports
import * as vscode from 'vscode';

// Local imports - common webview
import { BaseWebviewProvider, getSharedLocalResourceRoots } from '@common/webview';

// Local imports - profile view components
import { ProfileViewContentProvider } from './ProfileViewContentProvider';
import { ProfileViewMessageHandler } from './ProfileViewMessageHandler';

export class ProfileViewProvider
  extends BaseWebviewProvider
  implements vscode.WebviewViewProvider
{
  public static readonly viewType = 'texra.profileView';
  protected contentProvider: ProfileViewContentProvider;
  protected messageHandler: ProfileViewMessageHandler;

  constructor(protected readonly context: vscode.ExtensionContext) {
    super(context);
    this.contentProvider = new ProfileViewContentProvider(context);
    this.messageHandler = new ProfileViewMessageHandler(context);
  }

  /**
   * Resolve webview for potential sidebar integration.
   */
  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: getSharedLocalResourceRoots(
        this.context,
        'profileView',
      ),
    };

    super.resolveWebviewViewInternal(webviewView);
  }

  /**
   * Create and show the webview panel (for command palette activation)
   */
  public async showProfileView() {
    // If we already have a panel, show it and refresh data
    if (this._view && 'reveal' in this._view) {
      this._view.reveal(vscode.ViewColumn.One);
      // Send fresh data to existing panel - no need to reset HTML
      await this.messageHandler.sendProfileData(this._view.webview);
      return;
    }

    // Otherwise, create a new panel
    this._view = vscode.window.createWebviewPanel(
      ProfileViewProvider.viewType,
      'TeXRA Profile',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: getSharedLocalResourceRoots(
          this.context,
          'profileView',
        ),
      },
    );

    super.resolveWebviewViewInternal(this._view);

    // Set the HTML content - webview will request data via GET_PROFILE_DATA on DOMContentLoaded
    this._view.webview.html = this.contentProvider.getHtmlContent(
      this._view.webview,
    );
  }
}
