// Third-party imports
import * as vscode from 'vscode';

// Local imports - profile view
import { BaseViewContentProvider } from '@common/webview';

/** View-specific module descriptors for ProfileView */
const PROFILE_VIEW_MODULES = [
  { key: 'profileViewStateUri', path: 'modules/profileViewState.js' },
  { key: 'agentsTableUri', path: 'modules/uiManagers/AgentsTable.js' },
  {
    key: 'profileEventsUri',
    path: 'modules/uiManagers/ProfileEventsManager.js',
  },
] as const;

export class ProfileViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'ProfileView', PROFILE_VIEW_MODULES);
  }
}
