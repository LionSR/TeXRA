// Third-party imports
import * as vscode from 'vscode';

// Local imports - history view

// Local imports - components
import { HistoryViewContentProvider } from './HistoryViewContentProvider';
import { HistoryViewMessageHandler } from './HistoryViewMessageHandler';

// Local imports - common
import { BaseWebviewProvider } from '@common/webview/BaseWebviewProvider';

export class HistoryViewProvider extends BaseWebviewProvider<vscode.WebviewPanel> {
  public static readonly viewType = 'texra.historyView';

  private historyMessageHandler: HistoryViewMessageHandler;

  constructor(context: vscode.ExtensionContext) {
    super(context);
    this.contentProvider = new HistoryViewContentProvider(context);
    this.historyMessageHandler = new HistoryViewMessageHandler(context);
    this.messageHandler = this.historyMessageHandler as any;
  }

  /**
   * Create and show the webview panel (for command palette activation)
   */
  public async showHistoryView() {
    // If we already have a panel, show it
    if (this.view) {
      this.view.reveal(vscode.ViewColumn.One);
      return;
    }

    // Otherwise, create a new panel
    const panel = vscode.window.createWebviewPanel(
      HistoryViewProvider.viewType,
      'TeXRA History',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'src', 'historyView'),
          vscode.Uri.joinPath(
            this.context.extensionUri,
            'src',
            'common',
            'styles',
          ),
          vscode.Uri.joinPath(
            this.context.extensionUri,
            'src',
            'common',
            'modules',
          ),
          vscode.Uri.joinPath(
            this.context.extensionUri,
            'src',
            'common',
            'webview',
          ),
          vscode.Uri.joinPath(
            this.context.extensionUri,
            'node_modules',
            '@vscode',
            'codicons',
            'dist',
          ),
        ],
      },
    );

    super.resolveWebviewView(panel);

    // Send history data after a short delay to ensure the webview is ready
    setTimeout(
      () => this.historyMessageHandler.sendHistoryData(panel.webview),
      100,
    );
  }
}
