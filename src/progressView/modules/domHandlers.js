// Local imports
import { progressViewState } from './progressViewState.js';
import { LogEntryFormatter } from './formatters.js';
import { TaskGroupsDom, LogEntriesDom } from './taskManagers.js';
import { UsageSummary, UsageGroup } from './usageManagers.js';
import { StreamTabs } from './uiManagers/StreamTabs.js';
import { Toolbar } from './uiManagers/Toolbar.js';
import { Status } from './uiManagers/Status.js';
import { FileList } from './uiManagers/FileList.js';
import { InputStatus } from './uiManagers/InputStatus.js';
import { Events } from './uiManagers/Events.js';

/**
 * Manages all DOM operations for the progress view.
 */
export class ProgressViewDomHandler {
  constructor() {
    // Initialize managers
    this.streamTabs = new StreamTabs();
    this.toolbar = new Toolbar();
    this.status = new Status();
    this.usageSummary = new UsageSummary();
    this.usageGroup = new UsageGroup(this.usageSummary); // Pass shared instance
    this.fileList = new FileList(this.usageSummary); // Pass shared instance
    this.inputStatus = new InputStatus();
    this.taskGroups = new TaskGroupsDom();
    this.logEntries = new LogEntriesDom();
    this.events = new Events();
  }
}

// Create singleton instance
export const progressViewDomHandler = new ProgressViewDomHandler();

// Export formatter classes for reuse
export { LogEntryFormatter };
