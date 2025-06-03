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
      const getCommonPath = (path: string) =>
        vscode.Uri.joinPath(this.context.extensionUri, 'src', 'common', path);
      const getNodeModulesPath = (path: string) =>
        vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', path);

      const htmlPath = getWebviewPath('index.html');
      const cssPath = getWebviewPath('styles/index.css');
      const commonCssPath = getCommonPath('styles/common.css');
      const mainScriptPath = getWebviewPath('script.js');
      const webviewStatePath = getCommonPath('modules/webviewState.js');

      // Get URIs for all modules
      const stateManagerPath = getWebviewPath('modules/stateManager.js');
      const messageHandlersPath = getWebviewPath('modules/messageHandlers.js');
      const fileHandlersPath = getWebviewPath('modules/fileHandlers.js');
      const uiHandlersPath = getWebviewPath('modules/uiHandlers.js');
      const templateUtilsPath = getCommonPath('modules/templateUtils.js');
      const domUtilsPath = getCommonPath('modules/domUtils.js');
      const stringUtilsPath = getCommonPath('modules/stringUtils.js');
      const messageRouterPath = getCommonPath('modules/messageRouter.js');
      const vscodeApiPath = getCommonPath('modules/vscodeApi.js');

      const styleUri = webview.asWebviewUri(cssPath);
      const commonStyleUri = webview.asWebviewUri(commonCssPath);
      const scriptUri = webview.asWebviewUri(mainScriptPath);
      const webviewStateUri = webview.asWebviewUri(webviewStatePath);
      const stateManagerUri = webview.asWebviewUri(stateManagerPath);
      const messageHandlersUri = webview.asWebviewUri(messageHandlersPath);
      const fileHandlersUri = webview.asWebviewUri(fileHandlersPath);
      const uiHandlersUri = webview.asWebviewUri(uiHandlersPath);
      const templateUtilsUri = webview.asWebviewUri(templateUtilsPath);
      const domUtilsUri = webview.asWebviewUri(domUtilsPath);
      const stringUtilsUri = webview.asWebviewUri(stringUtilsPath);
      const messageRouterUri = webview.asWebviewUri(messageRouterPath);
      const vscodeApiUri = webview.asWebviewUri(vscodeApiPath);

      const codiconPath = getNodeModulesPath(
        '@vscode/codicons/dist/codicon.css',
      );
      const codiconsFontPath = getNodeModulesPath(
        '@vscode/codicons/dist/codicon.ttf',
      );
      const codiconUri = webview.asWebviewUri(codiconPath);
      const codiconsFontUri = webview.asWebviewUri(codiconsFontPath);

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
