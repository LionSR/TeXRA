// Third-party imports
import * as vscode from 'vscode';

// Local imports - common webview
import { BaseWebviewProvider } from '@common/webview';

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

  protected override getViewPath(): string {
    return 'profileView';
  }

  public async showProfileView(): Promise<void> {
    const isNew = this.createOrShowPanel({
      viewType: ProfileViewProvider.viewType,
      title: 'TeXRA Profile',
      viewPath: 'profileView',
    });

    if (!isNew && this._view) {
      await this.messageHandler.sendProfileData(this._view.webview);
    }
  }
}
