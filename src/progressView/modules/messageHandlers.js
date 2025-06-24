// Local imports - log state
import { progressViewState } from './progressViewState.js';
import {
  updateStreamTabs,
  updateStatus,
  addLogGroup,
  updateLogGroupUI,
  appendLogToGroup,
  updateLogEntry,
  updateFileList,
  updateUsageSummary,
  updateGroupUsage,
} from './domHandlers.js';
import { formatLogEntry, getMessageTimestamp } from './logFormatters.js';
import { COMMANDS } from './constants.js';
import { registerMessageHandlers } from '@common/webviewContext.js';

const handlers = {
  [COMMANDS.UPDATE_STREAMS]: (message) => {
    progressViewState.setCurrentStream(message.currentStream);
    updateStreamTabs(message.streams, message.currentStream);
  },

  [COMMANDS.UPDATE_LOGS]: (message) => {
    const logContent = document.getElementById('logContent');
    if (message.stream === progressViewState.getCurrentStream()) {
      logContent.innerHTML = '';
      progressViewState.clearLogGroups();
      if (message.groups && message.groups.length > 0) {
        const parentGroups = message.groups.filter((g) => !g.parentGroupId);
        const childGroups = message.groups.filter((g) => g.parentGroupId);
        parentGroups
          .sort((a, b) => a.startTime - b.startTime)
          .forEach((g) => addLogGroup(g));
        childGroups
          .sort((a, b) => a.startTime - b.startTime)
          .forEach((g) => addLogGroup(g));
      }
      const sortedMessages = [...message.messages].sort((a, b) => {
        if (a.timestamp !== undefined && b.timestamp !== undefined) {
          return a.timestamp - b.timestamp;
        }
        if (a.timestamp !== undefined) return -1;
        if (b.timestamp !== undefined) return 1;
        const aTs = getMessageTimestamp(a.message);
        const bTs = getMessageTimestamp(b.message);
        return aTs.localeCompare(bTs);
      });
      sortedMessages.forEach((msg) => {
        if (msg.groupId) {
          if (!appendLogToGroup(msg)) {
            const el = document.createElement('div');
            el.innerHTML = formatLogEntry(msg);
            logContent.appendChild(el.firstElementChild);
          }
        } else {
          const el = document.createElement('div');
          el.innerHTML = formatLogEntry(msg);
          logContent.appendChild(el.firstElementChild);
        }
      });
      logContent.scrollTop = logContent.scrollHeight;

      // Recalculate cumulative usage after loading groups
      updateUsageSummary();
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
    progressViewState.clearLogGroups();
    progressViewState.clearGroupToggleStates(groupIds);
  },

  [COMMANDS.APPEND_LOG]: (message) => {
    if (message.stream === progressViewState.getCurrentStream()) {
      const logContent = document.getElementById('logContent');
      const addedToGroup = appendLogToGroup(message.logMessage);
      if (!addedToGroup) {
        const el = document.createElement('div');
        el.innerHTML = formatLogEntry(message.logMessage);
        logContent.appendChild(el.firstElementChild);
      }
      logContent.scrollTop = logContent.scrollHeight;
    }
  },

  [COMMANDS.UPDATE_LOG]: (message) => {
    if (message.stream === progressViewState.getCurrentStream()) {
      updateLogEntry(message.logMessage);
    }
  },

  [COMMANDS.ADD_LOG_GROUP]: (message) => {
    if (message.stream === progressViewState.getCurrentStream()) {
      const logContent = document.getElementById('logContent');
      addLogGroup(message.group);
      logContent.scrollTop = logContent.scrollHeight;
    }
  },

  [COMMANDS.UPDATE_LOG_GROUP]: (message) => {
    if (message.stream === progressViewState.getCurrentStream()) {
      progressViewState.updateLogGroup(
        message.groupId,
        message.status,
        message.endTime,
      );
      updateLogGroupUI(message.groupId, message.status, message.endTime);
    }
  },

  [COMMANDS.UPDATE_STATUS]: (message) => {
    updateStatus(message.status);
  },

  [COMMANDS.UPDATE_USAGE]: (message) => {
    updateUsageSummary(message.usage);
  },

  [COMMANDS.UPDATE_GROUP_USAGE]: (message) => {
    if (message.stream === progressViewState.getCurrentStream()) {
      updateGroupUsage(message.groupId, message.usage);
    }
  },

  [COMMANDS.UPDATE_FILES]: (message) => {
    if (message.stream === progressViewState.getCurrentStream()) {
      updateFileList(message.files);
    }
  },

  [COMMANDS.DELETE_STREAM]: (message) => {
    if (message.stream) {
      progressViewState.deleteStreamStatus(message.stream);
      if (message.stream === progressViewState.getCurrentStream()) {
        const groupIds = [];
        const headers = Array.from(
          document.querySelectorAll('.log-group-header'),
        );
        for (const el of headers) {
          groupIds.push(el.id.replace('group-header-', ''));
        }
        progressViewState.clearGroupToggleStates(groupIds);
      }
    }
  },

  [COMMANDS.DELETE_ALL]: () => {
    progressViewState.clearAllGroupToggleStates();
  },
};

/**
 * Sets up the message handler for messages from the extension
 */
export function setupMessageHandlers() {
  registerMessageHandlers(handlers);
}
