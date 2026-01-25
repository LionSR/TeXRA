// Third-party imports
import * as vscode from 'vscode';

// Local imports - history view
import { BaseViewContentProvider } from '@common/webview';

export class HistoryViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'HistoryView');
  }

  protected override getModuleUris(
    webview: vscode.Webview,
  ): Record<string, vscode.Uri> {
    return {
      historyBundleUri: webview.asWebviewUri(
        vscode.Uri.joinPath(
          this.context.extensionUri,
          'dist',
          'historyView',
          'bundle.js',
        ),
      ),
    };
  }
}
