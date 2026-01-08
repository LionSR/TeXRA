// Local imports - progress view
// Local imports
import { progressViewState } from './progressViewState.js';
import { TaskGroupDomManager, LogEntryManager } from './taskManagers.js';
import { EventsManager } from './uiManagers/EventsManager.js';
import { FileList } from './uiManagers/FileList.js';
import { Status } from './uiManagers/Status.js';
import { StreamTabs } from './uiManagers/StreamTabs.js';
import { Placeholder } from './uiManagers/Placeholder.js';
import { RunSelector } from './uiManagers/RunSelector.js';
import { InstructionPanel } from './uiManagers/InstructionPanel.js';
import { FollowUpInputManager } from './uiManagers/FollowUpInputManager.js';
import { ApprovalRequests } from './uiManagers/ApprovalRequests.js';
import { RetryRequests } from './uiManagers/RetryRequests.js';
import { Toolbar } from './uiManagers/Toolbar.js';
import { TodoList } from './uiManagers/TodoList.js';
import { QueuedFollowUps } from './uiManagers/QueuedFollowUps.js';
import { UsageSummary } from './usageManagers.js';
import { BaseDomHandler } from '@common/BaseDomHandler.js';
import { vscode } from '@common/webviewContext.js';

/**
 * Manages all DOM operations for the progress view.
 */
class ProgressViewDomHandler extends BaseDomHandler {
  constructor() {
    const usageSummary = new UsageSummary();
    const runSelector = new RunSelector();
    super({
      streamTabs: new StreamTabs(),
      toolbar: new Toolbar(),
      status: new Status(),
      usageSummary,
      fileList: new FileList(),
      runSelector,
      taskGroups: new TaskGroupDomManager(runSelector),
      logEntries: new LogEntryManager(),
      events: new EventsManager(),
      placeholder: new Placeholder(),
      instructionPanel: new InstructionPanel(),
      followUpInput: new FollowUpInputManager(vscode),
      approvalRequests: new ApprovalRequests(),
      retryRequests: new RetryRequests(),
      todoList: new TodoList(),
      queuedFollowUps: new QueuedFollowUps(),
    });
  }
}

export const progressViewDomHandler = new ProgressViewDomHandler();

// Export formatter classes for reuse
