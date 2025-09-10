// Third-party imports
import * as vscode from 'vscode';

// Local imports - history view
import {
  BaseViewContentProvider,
  ModuleDescriptor,
} from '@common/webview/BaseViewContentProvider';

export class HistoryViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'HistoryView');
  }

  protected getViewPath(): string {
    return 'historyView';
  }

  protected override moduleDescriptors: ModuleDescriptor[] = [
    { key: 'eventsUri', path: 'modules/uiManagers/HistoryEventsManager.js' },
    {
      key: 'historyRendererUri',
      path: 'modules/uiManagers/HistoryRenderer.js',
    },
    { key: 'historyViewStateUri', path: 'modules/historyViewState.js' },
    { key: 'searchManagerUri', path: 'modules/uiManagers/SearchManager.js' },
  ];
}
