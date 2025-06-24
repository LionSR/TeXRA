// Local imports - log state
import { progressViewState } from './progressViewState.js';
import { progressViewDomHandler } from './domHandlers.js';
import { formatLogEntry, getMessageTimestamp } from './logFormatters.js';
import { COMMANDS, STATUS } from './constants.js';
import { registerMessageHandlers } from '@common/webviewContext.js';

const handlers = {
  [COMMANDS.UPDATE_STREAMS]: (message) => {
    progressViewState.setCurrentStream(message.currentStream);
    progressViewDomHandler.streamTabs.update(
      message.streams,
      message.currentStream,
    );

    // Update status based on whether there's an active stream
    if (!message.currentStream) {
      progressViewDomHandler.status.update(STATUS.READY);
    } else {
      const streamStatus = progressViewState.streamStatuses.get(
        message.currentStream,
      );
      progressViewDomHandler.status.update(streamStatus || STATUS.STOPPED);
    }
  },

  [COMMANDS.UPDATE_LOGS]: (message) => {
    const logContent = document.getElementById('logContent');
    if (message.stream === progressViewState.getCurrentStream()) {
      logContent.innerHTML = '';
      progressViewState.logGroups.clear();
      if (message.groups && message.groups.length > 0) {
        const parentGroups = message.groups.filter((g) => !g.parentGroupId);
        const childGroups = message.groups.filter((g) => g.parentGroupId);
        parentGroups
          .sort((a, b) => a.startTime - b.startTime)
          .forEach((g) => progressViewDomHandler.logGroups.add(g));
        childGroups
          .sort((a, b) => a.startTime - b.startTime)
          .forEach((g) => progressViewDomHandler.logGroups.add(g));
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
          if (!progressViewDomHandler.logEntries.append(msg)) {
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
      progressViewDomHandler.usageSummary.update();
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
    progressViewState.logGroups.clear();
    progressViewState.toggleStates.clear(groupIds);
  },

  [COMMANDS.APPEND_LOG]: (message) => {
    if (message.stream === progressViewState.getCurrentStream()) {
      const logContent = document.getElementById('logContent');
      const addedToGroup = progressViewDomHandler.logEntries.append(
        message.logMessage,
      );
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
      progressViewDomHandler.logEntries.update(message.logMessage);
    }
  },

  [COMMANDS.ADD_LOG_GROUP]: (message) => {
    if (message.stream === progressViewState.getCurrentStream()) {
      const logContent = document.getElementById('logContent');
      progressViewDomHandler.logGroups.add(message.group);
      logContent.scrollTop = logContent.scrollHeight;
    }
  },

  [COMMANDS.UPDATE_LOG_GROUP]: (message) => {
    if (message.stream === progressViewState.getCurrentStream()) {
      progressViewState.logGroups.update(
        message.groupId,
        message.status,
        message.endTime,
      );
      progressViewDomHandler.logGroups.update(
        message.groupId,
        message.status,
        message.endTime,
      );
    }
  },

  [COMMANDS.UPDATE_STATUS]: (message) => {
    progressViewDomHandler.status.update(message.status);
  },

  [COMMANDS.UPDATE_USAGE]: (message) => {
    progressViewDomHandler.usageSummary.update(message.usage);
  },

  [COMMANDS.UPDATE_GROUP_USAGE]: (message) => {
    if (message.stream === progressViewState.getCurrentStream()) {
      progressViewDomHandler.usageGroup.update(message.groupId, message.usage);
    }
  },

  [COMMANDS.UPDATE_FILES]: (message) => {
    if (message.stream === progressViewState.getCurrentStream()) {
      progressViewDomHandler.fileList.update(message.files);
    }
  },

  [COMMANDS.DELETE_STREAM]: (message) => {
    if (message.stream) {
      progressViewState.streamStatuses.delete(message.stream);
      if (message.stream === progressViewState.getCurrentStream()) {
        const groupIds = [];
        const headers = Array.from(
          document.querySelectorAll('.log-group-header'),
        );
        for (const el of headers) {
          groupIds.push(el.id.replace('group-header-', ''));
        }
        progressViewState.toggleStates.clear(groupIds);
      }
    }
  },

  [COMMANDS.DELETE_ALL]: () => {
    progressViewState.toggleStates.clearAll();
  },
};

/**
 * Sets up the message handler for messages from the extension
 */
export function setupMessageHandlers() {
  registerMessageHandlers(handlers);
}
