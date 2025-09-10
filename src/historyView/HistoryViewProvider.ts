// Third-party imports
// Third-party imports
import * as vscode from 'vscode';

// Local imports - history view

// Local imports - components
import { HistoryViewContentProvider } from './HistoryViewContentProvider';
import { HistoryViewMessageHandler } from './HistoryViewMessageHandler';

export class HistoryViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'texra.historyView';
  private _view?: vscode.WebviewPanel;
  private readonly contentProvider: HistoryViewContentProvider;
  private readonly messageHandler: HistoryViewMessageHandler;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.contentProvider = new HistoryViewContentProvider(context);
    this.messageHandler = new HistoryViewMessageHandler(context);
  }

  /**
   * This is required for the WebviewViewProvider interface but we won't use it
   * as we're removing the sidebar integration
   */
  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    // We no longer use webview in the sidebar, but we need this method for the interface
  }

  /**
   * Create and show the webview panel (for command palette activation)
   */
  public async showHistoryView() {
    // If we already have a panel, show it
    if (this._view) {
      this._view.reveal(vscode.ViewColumn.One);
      return;
    }

    // Otherwise, create a new panel
    this._view = vscode.window.createWebviewPanel(
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
          vscode.Uri.joinPath(
            this.context.extensionUri,
            'node_modules',
            'perfect-debounce',
            'dist',
          ),
        ],
      },
    );

    // Handle webview disposal
    this._view.onDidDispose(() => {
      this._view = undefined;
    });

    // Handle messages from the webview
    this._view.webview.onDidReceiveMessage(async (message) => {
      await this.messageHandler.handleMessage(
        message,
        this._view as unknown as vscode.WebviewView,
      );
    });

    // Set initial HTML content
    await this.updateWebviewContent();
  }

  // No additional logic needed here; all message handling is delegated
  // to HistoryViewMessageHandler

  /**
   * Update the content of the webview
   */
  private async updateWebviewContent() {
    if (this._view) {
      this._view.webview.html = this.contentProvider.getHtmlContent(
        this._view.webview,
      );

      // Send history data after a short delay to ensure the webview is ready
      setTimeout(
        () => this.messageHandler.sendHistoryData(this._view!.webview),
        100,
      );
    }
  }
}
