// Standard library imports
import * as fs from 'fs';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { getConfig } from '../frontend-utils/commonUtils';

const CHANNEL = 'WebviewContent';
logger.initialize(CHANNEL);
export class WebviewContentProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getHtmlContent(webview: vscode.Webview): string {
    try {
      const getWebviewPath = (path: string) =>
        vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview', path);

      const htmlPath = getWebviewPath('index.html');
      const cssPath = getWebviewPath('styles.css');
      const mainScriptPath = getWebviewPath('script.js');

      // Get URIs for all modules
      const stateManagerPath = getWebviewPath('modules/stateManager.js');
      const messageHandlersPath = getWebviewPath('modules/messageHandlers.js');
      const fileHandlersPath = getWebviewPath('modules/fileHandlers.js');
      const uiHandlersPath = getWebviewPath('modules/uiHandlers.js');
      const utilsPath = getWebviewPath('modules/utils.js');
      const vscodeApiPath = getWebviewPath('modules/vscodeApi.js');

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
      logger.debug(CHANNEL, 'Generated HTML content for webview');
      return htmlContent
        .replace('${styleUri}', styleUri.toString())
        .replace('${scriptUri}', scriptUri.toString())
        .replace(/\${nonce}/g, nonce)
        .replace('${agentOptions}', agentOptions)
        .replace(/\${cspSource}/g, webview.cspSource)
        .replace('${utilsUri}', utilsUri.toString())
        .replace('${stateManagerUri}', stateManagerUri.toString())
        .replace('${messageHandlersUri}', messageHandlersUri.toString())
        .replace('${fileHandlersUri}', fileHandlersUri.toString())
        .replace('${uiHandlersUri}', uiHandlersUri.toString())
        .replace('${vscodeApiUri}', vscodeApiUri.toString());
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
