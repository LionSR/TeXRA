// Third-party imports
import * as vscode from 'vscode';

// Local imports - history view
import {
  BaseViewContentProvider,
  ModuleDescriptor,
} from '@common/webview/BaseViewContentProvider';

export class HistoryViewContentProvider extends BaseViewContentProvider {
  private readonly moduleDescriptors: ModuleDescriptor[] = [
    { key: 'eventsUri', path: 'modules/uiManagers/HistoryEventsManager.js' },
    {
      key: 'historyRendererUri',
      path: 'modules/uiManagers/HistoryRenderer.js',
    },
    { key: 'historyViewStateUri', path: 'modules/historyViewState.js' },
    { key: 'searchManagerUri', path: 'modules/uiManagers/SearchManager.js' },
  ];
  constructor(context: vscode.ExtensionContext) {
    super(context, 'HistoryView');
  }

  protected getViewPath(): string {
    return 'historyView';
  }

  protected getModuleUris(webview: vscode.Webview): Record<string, vscode.Uri> {
    const modules = [
      ...this.sharedModuleDescriptors,
      ...this.moduleDescriptors,
    ];
    const uris: Record<string, vscode.Uri> = {};
    for (const { key, path } of modules) {
      uris[key] = this.getWebviewUri(webview, path);
    }
    return uris;
  }
}
