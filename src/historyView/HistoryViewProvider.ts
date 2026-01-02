// Third-party imports
import * as vscode from 'vscode';

// Local imports - common webview
import { BaseWebviewProvider } from '@common/webview';
import { getSharedLocalResourceRoots } from '@common/webview';

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
      localResourceRoots: getSharedLocalResourceRoots(
        this.context,
        'historyView',
      ),
    };

    super.resolveWebviewViewInternal(webviewView);
  }

  /**
   * Create and show the webview panel (for command palette activation)
   */
  public async showHistoryView() {
    const isNew = this.createOrShowPanel({
      viewType: HistoryViewProvider.viewType,
      title: 'TeXRA History',
      viewPath: 'historyView',
    });

    if (isNew) {
      await this.updateWebviewContent();
    }
  }

  // No additional logic needed here; all message handling is delegated
  // to HistoryViewMessageHandler

  /**
   * Update the content of the webview
   */
  private async updateWebviewContent() {
    if (this._view) {
      // Set the HTML content first
      this._view.webview.html = this.contentProvider.getHtmlContent(
        this._view.webview,
      );
      // Then send the history data after a short delay
      setTimeout(() => {
        if (this._view) {
          this.messageHandler.sendHistoryData(this._view.webview);
        }
      }, 100);
    }
  }
}
