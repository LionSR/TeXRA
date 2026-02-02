import * as vscode from 'vscode';

import { BaseWebviewProvider } from '@common/webview';

import { HistoryViewContentProvider } from './HistoryViewContentProvider';
import { HistoryViewMessageHandler } from './HistoryViewMessageHandler';

export class HistoryViewProvider
  extends BaseWebviewProvider
  implements vscode.WebviewViewProvider
{
  public static readonly viewType = 'texra.historyView';
  protected contentProvider = new HistoryViewContentProvider(this.context);
  protected messageHandler = new HistoryViewMessageHandler(this.context);

  protected override getViewPath(): string {
    return 'historyView';
  }

  public async showHistoryView(): Promise<void> {
    const isNew = this.createOrShowPanel({
      viewType: HistoryViewProvider.viewType,
      title: 'TeXRA History',
      viewPath: 'historyView',
    });

    if (!isNew && this._view) {
      await this.messageHandler.sendHistoryData(this._view.webview);
    }
  }
}
