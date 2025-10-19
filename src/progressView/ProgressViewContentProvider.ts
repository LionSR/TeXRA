// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import {
  BaseViewContentProvider,
  ModuleDescriptor,
} from '@common/webview/BaseViewContentProvider';

export class ProgressViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'ProgressView');
  }

  protected getViewPath(): string {
    return 'progressView';
  }

  private readonly moduleDescriptors: ModuleDescriptor[] = [
    { key: 'progressViewStateUri', path: 'modules/progressViewState.js' },
    { key: 'formattersUri', path: 'modules/formatters.js' },
    { key: 'taskManagersUri', path: 'modules/taskManagers.js' },
    { key: 'utilsUri', path: 'modules/utils.js' },
    { key: 'usageManagersUri', path: 'modules/usageManagers.js' },
    { key: 'katexMacrosUri', path: 'modules/katexMacros.js' },
    { key: 'themeHandlersUri', path: 'modules/handlers/themeHandlers.js' },

    // UI managers
    { key: 'streamTabsUri', path: 'modules/uiManagers/StreamTabs.js' },
    { key: 'toolbarUri', path: 'modules/uiManagers/Toolbar.js' },
    { key: 'statusUri', path: 'modules/uiManagers/Status.js' },
    { key: 'fileListUri', path: 'modules/uiManagers/FileList.js' },
    { key: 'eventsUri', path: 'modules/uiManagers/EventsManager.js' },
    { key: 'placeholderUri', path: 'modules/uiManagers/Placeholder.js' },
    {
      key: 'instructionPanelUri',
      path: 'modules/uiManagers/InstructionPanel.js',
    },
    {
      key: 'followUpInputUri',
      path: 'modules/uiManagers/FollowUpInputManager.js',
    },
  ];

  protected getModuleUris(webview: vscode.Webview): Record<string, vscode.Uri> {
    return {
      ...this.buildUriRecord(webview, this.moduleDescriptors),
      splitJsUri: this.getNodeModulesUri(webview, 'split.js/dist/split.es.js'),
    };
  }
}
