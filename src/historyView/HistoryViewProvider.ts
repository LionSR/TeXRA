// Third-party imports
import * as vscode from 'vscode';

// Local imports - common webview
import { BaseWebviewProvider } from '@common/webview/BaseWebviewProvider';

// Local imports - history view components
import { HistoryViewContentProvider } from './HistoryViewContentProvider';
import { HistoryViewMessageHandler } from './HistoryViewMessageHandler';

export class HistoryViewProvider
  extends BaseWebviewProvider
  implements vscode.WebviewViewProvider
{
  public static readonly viewType = 'texra.historyView';
  protected contentProvider: HistoryViewContentProvider;
  protected messageHandler: HistoryViewMessageHandler;

  constructor(protected readonly context: vscode.ExtensionContext) {
    super(context);
    this.contentProvider = new HistoryViewContentProvider(context);
    this.messageHandler = new HistoryViewMessageHandler(context);
  }

  /**
   * Resolve webview for potential sidebar integration.
   */
  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
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
          '@vscode-elements',
          'elements',
          'dist',
        ),
      ],
    };

    super.resolveWebviewViewInternal(webviewView);
  }

  /**
   * Create and show the webview panel (for command palette activation)
   */
  public async showHistoryView() {
    // If we already have a panel, show it
    if (this._view && 'reveal' in this._view) {
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
            '@vscode-elements',
            'elements',
            'dist',
          ),
        ],
      },
    );

    super.resolveWebviewViewInternal(this._view);
    await this.updateWebviewContent();
  }

  // No additional logic needed here; all message handling is delegated
  // to HistoryViewMessageHandler

  /**
   * Update the content of the webview
   */
  private async updateWebviewContent() {
    if (this._view) {
      try {
        // Set the HTML content first
        this._view.webview.html = await this.contentProvider.getHtmlContent(
          this._view.webview,
        );
      } catch (error) {
        console.error('Error updating history view content', error);
        this._view.webview.html =
          '<html><body>Error loading content</body></html>';
      }
      // Then send the history data after a short delay
      setTimeout(() => {
        if (this._view) {
          this.messageHandler.sendHistoryData(this._view.webview);
        }
      }, 100);
    }
  }
}
