// Local imports - progress view
import { LogEntryFormatter } from './formatters.js';
// Local imports
import { progressViewState } from './progressViewState.js';
import { TaskGroupManager, LogEntryManager } from './taskManagers.js';
import { EventsManager } from './uiManagers/EventsManager.js';
import { FileList } from './uiManagers/FileList.js';
import { Status } from './uiManagers/Status.js';
import { StreamTabs } from './uiManagers/StreamTabs.js';
import { Placeholder } from './uiManagers/Placeholder.js';
import { InstructionPanel } from './uiManagers/InstructionPanel.js';
import { SessionSelector } from './uiManagers/SessionSelector.js';
import { Toolbar } from './uiManagers/Toolbar.js';
import { UsageSummary, UsageGroup } from './usageManagers.js';
import { BaseDomHandler } from '@common/BaseDomHandler.js';

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
      usageGroup: new UsageGroup(usageSummary),
      fileList: new FileList(usageSummary),
      taskGroups: new TaskGroupManager(),
      logEntries: new LogEntryManager(),
      events: new EventsManager(),
      placeholder: new Placeholder(),
      instructionPanel: new InstructionPanel(),
      sessionSelector: new SessionSelector(),
    });
  }
}

export const progressViewDomHandler = new ProgressViewDomHandler();

// Export formatter classes for reuse
export { LogEntryFormatter };
