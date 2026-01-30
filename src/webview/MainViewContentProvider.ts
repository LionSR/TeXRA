// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { BaseViewContentProvider } from '@common/webview';

export class MainViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'MainView');
  }

  protected getViewPath(): string {
    return 'webview';
  }

  protected override getModuleUris(
    webview: vscode.Webview,
  ): Record<string, vscode.Uri> {
    return {
      mainViewBundleUri: this.buildUri(webview, [
        'dist',
        'webview',
        'bundle.js',
      ]),
    };
  }
}
