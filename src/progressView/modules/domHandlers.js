// Local imports - progress view
import { LogEntryFormatter } from './formatters.js';
// Local imports
import { progressViewState } from './progressViewState.js';
import { TaskGroupManager, LogEntryManager } from './taskManagers.js';
import { EventsManager } from './uiManagers/EventsManager.js';
import { FileList } from './uiManagers/FileList.js';
import { Status } from './uiManagers/Status.js';
import { StreamTabs } from './uiManagers/StreamTabs.js';
import { Toolbar } from './uiManagers/Toolbar.js';
import { UsageSummary, UsageGroup } from './usageManagers.js';

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
    this.taskGroups = new TaskGroupManager();
    this.logEntries = new LogEntryManager();
    this.events = new EventsManager();
  }
}

// Create singleton instance
export const progressViewDomHandler = new ProgressViewDomHandler();

// Export formatter classes for reuse
export { LogEntryFormatter };
