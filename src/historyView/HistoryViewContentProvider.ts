// Third-party imports
import * as vscode from 'vscode';

// Local imports - history view
import { BaseViewContentProvider } from '@common/webview/BaseViewContentProvider';

export class HistoryViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'HistoryView');
  }

  protected getViewPath(): string {
    return 'historyView';
  }

  protected getModuleUris(webview: vscode.Webview): Record<string, vscode.Uri> {
    return {
      styleUri: this.getWebviewUri(webview, 'styles/index.css'),
      scriptUri: this.getWebviewUri(webview, 'script.js'),

      // History view specific modules
      domHandlersUri: this.getWebviewUri(webview, 'modules/domHandlers.js'),
      constantsUri: this.getWebviewUri(webview, 'modules/constants.js'),
      eventsUri: this.getWebviewUri(
        webview,
        'modules/uiManagers/HistoryEventsManager.js',
      ),
      historyRendererUri: this.getWebviewUri(
        webview,
        'modules/uiManagers/HistoryRenderer.js',
      ),
      historyViewStateUri: this.getWebviewUri(
        webview,
        'modules/historyViewState.js',
      ),
      searchManagerUri: this.getWebviewUri(
        webview,
        'modules/uiManagers/SearchManager.js',
      ),
      messageHandlersUri: this.getWebviewUri(
        webview,
        'modules/messageHandlers.js',
      ),
    };
  }
}
