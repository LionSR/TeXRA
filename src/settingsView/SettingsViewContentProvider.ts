// Third-party imports
import * as vscode from 'vscode';

// Local imports - common webview
import { BaseViewContentProvider } from '@common/webview';

export class SettingsViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'SettingsView');
  }

  protected override getModuleUris(
    webview: vscode.Webview,
  ): Record<string, vscode.Uri> {
    return {
      settingsBundleUri: this.buildUri(webview, [
        'dist',
        'settingsView',
        'bundle.js',
      ]),
    };
  }
}
