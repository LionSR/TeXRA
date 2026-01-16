// Third-party imports
import * as vscode from 'vscode';

// Local imports - common webview
import { BaseWebviewProvider } from '@common/webview';

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

  protected override getViewPath(): string {
    return 'historyView';
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

    // Send fresh data when revealing existing panel
    if (!isNew && this._view) {
      await this.messageHandler.sendHistoryData(this._view.webview);
    }
    // For new panels: HTML is set by createOrShowPanel -> resolveWebviewViewInternal
    // Webview will request data via GET_HISTORY_DATA on DOMContentLoaded
  }
}
