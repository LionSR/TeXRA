// Standard library imports

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { getConfig } from '@utils/config';
import { buildWebviewHtml } from '@frontend/webview/html';

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
      const webviewStateModuleUri = getWebviewUri('modules/webviewState.js');
      const messageHandlersUri = getWebviewUri('modules/messageHandlers.js');
      const fileHandlersUri = getWebviewUri('modules/fileHandlers.js');
      const fileListUri = getWebviewUri('modules/uiManagers/FileList.js');
      const fileSelectUri = getWebviewUri('modules/uiManagers/FileSelect.js');
      const toggleManagerUri = getWebviewUri(
        'modules/uiManagers/ToggleManager.js',
      );
      const fileInputManagerUri = getWebviewUri(
        'modules/uiManagers/FileInputManager.js',
      );
      const actionButtonManagerUri = getWebviewUri(
        'modules/uiManagers/ActionButtonManager.js',
      );
      const settingsButtonManagerUri = getWebviewUri(
        'modules/uiManagers/SettingsButtonManager.js',
      );
      const recordingManagerUri = getWebviewUri(
        'modules/uiManagers/RecordingManager.js',
      );
      const instructionManagerUri = getWebviewUri(
        'modules/uiManagers/InstructionManager.js',
      );
      const domHandlersUri = getWebviewUri('modules/domHandlers.js');
      const templateUtilsUri = getCommonUri('modules/templateUtils.js');
      const domUtilsUri = getCommonUri('modules/domUtils.js');
      const stringUtilsUri = getCommonUri('modules/stringUtils.js');
      const webviewContextUri = getCommonUri('modules/webviewContext.js');

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
      
      // Debug: Log the URIs being passed to template
      logger.debug(CHANNEL, `Generated URIs: fileListUri=${fileListUri}, messageHandlersUri=${messageHandlersUri}`);
      
      const htmlContent = buildWebviewHtml(webview, htmlPath, {
        commonStyleUri,
        styleUri,
        scriptUri,
        agentOptions,
        modelOptions,
        domUtilsUri,
        stringUtilsUri,
        webviewStateUri,
        webviewStateModuleUri,
        messageHandlersUri,
        fileHandlersUri,
        fileListUri,
        fileSelectUri,
        toggleManagerUri,
        fileInputManagerUri,
        actionButtonManagerUri,
        settingsButtonManagerUri,
        recordingManagerUri,
        instructionManagerUri,
        domHandlersUri,
        templateUtilsUri,
        webviewContextUri,
        codiconUri,
        codiconsFontUri,
        // Add missing URIs that might be referenced (set to empty to avoid errors)
        streamTabsUri: '',
        toolbarUri: '',
        statusUri: '',
        eventsUri: '',
      });
      
      // Debug: Log a snippet of the generated HTML
      logger.debug(CHANNEL, `Generated HTML snippet: ${htmlContent.substring(0, 500)}...`);
      
      return htmlContent;
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error generating HTML content: ${err instanceof Error ? err.message : String(err)}`,
      );
      return '<html><body>Error loading content</body></html>';
    }
  }
}
