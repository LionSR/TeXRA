import * as vscode from 'vscode';
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
      styleUri: this.getWebviewUri(webview, 'styles/style.css'),
      scriptUri: this.getWebviewUri(webview, 'script.js'),

      // History view specific modules
      domHandlersUri: this.getWebviewUri(webview, 'modules/domHandlers.js'),
      historyEventsUri: this.getWebviewUri(
        webview,
        'modules/uiManagers/historyEvents.js',
      ),
      historyRendererUri: this.getWebviewUri(
        webview,
        'modules/uiManagers/historyRenderer.js',
      ),
      historyViewStateUri: this.getWebviewUri(
        webview,
        'modules/historyViewState.js',
      ),
      searchManagerUri: this.getWebviewUri(
        webview,
        'modules/uiManagers/searchManager.js',
      ),
      messageHandlersUri: this.getWebviewUri(
        webview,
        'modules/messageHandlers.js',
      ),
    };
  }
}
