// Third-party imports
import * as vscode from 'vscode';

// Local imports - history view
import { BaseViewContentProvider } from '@common/webview';

/** View-specific module descriptors for HistoryView */
const HISTORY_VIEW_MODULES = [
  { key: 'eventsUri', path: 'modules/uiManagers/HistoryEventsManager.js' },
  { key: 'historyRendererUri', path: 'modules/uiManagers/HistoryRenderer.js' },
  { key: 'historyViewStateUri', path: 'modules/historyViewState.js' },
  { key: 'searchManagerUri', path: 'modules/uiManagers/SearchManager.js' },
] as const;

export class HistoryViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'HistoryView', HISTORY_VIEW_MODULES);
  }

  protected getViewPath(): string {
    return 'historyView';
  }
}
