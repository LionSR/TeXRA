// Local imports - progress view
import { COMMANDS, STATUS, ELEMENT_IDS } from './constants.js';
import { progressViewDomHandler, LogEntryFormatter } from './domHandlers.js';
import { createThemeHandlers } from './handlers/themeHandlers.js';
// Local imports - log state
import { progressViewState } from './progressViewState.js';
import { registerMessageHandlers } from '@common/webviewContext.js';

// Create shorter aliases for internal use
const state = progressViewState;
const dom = progressViewDomHandler;

// Create formatter instances

export class ProgressViewMessageHandler {
  constructor() {
    this._cleanupFn = null;
    this._entryFormatter = new LogEntryFormatter();
    this._handlers = {
      ...createThemeHandlers(),
      ...this._createHandlers(),
    };
  }

  _createHandlers() {
    return {
      [COMMANDS.UPDATE_STREAMS]: (m) => this.handleUpdateStreams(m),
      [COMMANDS.UPDATE_LOGS]: (m) => this.handleUpdateLogs(m),
      [COMMANDS.CLEAR_LOGS]: () => this.handleClearLogs(),
      [COMMANDS.APPEND_LOG]: (m) => this.handleAppendLog(m),
      [COMMANDS.UPDATE_LOG]: (m) => this.handleUpdateLog(m),
      [COMMANDS.ADD_TASK_GROUP]: (m) => this.handleAddTaskGroup(m),
      [COMMANDS.UPDATE_TASK_GROUP]: (m) => this.handleUpdateTaskGroup(m),
      [COMMANDS.UPDATE_STATUS]: (m) => this.handleUpdateStatus(m),
      [COMMANDS.UPDATE_USAGE]: (m) => this.handleUpdateUsage(m),
      [COMMANDS.UPDATE_GROUP_USAGE]: (m) => this.handleUpdateGroupUsage(m),
      [COMMANDS.UPDATE_FILES]: (m) => this.handleUpdateFiles(m),
      [COMMANDS.UPDATE_MISSING_OUTPUTS]: (m) =>
        this.handleUpdateMissingOutputs(m),
      [COMMANDS.DELETE_STREAM]: (m) => this.handleDeleteStream(m),
      [COMMANDS.DELETE_ALL]: () => this.handleDeleteAll(),
    };
  }

  setup() {
    this._cleanupFn = registerMessageHandlers(this._handlers);
  }

  cleanup() {
    if (this._cleanupFn) {
      this._cleanupFn();
      this._cleanupFn = null;
    }
  }

  handleUpdateStreams(message) {
    state.activeStream = message.activeStream;
    message.streams.forEach((s) => {
      if (s.status) {
        state.streamStatuses.set(s.name, s.status);
      } else {
        state.streamStatuses.delete(s.name);
      }
    });
    dom.streamTabs.update(message.streams, message.activeStream);

    if (!message.streams || message.streams.length === 0) {
      dom.emptyState.show();
    } else {
      dom.emptyState.hide();
    }

    const container = document.getElementById(ELEMENT_IDS.FOLLOW_UP_CONTAINER);
    if (container) {
      const active = message.streams.find(
        (s) => s.name === message.activeStream,
      );
      container.style.display =
        active && active.agentType === 'toolUse' ? 'flex' : 'none';
    }

    // Update status based on whether there's an active stream
    if (!message.activeStream) {
      dom.status.update(STATUS.READY);
    } else {
      const streamStatus = state.streamStatuses.get(message.activeStream);
      dom.status.update(streamStatus || STATUS.STOPPED);
    }
  }

