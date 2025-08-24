// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import { BaseViewContentProvider } from '@common/webview/BaseViewContentProvider';

export class ProgressViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'ProgressView');
  }

  protected getViewPath(): string {
    return 'progressView';
  }

  protected getModuleUris(webview: vscode.Webview): Record<string, vscode.Uri> {
    return {
      styleUri: this.getWebviewUri(webview, 'styles/index.css'),
      scriptUri: this.getWebviewUri(webview, 'script.js'),
      splitJsUri: this.getNodeModulesUri(webview, 'split.js/dist/split.es.js'),

      // Progress view specific modules
      progressViewStateUri: this.getWebviewUri(
        webview,
        'modules/progressViewState.js',
      ),
      messageHandlersUri: this.getWebviewUri(
        webview,
        'modules/messageHandlers.js',
      ),
      domHandlersUri: this.getWebviewUri(webview, 'modules/domHandlers.js'),
      formattersUri: this.getWebviewUri(webview, 'modules/formatters.js'),
      taskManagersUri: this.getWebviewUri(webview, 'modules/taskManagers.js'),
      usageManagersUri: this.getWebviewUri(webview, 'modules/usageManagers.js'),
      constantsUri: this.getWebviewUri(webview, 'modules/constants.js'),
      katexMacrosUri: this.getWebviewUri(webview, 'modules/katexMacros.js'),
      themeHandlersUri: this.getWebviewUri(
        webview,
        'modules/handlers/themeHandlers.js',
      ),

      // UI managers
      streamTabsUri: this.getWebviewUri(
        webview,
        'modules/uiManagers/StreamTabs.js',
      ),
      toolbarUri: this.getWebviewUri(webview, 'modules/uiManagers/Toolbar.js'),
      statusUri: this.getWebviewUri(webview, 'modules/uiManagers/Status.js'),
      fileListUri: this.getWebviewUri(
        webview,
        'modules/uiManagers/FileList.js',
      ),
      eventsUri: this.getWebviewUri(
        webview,
        'modules/uiManagers/EventsManager.js',
      ),
      placeholderUri: this.getWebviewUri(
        webview,
        'modules/uiManagers/Placeholder.js',
      ),
    };
  }
}
