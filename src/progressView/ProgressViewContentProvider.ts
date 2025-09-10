// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import {
  BaseViewContentProvider,
  ModuleDescriptor,
} from '@common/webview/BaseViewContentProvider';

export class ProgressViewContentProvider extends BaseViewContentProvider {
  private readonly moduleDescriptors: ModuleDescriptor[] = [
    { key: 'progressViewStateUri', path: 'modules/progressViewState.js' },
    { key: 'formattersUri', path: 'modules/formatters.js' },
    { key: 'taskManagersUri', path: 'modules/taskManagers.js' },
    { key: 'usageManagersUri', path: 'modules/usageManagers.js' },
    { key: 'katexMacrosUri', path: 'modules/katexMacros.js' },
    { key: 'themeHandlersUri', path: 'modules/handlers/themeHandlers.js' },
    { key: 'streamTabsUri', path: 'modules/uiManagers/StreamTabs.js' },
    { key: 'toolbarUri', path: 'modules/uiManagers/Toolbar.js' },
    { key: 'statusUri', path: 'modules/uiManagers/Status.js' },
    { key: 'fileListUri', path: 'modules/uiManagers/FileList.js' },
    { key: 'eventsUri', path: 'modules/uiManagers/EventsManager.js' },
    { key: 'placeholderUri', path: 'modules/uiManagers/Placeholder.js' },
  ];
  constructor(context: vscode.ExtensionContext) {
    super(context, 'ProgressView');
  }

  protected getViewPath(): string {
    return 'progressView';
  }

  protected getModuleUris(webview: vscode.Webview): Record<string, vscode.Uri> {
    const modules = [
      ...this.sharedModuleDescriptors,
      ...this.moduleDescriptors,
    ];
    const uris: Record<string, vscode.Uri> = {
      splitJsUri: this.getNodeModulesUri(webview, 'split.js/dist/split.es.js'),
    };
    for (const { key, path } of modules) {
      uris[key] = this.getWebviewUri(webview, path);
    }
    return uris;
  }
}
