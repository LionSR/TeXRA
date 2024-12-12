import * as vscode from 'vscode';
import * as fs from 'fs';
import { getConfig } from '../utils/commonUtils';
import { debug, error } from '../utils/logUtils';

const CHANNEL = 'WebviewContent';

export class WebviewContentProvider {
  constructor(private readonly context: vscode.ExtensionContext) { }

  getHtmlContent(webview: vscode.Webview): string {
    try {
      const htmlPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        'webview',
        'index.html',
      );
      const cssPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        'webview',
        'styles.css',
      );
      const jsPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        'webview',
        'script.js',
      );

      let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf-8');

      const nonce = this.getNonce();
      const styleUri = webview.asWebviewUri(cssPath);
      const scriptUri = webview.asWebviewUri(jsPath);

      const agents = getConfig<string[]>('agents', []);
      const agentOptions = agents
        .map((agent) => `<option value="${agent}">${agent}</option>`)
        .join('\n');

      // Replace placeholders in HTML with actual content
      debug(CHANNEL, 'Generated HTML content for webview');
      return htmlContent
        .replace('${styleUri}', styleUri.toString())
        .replace('${scriptUri}', scriptUri.toString())
        .replace(/\${nonce}/g, nonce)
        .replace('${agentOptions}', agentOptions)
        .replace('${cspSource}', webview.cspSource);
    } catch (err) {
      error(
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