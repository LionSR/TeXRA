// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { BaseViewContentProvider } from '@common/webview';

export class ProfileViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'ProfileView');
  }

  protected override getModuleUris(
    webview: vscode.Webview,
  ): Record<string, vscode.Uri> {
    return {
      profileBundleUri: this.buildUri(webview, [
        'dist',
        'profileView',
        'bundle.js',
      ]),
    };
  }
}
