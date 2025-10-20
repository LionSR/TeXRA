// Local imports - progress view
import { LogEntryFormatter } from './formatters.js';
// Local imports
import { progressViewState } from './progressViewState.js';
import { TaskGroupDomManager, LogEntryManager } from './taskManagers.js';
import { EventsManager } from './uiManagers/EventsManager.js';
import { FileList } from './uiManagers/FileList.js';
import { Status } from './uiManagers/Status.js';
import { StreamTabs } from './uiManagers/StreamTabs.js';
import { Placeholder } from './uiManagers/Placeholder.js';
import { InstructionPanel } from './uiManagers/InstructionPanel.js';
import { FollowUpInputManager } from './uiManagers/FollowUpInputManager.js';
import { Toolbar } from './uiManagers/Toolbar.js';
import { UsageSummary, UsageGroupManager } from './usageManagers.js';
import { BaseDomHandler } from '@common/BaseDomHandler.js';
import { vscode } from '@common/webviewContext.js';

/**
 * Manages all DOM operations for the progress view.
 */
class ProgressViewDomHandler extends BaseDomHandler {
  constructor() {
    const usageSummary = new UsageSummary();
    super({
      streamTabs: new StreamTabs(),
      toolbar: new Toolbar(),
      status: new Status(),
      usageSummary,
      usageGroup: new UsageGroupManager(usageSummary),
      fileList: new FileList(usageSummary),
      taskGroups: new TaskGroupDomManager(),
      logEntries: new LogEntryManager(),
      events: new EventsManager(),
      placeholder: new Placeholder(),
      instructionPanel: new InstructionPanel(),
      followUpInput: new FollowUpInputManager(vscode),
    });
  }
}

export const progressViewDomHandler = new ProgressViewDomHandler();

// Export formatter classes for reuse
export { LogEntryFormatter };
