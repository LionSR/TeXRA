// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import { BaseViewContentProvider } from '@common/webview';

/** View-specific module descriptors for ProgressView */
const PROGRESS_VIEW_MODULES = [
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
  { key: 'runSelectorUri', path: 'modules/uiManagers/RunSelector.js' },
  {
    key: 'instructionPanelUri',
    path: 'modules/uiManagers/InstructionPanel.js',
  },
  {
    key: 'followUpInputManagerUri',
    path: 'modules/uiManagers/FollowUpInputManager.js',
  },
  {
    key: 'approvalRequestsUri',
    path: 'modules/uiManagers/ApprovalRequests.js',
  },
  {
    key: 'bashApprovalRequestsUri',
    path: 'modules/uiManagers/BashApprovalRequests.js',
  },
  { key: 'retryRequestsUri', path: 'modules/uiManagers/RetryRequests.js' },
  {
    key: 'workflowProposalsUri',
    path: 'modules/uiManagers/WorkflowProposals.js',
  },
  { key: 'todoListUri', path: 'modules/uiManagers/TodoList.js' },
  {
    key: 'baseUIRequestManagerUri',
    path: 'modules/uiManagers/BaseUIRequestManager.js',
  },
  {
    key: 'followupSectionManagerUri',
    path: 'modules/uiManagers/FollowupSectionManager.js',
  },
] as const;

export class ProgressViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'ProgressView', [...PROGRESS_VIEW_MODULES]);
  }

  protected getViewPath(): string {
    return 'progressView';
  }
}
