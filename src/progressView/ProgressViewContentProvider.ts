// Standard library imports

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';
import { buildWebviewHtml } from '@frontend/webview/html';

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
      const webviewContextUri = getCommonUri('modules/webviewContext.js');
      const progressViewStateUri = getWebviewUri(
        'modules/progressViewState.js',
      );
      const messageHandlersUri = getWebviewUri('modules/messageHandlers.js');
      const domHandlersUri = getWebviewUri('modules/domHandlers.js');
      const formattersUri = getWebviewUri('modules/formatters.js');
      const taskManagersUri = getWebviewUri('modules/taskManagers.js');
      const usageManagersUri = getWebviewUri('modules/usageManagers.js');
      const streamTabsUri = getWebviewUri('modules/uiManagers/StreamTabs.js');
      const toolbarUri = getWebviewUri('modules/uiManagers/Toolbar.js');
      const statusUri = getWebviewUri('modules/uiManagers/Status.js');
      const fileListUri = getWebviewUri('modules/uiManagers/FileList.js');
      const outputStatusUri = getWebviewUri(
        'modules/uiManagers/OutputStatus.js',
      );
      const eventsUri = getWebviewUri('modules/uiManagers/Events.js');
      const constantsUri = getWebviewUri('modules/constants.js');
      const katexMacrosUri = getWebviewUri('modules/katexMacros.js');
      const templateUtilsUri = getCommonUri('modules/templateUtils.js');
      const domUtilsUri = getCommonUri('modules/domUtils.js');
      const stringUtilsUri = getCommonUri('modules/stringUtils.js');

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
        webviewStateUri,
        progressViewStateUri,
        messageHandlersUri,
        domHandlersUri,
        domUtilsUri,
        stringUtilsUri,
        templateUtilsUri,
        webviewContextUri,
        constantsUri,
        katexMacrosUri,
        formattersUri,
        taskManagersUri,
        usageManagersUri,
        streamTabsUri,
        toolbarUri,
        statusUri,
        fileListUri,
        outputStatusUri,
        eventsUri,
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
