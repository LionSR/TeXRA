// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { BaseViewContentProvider } from '@common/webview';

export class ProgressViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'ProgressView');
  }

  protected override getModuleUris(
    webview: vscode.Webview,
  ): Record<string, vscode.Uri> {
    return {
      progressBundleUri: this.buildUri(webview, [
        'dist',
        'progressView',
        'bundle.js',
      ]),
      progressStyleUri: this.buildUri(webview, [
        'dist',
        'progressView',
        'index.css',
      ]),
    };
  }
}
