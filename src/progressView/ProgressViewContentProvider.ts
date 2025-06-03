// Standard library imports

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';
import { buildWebviewHtml } from '../utils/webviewHtmlUtils';

const CHANNEL = 'Webview';
logger.initialize(CHANNEL);

export class ProgressViewContentProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getHtmlContent(webview: vscode.Webview): string {
    try {
      const getWebviewPath = (filePath: string) =>
        vscode.Uri.joinPath(
          this.context.extensionUri,
          'src',
          'progressView',
          filePath,
        );
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
      const commonStyleUri = getCommonUri('styles/common.css');
      const scriptUri = getWebviewUri('script.js');
      const splitJsUri = getNodeModulesUri('split.js/dist/split.es.js');
      const webviewStateUri = getCommonUri('modules/webviewState.js');

      // Module paths
      const vscodeApiUri = getCommonUri('modules/vscodeApi.js');
      const stateManagerUri = getWebviewUri('modules/stateManager.js');
      const messageHandlersUri = getWebviewUri('modules/messageHandlers.js');
      const domHandlersUri = getWebviewUri('modules/domHandlers.js');
      const constantsUri = getWebviewUri('modules/constants.js');
      const logFormattersUri = getWebviewUri('modules/logFormatters.js');
      const templateUtilsUri = getCommonUri('modules/templateUtils.js');
      const domUtilsUri = getCommonUri('modules/domUtils.js');
      const stringUtilsUri = getCommonUri('modules/stringUtils.js');
      const messageRouterUri = getCommonUri('modules/messageRouter.js');

      const codiconUri = getNodeModulesUri('@vscode/codicons/dist/codicon.css');
      const codiconsFontUri = getNodeModulesUri(
        '@vscode/codicons/dist/codicon.ttf',
      );

      logger.debug(CHANNEL, 'Generated HTML content for ProgressView');
      return buildWebviewHtml(webview, htmlPath, {
        commonStyleUri,
        styleUri,
        scriptUri,
        splitJsUri,
        codiconUri,
        codiconsFontUri,
        vscodeApiUri,
        webviewStateUri,
        stateManagerUri,
        messageHandlersUri,
        domHandlersUri,
        messageRouterUri,
        domUtilsUri,
        stringUtilsUri,
        templateUtilsUri,
        constantsUri,
        logFormattersUri,
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
