// Third-party imports
import * as vscode from 'vscode';

// Local imports - memory view
import { BaseViewContentProvider } from '@common/webview';

export class MemoryViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'MemoryView');
  }

  protected override getModuleUris(
    webview: vscode.Webview,
  ): Record<string, vscode.Uri> {
    return {
      memoryBundleUri: webview.asWebviewUri(
        vscode.Uri.joinPath(
          this.context.extensionUri,
          'dist',
          'memoryView',
          'bundle.js',
        ),
      ),
    };
  }
}