  handleUpdateLogs(message) {
    const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
    if (!message.stream || message.stream !== state.activeStream) {
      return;
    }

    dom.emptyState.hide();
    logContent.innerHTML = '';
    state.taskGroups.clear();
    if (message.groups && message.groups.length > 0) {
      const parentGroups = message.groups.filter((g) => !g.parentGroupId);
      const childGroups = message.groups.filter((g) => g.parentGroupId);
      parentGroups
        .sort((a, b) => a.startTime - b.startTime)
        .forEach((g) => dom.taskGroups.add(g));
      childGroups
        .sort((a, b) => a.startTime - b.startTime)
        .forEach((g) => dom.taskGroups.add(g));
    }
    const sortedMessages = [...message.messages].sort(
      (a, b) => a.timestamp - b.timestamp,
    );
    sortedMessages.forEach((msg) => {
      if (msg.groupId) {
        if (!dom.logEntries.append(msg)) {
          const formatted = this._entryFormatter.format(msg);
          if (formatted instanceof HTMLElement) {
            logContent.appendChild(formatted);
          } else {
            const el = document.createElement('div');
            el.innerHTML = formatted;
            logContent.appendChild(el.firstElementChild);
          }
        }
      } else {
        const formatted = this._entryFormatter.format(msg);
        if (formatted instanceof HTMLElement) {
          logContent.appendChild(formatted);
        } else {
          const el = document.createElement('div');
          el.innerHTML = formatted;
          logContent.appendChild(el.firstElementChild);
        }
      }
    });
    logContent.scrollTop = logContent.scrollHeight;

    // Recalculate cumulative usage after loading groups
    dom.usageSummary.update();
  }

  handleClearLogs() {
    const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
    logContent.innerHTML = '';
    const groupIds = [];
    const headers = Array.from(document.querySelectorAll('.log-group-header'));
    for (const el of headers) {
      groupIds.push(el.id.replace('group-header-', ''));
    }
    state.taskGroups.clear();
    state.toggleStates.clear(groupIds);
    if (!state.activeStream) {
      dom.emptyState.show();
    }
  }

  handleAppendLog(message) {
    if (message.stream === state.activeStream) {
      const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
      dom.emptyState.hide();
      const addedToGroup = dom.logEntries.append(message.logMessage);
      if (!addedToGroup) {
        const formatted = this._entryFormatter.format(message.logMessage);
        if (formatted instanceof HTMLElement) {
          // For thinking and scratchpad, auto-expand when live streaming
          const messageType = message.logMessage.messageType;
          if (messageType === 'thinking' || messageType === 'scratchpad') {
            formatted.setAttribute('open', '');
            const toggleIcon = formatted.querySelector('.toggle-icon');
            if (toggleIcon) {
              toggleIcon.className = 'codicon codicon-chevron-down toggle-icon';
            }
          }
          logContent.appendChild(formatted);
        } else {
          const el = document.createElement('div');
          el.innerHTML = formatted;
          logContent.appendChild(el.firstElementChild);
        }
      }
      logContent.scrollTop = logContent.scrollHeight;
    }
  }

  handleUpdateLog(message) {
    if (message.stream === state.activeStream) {
      dom.logEntries.update(message.logMessage);
    }
  }

  handleAddTaskGroup(message) {
    if (message.stream === state.activeStream) {
      const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
      dom.emptyState.hide();
      dom.taskGroups.add(message.group);
      logContent.scrollTop = logContent.scrollHeight;
    }
  }

  handleUpdateTaskGroup(message) {
    if (message.stream === state.activeStream) {
      state.taskGroups.update(message.groupId, message.status, message.endTime);
      dom.taskGroups.update(message.groupId, message.status, message.endTime);
    }
  }

  handleUpdateStatus(message) {
    dom.status.update(message.status);
  }

  handleUpdateUsage(message) {
    dom.usageSummary.update(message.usage);
  }

  handleUpdateGroupUsage(message) {
    if (message.stream === state.activeStream) {
      dom.usageGroup.update(message.groupId, message.usage);
    }
  }

  handleUpdateFiles(message) {
    if (message.stream === state.activeStream) {
      dom.fileList.update(message.files);
    }
  }

  handleUpdateMissingOutputs(message) {
    // State persisted server-side - no direct DOM updates needed
  }

  handleDeleteStream(message) {
    if (message.stream) {
      state.streamStatuses.delete(message.stream);
      if (message.stream === state.activeStream) {
        const groupIds = [];
        const headers = Array.from(
          document.querySelectorAll('.log-group-header'),
        );
        for (const el of headers) {
          groupIds.push(el.id.replace('group-header-', ''));
        }
        state.toggleStates.clear(groupIds);
      }
    }
  }

  handleDeleteAll() {
    state.toggleStates.clearAll();
  }
}

export const messageHandler = new ProgressViewMessageHandler();
