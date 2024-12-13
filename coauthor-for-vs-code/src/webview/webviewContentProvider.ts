import * as vscode from 'vscode';
import * as fs from 'fs';
import { getConfig } from '../utils/commonUtils';
import { debug, error } from '../utils/logUtils';

const CHANNEL = 'WebviewContent';

export class WebviewContentProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

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
      const mainScriptPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        'webview',
        'script.js',
      );
      // Get URIs for all modules
      const stateManagerPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        'webview',
        'modules',
        'stateManager.js',
      );
      const messageHandlersPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        'webview',
        'modules',
        'messageHandlers.js',
      );
      const fileHandlersPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        'webview',
        'modules',
        'fileHandlers.js',
      );
      const uiHandlersPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        'webview',
        'modules',
        'uiHandlers.js',
      );
      const utilsPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        'webview',
        'modules',
        'utils.js',
      );
      const vscodeApiPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'src',
        'webview',
        'modules',
        'vscodeApi.js',
      );

      let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf-8');

      const nonce = this.getNonce();
      const styleUri = webview.asWebviewUri(cssPath);
      const scriptUri = webview.asWebviewUri(mainScriptPath);
      const stateManagerUri = webview.asWebviewUri(stateManagerPath);
      const messageHandlersUri = webview.asWebviewUri(messageHandlersPath);
      const fileHandlersUri = webview.asWebviewUri(fileHandlersPath);
      const uiHandlersUri = webview.asWebviewUri(uiHandlersPath);
      const utilsUri = webview.asWebviewUri(utilsPath);
      const vscodeApiUri = webview.asWebviewUri(vscodeApiPath);
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
        .replace('${cspSource}', webview.cspSource)
        .replace('${utilsUri}', utilsUri.toString())
        .replace('${stateManagerUri}', stateManagerUri.toString())
        .replace('${messageHandlersUri}', messageHandlersUri.toString())
        .replace('${fileHandlersUri}', fileHandlersUri.toString())
        .replace('${uiHandlersUri}', uiHandlersUri.toString())
        .replace('${vscodeApiUri}', vscodeApiUri.toString());
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
