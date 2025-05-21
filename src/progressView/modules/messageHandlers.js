import {
  getCurrentStream,
  setCurrentStream,
  clearLogGroups,
  clearGroupToggleStates,
  deleteStreamStatus,
  clearAllGroupToggleStates,
} from './stateManager.js';
import {
  updateStreamTabs,
  updateStatus,
  addLogGroup,
  updateLogGroupUI,
  appendLogToGroup,
  updateFileList,
} from './domHandlers.js';
import {
  formatLogEntry,
  getMessageTimestamp,
  updateLogGroup,
} from './logFormatters.js';
import { COMMANDS } from './constants.js';

/**
 * Sets up the message handler for messages from the extension
 */
export function setupMessageHandlers() {
  window.addEventListener('message', (event) => {
    const message = event.data;
    const logContent = document.getElementById('logContent');

    switch (message.command) {
      case COMMANDS.UPDATE_STREAMS:
        setCurrentStream(message.currentStream);
        updateStreamTabs(message.streams, message.currentStream);
        break;

      case COMMANDS.UPDATE_LOGS:
        if (message.stream === getCurrentStream()) {
          // Reset log content and log groups
          logContent.innerHTML = '';
          clearLogGroups();
          // Keep the toggle states intact - we don't clear groupToggleStates

          // Process groups in parent-child order AND chronologically
          if (message.groups && message.groups.length > 0) {
            // First identify parent groups and child groups
            const parentGroups = message.groups.filter((g) => !g.parentGroupId);
            const childGroups = message.groups.filter((g) => g.parentGroupId);

            // Sort parent groups by timestamp
            parentGroups.sort((a, b) => {
              const timeA = new Date(a.startTime);
              const timeB = new Date(b.startTime);
              return timeA - timeB;
            });

            // Add parent groups first
            parentGroups.forEach((group) => {
              addLogGroup(group);
            });

            // Sort child groups by timestamp
            childGroups.sort((a, b) => {
              const timeA = new Date(a.startTime);
              const timeB = new Date(b.startTime);
              return timeA - timeB;
            });

            // Then add child groups (after parents are in place)
            childGroups.forEach((group) => {
              addLogGroup(group);
            });
          }

          // Now add messages to their groups - sort them by timestamp first
          // This ensures we process messages in chronological order
          const sortedMessages = [...message.messages].sort((a, b) => {
            const timestampA = getMessageTimestamp(a.message);
            const timestampB = getMessageTimestamp(b.message);

            // Try to use Date objects for more accurate comparison
            const dateA = timestampA.includes('-')
              ? new Date(timestampA)
              : null;
            const dateB = timestampB.includes('-')
              ? new Date(timestampB)
              : null;

            if (dateA && dateB) {
              return dateA - dateB;
            }

            // Fallback to string comparison
            return timestampA.localeCompare(timestampB);
          });

          sortedMessages.forEach((msg) => {
            if (msg.groupId) {
              // Try to append to a group first
              if (!appendLogToGroup(msg)) {
                // If group doesn't exist, append to main content
                const messageElement = document.createElement('div');
                messageElement.innerHTML = formatLogEntry(msg);
                logContent.appendChild(messageElement.firstElementChild);
              }
            } else {
              // Messages without group ID
              const messageElement = document.createElement('div');
              messageElement.innerHTML = formatLogEntry(msg);
              logContent.appendChild(messageElement.firstElementChild);
            }
          });

          logContent.scrollTop = logContent.scrollHeight;
        }
        break;

      case COMMANDS.CLEAR_LOGS:
        logContent.innerHTML = '';

        // Get all group IDs from this stream to clear toggle states
        const groupIds = [];
        const headerElements = Array.from(
          document.querySelectorAll('.log-group-header'),
        );
        for (const el of headerElements) {
          groupIds.push(el.id.replace('group-header-', ''));
        }

        // Clear the log groups for this stream
        clearLogGroups();

        // Clear toggle states for these groups
        clearGroupToggleStates(groupIds);
        break;

      case COMMANDS.APPEND_LOG:
        if (message.stream === getCurrentStream()) {
          // Try to append to a group first
          const addedToGroup = appendLogToGroup(message.logMessage);

          // If not added to a group, append to main content
          if (!addedToGroup) {
            const messageElement = document.createElement('div');
            messageElement.innerHTML = formatLogEntry(message.logMessage);
            logContent.appendChild(messageElement.firstElementChild);
          }

          logContent.scrollTop = logContent.scrollHeight;
        }
        break;

      case COMMANDS.ADD_LOG_GROUP:
        if (message.stream === getCurrentStream()) {
          addLogGroup(message.group);
          logContent.scrollTop = logContent.scrollHeight;
        }
        break;

      case COMMANDS.UPDATE_LOG_GROUP:
        if (message.stream === getCurrentStream()) {
          updateLogGroup(message.groupId, message.status, message.endTime);
          updateLogGroupUI(message.groupId, message.status, message.endTime);
        }
        break;

      case COMMANDS.UPDATE_STATUS:
        updateStatus(message.status);
        break;

      case COMMANDS.UPDATE_FILES:
        if (message.stream === getCurrentStream()) {
          updateFileList(message.files);
        }
        break;

      case COMMANDS.OPEN_FILE:
        // no-op in webview, handled in extension
        break;
      case COMMANDS.COMPARE_ORIGINAL:
      case COMMANDS.COMPARE_PREVIOUS:
      case COMMANDS.ACCEPT_FILE:
      case COMMANDS.MERGE_FILE:
      case COMMANDS.LATEXDIFF_FILE:
        // handled in extension
        break;

      case COMMANDS.DELETE_STREAM:
        if (message.stream) {
          // Handle deleting a stream
          deleteStreamStatus(message.stream);

          // If active stream was deleted, we should clear the toggle states
          // for any groups that were in that stream
          if (message.stream === getCurrentStream()) {
            const groupIds = [];
            const headerElements = Array.from(
              document.querySelectorAll('.log-group-header'),
            );
            for (const el of headerElements) {
              groupIds.push(el.id.replace('group-header-', ''));
            }

            // Clear toggle states for these groups
            clearGroupToggleStates(groupIds);
          }
        }
        break;

      case COMMANDS.DELETE_ALL:
        // When deleting all streams, clear all toggle states as well
        clearAllGroupToggleStates();
        break;
    }
  });
}
