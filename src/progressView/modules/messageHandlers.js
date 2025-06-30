// Local imports - log state
import { progressViewState } from './progressViewState.js';
import { progressViewDomHandler, LogEntryFormatter } from './domHandlers.js';
import { COMMANDS, STATUS } from './constants.js';
import { registerMessageHandlers } from '@common/webviewContext.js';

// Create shorter aliases for internal use
const state = progressViewState;
const dom = progressViewDomHandler;

// Create formatter instances
const entryFormatter = new LogEntryFormatter();

const handlers = {
  [COMMANDS.UPDATE_STREAMS]: (message) => {
    state.setCurrentStream(message.currentStream);
    if (Array.isArray(message.streams)) {
      state.streamNames = new Map(message.streams.map((s) => [s.id, s.name]));
    }
    dom.streamTabs.update(message.streams, message.currentStream);

    // Update status based on whether there's an active stream
    if (!message.currentStream) {
      dom.status.update(STATUS.READY);
    } else {
      const streamStatus = state.streamStatuses.get(message.currentStream);
      dom.status.update(streamStatus || STATUS.STOPPED);
    }
  },

  [COMMANDS.UPDATE_LOGS]: (message) => {
    const logContent = document.getElementById('logContent');
    if (message.stream === state.getCurrentStream()) {
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
            const el = document.createElement('div');
            el.innerHTML = entryFormatter.format(msg);
            logContent.appendChild(el.firstElementChild);
          }
        } else {
          const el = document.createElement('div');
          el.innerHTML = entryFormatter.format(msg);
          logContent.appendChild(el.firstElementChild);
        }
      });
      logContent.scrollTop = logContent.scrollHeight;

      // Recalculate cumulative usage after loading groups
      dom.usageSummary.update();
    }
  },

  [COMMANDS.CLEAR_LOGS]: () => {
    const logContent = document.getElementById('logContent');
    logContent.innerHTML = '';
    const groupIds = [];
    const headers = Array.from(document.querySelectorAll('.log-group-header'));
    for (const el of headers) {
      groupIds.push(el.id.replace('group-header-', ''));
    }
    state.taskGroups.clear();
    state.toggleStates.clear(groupIds);
  },

  [COMMANDS.APPEND_LOG]: (message) => {
    if (message.stream === state.getCurrentStream()) {
      const logContent = document.getElementById('logContent');
      const addedToGroup = dom.logEntries.append(message.logMessage);
      if (!addedToGroup) {
        const el = document.createElement('div');
        el.innerHTML = entryFormatter.format(message.logMessage);
        logContent.appendChild(el.firstElementChild);
      }
      logContent.scrollTop = logContent.scrollHeight;
    }
  },

  [COMMANDS.UPDATE_LOG]: (message) => {
    if (message.stream === state.getCurrentStream()) {
      dom.logEntries.update(message.logMessage);
    }
  },

  [COMMANDS.ADD_LOG_GROUP]: (message) => {
    if (message.stream === state.getCurrentStream()) {
      const logContent = document.getElementById('logContent');
      dom.taskGroups.add(message.group);
      logContent.scrollTop = logContent.scrollHeight;
    }
  },

  [COMMANDS.UPDATE_LOG_GROUP]: (message) => {
    if (message.stream === state.getCurrentStream()) {
      state.taskGroups.update(message.groupId, message.status, message.endTime);
      dom.taskGroups.update(message.groupId, message.status, message.endTime);
    }
  },

  [COMMANDS.UPDATE_STATUS]: (message) => {
    dom.status.update(message.status);
  },

  [COMMANDS.UPDATE_USAGE]: (message) => {
    dom.usageSummary.update(message.usage);
  },

  [COMMANDS.UPDATE_GROUP_USAGE]: (message) => {
    if (message.stream === state.getCurrentStream()) {
      dom.usageGroup.update(message.groupId, message.usage);
    }
  },

  [COMMANDS.UPDATE_FILES]: (message) => {
    if (message.stream === state.getCurrentStream()) {
      dom.fileList.update(message.files);
    }
  },

  [COMMANDS.DELETE_STREAM]: (message) => {
    if (message.stream) {
      state.streamStatuses.delete(message.stream);
      if (message.stream === state.getCurrentStream()) {
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
  },

  [COMMANDS.DELETE_ALL]: () => {
    state.toggleStates.clearAll();
  },
};

/**
 * Sets up the message handler for messages from the extension
 */
export function setupMessageHandlers() {
  registerMessageHandlers(handlers);
}
