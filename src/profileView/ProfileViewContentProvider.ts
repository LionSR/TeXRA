// Third-party imports
import * as vscode from 'vscode';

// Local imports - profile view
import { BaseViewContentProvider, ModuleDescriptor } from '@common/webview';

export class ProfileViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'ProfileView');
  }

  protected getViewPath(): string {
    return 'profileView';
  }

  private readonly moduleDescriptors: ModuleDescriptor[] = [
    { key: 'profileViewStateUri', path: 'modules/profileViewState.js' },
    { key: 'agentsTableUri', path: 'modules/uiManagers/AgentsTable.js' },
    {
      key: 'profileEventsUri',
      path: 'modules/uiManagers/ProfileEventsManager.js',
    },
  ];

  protected getModuleUris(webview: vscode.Webview): Record<string, vscode.Uri> {
    return this.buildUriRecord(webview, this.moduleDescriptors);
  }
}
