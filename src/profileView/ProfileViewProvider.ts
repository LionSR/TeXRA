// Third-party imports
import * as vscode from 'vscode';

// Local imports - common webview
import {
  BaseWebviewProvider,
  getSharedLocalResourceRoots,
} from '@common/webview';

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
    const isNew = this.createOrShowPanel({
      viewType: ProfileViewProvider.viewType,
      title: 'TeXRA Profile',
      viewPath: 'profileView',
    });

    // Send fresh data when revealing existing panel
    if (!isNew && this._view) {
      await this.messageHandler.sendProfileData(this._view.webview);
    }
    // For new panels: HTML is set by createOrShowPanel -> resolveWebviewViewInternal
    // Webview will request data via GET_PROFILE_DATA on DOMContentLoaded
  }
}
