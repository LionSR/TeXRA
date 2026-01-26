// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import { BaseViewContentProvider } from '@common/webview';

export class ProgressViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'ProgressView');
  }

  protected override getModuleUris(
    webview: vscode.Webview,
  ): Record<string, vscode.Uri> {
    const distPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      'dist',
      'progressView',
    );
    return {
      progressBundleUri: webview.asWebviewUri(
        vscode.Uri.joinPath(distPath, 'bundle.js'),
      ),
      // Bundled CSS includes KaTeX styles and fonts
      bundledStyleUri: webview.asWebviewUri(
        vscode.Uri.joinPath(distPath, 'index.css'),
      ),
    };
  }

  protected getViewPath(): string {
    return 'progressView';
  }
}
