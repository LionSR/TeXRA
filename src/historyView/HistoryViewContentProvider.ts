// Third-party imports
import * as vscode from 'vscode';

// Local imports - history view
import { BaseViewContentProvider, ModuleDescriptor } from '@common/webview';

export class HistoryViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'HistoryView');
  }

  protected getViewPath(): string {
    return 'historyView';
  }

  private readonly moduleDescriptors: ModuleDescriptor[] = [
    { key: 'eventsUri', path: 'modules/uiManagers/HistoryEventsManager.js' },
    {
      key: 'historyRendererUri',
      path: 'modules/uiManagers/HistoryRenderer.js',
    },
    { key: 'historyViewStateUri', path: 'modules/historyViewState.js' },
    { key: 'searchManagerUri', path: 'modules/uiManagers/SearchManager.js' },
  ];

  protected getModuleUris(webview: vscode.Webview): Record<string, vscode.Uri> {
    return this.buildUriRecord(webview, this.moduleDescriptors);
  }
}
