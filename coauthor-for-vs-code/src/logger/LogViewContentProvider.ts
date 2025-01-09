// Standard library imports
import * as fs from 'fs';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from './logUtils';

const CHANNEL = 'Webview';
logger.initialize(CHANNEL);

export class LogViewContentProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getHtmlContent(webview: vscode.Webview): string {
    try {
      const getWebviewPath = (filePath: string) =>
        vscode.Uri.joinPath(
          this.context.extensionUri,
          'src',
          'logger',
          'logView',
          filePath,
        );

      const htmlPath = getWebviewPath('index.html');
      const cssPath = getWebviewPath('styles.css');
      const scriptPath = getWebviewPath('script.js');
      const splitJsPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'node_modules',
        'split.js',
        'dist',
        'split.es.js',
      );

      let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf-8');
      const nonce = this.getNonce();
      const styleUri = webview.asWebviewUri(cssPath);
      const scriptUri = webview.asWebviewUri(scriptPath);
      const splitJsUri = webview.asWebviewUri(splitJsPath);

      // Replace placeholders in HTML with actual content
      logger.debug(CHANNEL, 'Generated HTML content for LogView');
      return htmlContent
        .replace('${styleUri}', styleUri.toString())
        .replace('${scriptUri}', scriptUri.toString())
        .replace('${splitJsUri}', splitJsUri.toString())
        .replace(/\${nonce}/g, nonce)
        .replace(/\${cspSource}/g, webview.cspSource);
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error generating HTML content: ${err instanceof Error ? err.message : String(err)}`,
      );
      return '<html><body>Error loading content</body></html>';
    }
  }

  private getNonce() {
    let text = '';
    const possible =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
