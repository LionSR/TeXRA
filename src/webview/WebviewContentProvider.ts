// Standard library imports

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { getConfig } from '../utils/configUtils';
import { buildWebviewHtml } from '../utils/webviewHtmlUtils';

const CHANNEL = 'Webview';
logger.initialize(CHANNEL);

export class WebviewContentProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getHtmlContent(webview: vscode.Webview): string {
    try {
      const getWebviewPath = (path: string) =>
        vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview', path);
      const getWebviewUri = (path: string) =>
        webview.asWebviewUri(getWebviewPath(path));
      const getCommonUri = (path: string) =>
        webview.asWebviewUri(
          vscode.Uri.joinPath(this.context.extensionUri, 'src', 'common', path),
        );
      const getNodeModulesUri = (path: string) =>
        webview.asWebviewUri(
          vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', path),
        );

      const htmlPath = getWebviewPath('index.html');
      const styleUri = getWebviewUri('styles/index.css');
      const scriptUri = getWebviewUri('script.js');
      const commonStyleUri = getCommonUri('styles/common.css');
      const webviewStateUri = getCommonUri('modules/webviewState.js');

      // Get URIs for all modules
      const stateManagerUri = getWebviewUri('modules/stateManager.js');
      const messageHandlersUri = getWebviewUri('modules/messageHandlers.js');
      const fileHandlersUri = getWebviewUri('modules/fileHandlers.js');
      const uiHandlersUri = getWebviewUri('modules/uiHandlers.js');
      const templateUtilsUri = getCommonUri('modules/templateUtils.js');
      const domUtilsUri = getCommonUri('modules/domUtils.js');
      const stringUtilsUri = getCommonUri('modules/stringUtils.js');
      const messageRouterUri = getCommonUri('modules/messageRouter.js');
      const vscodeApiUri = getCommonUri('modules/vscodeApi.js');

      const codiconUri = getNodeModulesUri('@vscode/codicons/dist/codicon.css');
      const codiconsFontUri = getNodeModulesUri(
        '@vscode/codicons/dist/codicon.ttf',
      );

      const agents = getConfig<string[]>('agents', []);
      const agentOptions = agents
        .map((agent) => `<option value="${agent}">${agent}</option>`)
        .join('\n');

      const models = getConfig<string[]>('models', []);
      const modelOptions = models
        .map((model) => `<option value="${model}">${model}</option>`)
        .join('\n');

      logger.debug(CHANNEL, 'Generated HTML content for webview');
      return buildWebviewHtml(webview, htmlPath, {
        commonStyleUri,
        styleUri,
        scriptUri,
        agentOptions,
        modelOptions,
        domUtilsUri,
        stringUtilsUri,
        webviewStateUri,
        stateManagerUri,
        messageHandlersUri,
        fileHandlersUri,
        uiHandlersUri,
        templateUtilsUri,
        messageRouterUri,
        vscodeApiUri,
        codiconUri,
        codiconsFontUri,
      });
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error generating HTML content: ${err instanceof Error ? err.message : String(err)}`,
      );
      return '<html><body>Error loading content</body></html>';
    }
  }
}
