// Third-party imports
// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { BaseWebviewProvider } from '@common/webview/BaseWebviewProvider';

// Local imports - components
import { HistoryViewContentProvider } from './HistoryViewContentProvider';
import { HistoryViewMessageHandler } from './HistoryViewMessageHandler';

export class HistoryViewProvider extends BaseWebviewProvider {
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
      ],
    };

    super.resolveWebviewView(webviewView);
  }

  /**
   * Create and show the webview panel (for command palette activation)
   */
  public async showHistoryView() {
    // If we already have a panel, show it
    if (this._view) {
      (this._view as vscode.WebviewPanel).reveal(vscode.ViewColumn.One);
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
        ],
      },
    );

    super.resolveWebviewView(this._view);
    await this.updateWebviewContent();
  }

  // No additional logic needed here; all message handling is delegated
  // to HistoryViewMessageHandler

  /**
   * Update the content of the webview
   */
  private async updateWebviewContent() {
    if (this._view) {
      setTimeout(
        () => this.messageHandler.sendHistoryData(this._view!.webview),
        100,
      );
    }
  }
}
