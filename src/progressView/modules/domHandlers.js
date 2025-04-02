import { vscode } from './vscodeApi.js';
import {
  getCurrentStream,
  setStreamStatus,
  getGroupToggleState,
  setGroupToggleState,
  setLogGroup,
  getLogGroup,
  getLogGroups,
  getStreamStatus,
  clearAllGroupToggleStates,
  saveState,
} from './stateManager.js';
import {
  createGroupHeader,
  getMessageTimestamp,
  formatLogEntry,
  getStatusIcon,
  formatDuration,
} from './logFormatters.js';
import { STATUS, COMMANDS, SPLIT_SIZES } from './constants.js';

import Split from 'split.js';

/**
 * Updates UI to show stream tabs and highlight the active stream
 * @param {Array} streams - Array of stream names
 * @param {string} activeStream - Currently active stream
 */
export function updateStreamTabs(streams, activeStream) {
  const tabsContainer = document.getElementById('streamTabs');
  tabsContainer.innerHTML = streams
    .map(
      (stream) =>
        `<div class="tab-container ${stream === activeStream ? 'active' : ''}">
          <button class="tab" data-stream="${stream}">${stream}</button>
          <button class="tab-delete" data-stream="${stream}" title="Delete stream">
            <i class="codicon codicon-trash"></i>
          </button>
        </div>`,
    )
    .join('');

  // Update current stream name
  document.getElementById('currentStreamName').textContent = activeStream;

  // Update status based on whether there's an active stream
  if (!activeStream) {
    updateStatus(STATUS.READY);
  } else {
    const streamStatus = getStreamStatus(activeStream);
    updateStatus(streamStatus || STATUS.STOPPED);
  }
}

/**
 * Updates the stream status indicator and enables/disables buttons accordingly
 * @param {string} status - The status to set
 */
export function updateStatus(status) {
  const statusIndicator = document.getElementById('statusIndicator');
  const stopButton = document.getElementById('stopStreamBtn');
  const runAgainBtn = document.getElementById('runAgainBtn');
  const packButton = document.getElementById('packStreamBtn');
  const cleanButton = document.getElementById('cleanStreamBtn');
  const restoreButton = document.getElementById('restoreStateBtn');
  const diffButton = document.getElementById('diffStreamBtn');

  // First disable all action buttons (we'll enable them based on status)
  stopButton.disabled = true;
  runAgainBtn.disabled = true;
  packButton.disabled = true;
  cleanButton.disabled = true;
  restoreButton.disabled = true;
  diffButton.disabled = true;

  // Default status is empty - ready for input
  statusIndicator.className = 'status-indicator';
  statusIndicator.dataset.status = 'Ready';

  if (status) {
    // Remove the old status classes
    statusIndicator.classList.remove('running', 'error', 'stopped', 'ready');

    // Configure UI based on status
    switch (status) {
      case STATUS.RUNNING:
        statusIndicator.classList.add('running');
        statusIndicator.dataset.status = 'Running';
        stopButton.disabled = false;
        break;
      case STATUS.ERROR:
        statusIndicator.classList.add('error');
        statusIndicator.dataset.status = 'Error';
        runAgainBtn.disabled = false;
        packButton.disabled = false;
        cleanButton.disabled = false;
        restoreButton.disabled = false;
        diffButton.disabled = false;
        break;
      case STATUS.STOPPED:
        statusIndicator.classList.add('stopped');
        statusIndicator.dataset.status = 'Stopped';
        runAgainBtn.disabled = false;
        packButton.disabled = false;
        cleanButton.disabled = false;
        restoreButton.disabled = false;
        diffButton.disabled = false;
        break;
      case STATUS.READY:
        statusIndicator.classList.add('ready');
        statusIndicator.dataset.status = 'Ready';
        break;
      default:
        statusIndicator.classList.add('stopped');
        statusIndicator.dataset.status = status || 'Ready';
        break;
    }

    // Store status for current stream
    const currentStream = getCurrentStream();
    if (currentStream && status !== STATUS.READY) {
      setStreamStatus(currentStream, status);
    }
  }
}

/**
 * Adds a log group to the DOM
 * @param {Object} group - Group data
 */
export function addLogGroup(group) {
  setLogGroup(group.id, group);
  // Create the header element programmatically instead of using innerHTML
  const headerTemplate = document.createElement('template');
  headerTemplate.innerHTML = createGroupHeader(group);
  const headerElement = headerTemplate.content.firstElementChild;

  // Create a container for the group's messages
  const groupContainer = document.createElement('div');
  groupContainer.className = 'log-group-content';
  groupContainer.id = `group-content-${group.id}`;

  // Check if we have a saved collapsed state for this group
  const isCollapsed = getGroupToggleState(group.id);
  // Collapse if explicitly set to collapsed in the saved state OR if the group status is 'stopped'
  if (isCollapsed === true || group.status === 'stopped') {
    groupContainer.style.display = 'none';
    // Update the toggle icon to reflect collapsed state
    const toggleIcon = headerElement.querySelector('.group-toggle i');
    if (toggleIcon) {
      toggleIcon.className = 'codicon codicon-chevron-right';
    }

    // If it's not already saved as collapsed but status is 'stopped', update the toggle state
    if (isCollapsed !== true && group.status === 'stopped') {
      setGroupToggleState(group.id, true);
    }
  } else {
    groupContainer.style.display = 'block'; // Default to visible if no saved state
  }

  // Determine where to add this group based on parentGroupId
  if (group.parentGroupId) {
    // This is a child group - add it to its parent's content container
    const parentContentElement = document.getElementById(
      `group-content-${group.parentGroupId}`,
    );

    if (parentContentElement) {
      // Find the correct chronological position to insert the group
      const startTime = new Date(group.startTime);
      let insertPosition = null;

      // Get all existing child elements in the parent container
      const childElements = Array.from(parentContentElement.children);

      // Find the right position based on timestamp
      for (let i = 0; i < childElements.length; i++) {
        const child = childElements[i];

        // Check if it's a log message
        if (child.classList.contains('log-line')) {
          // Extract full timestamp from data attribute if available
          const msgFullTimestamp = child.dataset.fullTimestamp;
          let msgTime;

          if (msgFullTimestamp) {
            msgTime = new Date(msgFullTimestamp);
          } else {
            // Fallback to extracting time from content
            const msgTimestamp = getMessageTimestamp(child.outerHTML);
            // Use a dummy date for time-only comparison
            msgTime = msgTimestamp.includes('-')
              ? new Date(msgTimestamp)
              : new Date(`2000-01-01 ${msgTimestamp}`);
          }

          if (startTime < msgTime) {
            insertPosition = child;
            break;
          }
        }
        // Check if it's another group header
        else if (child.classList.contains('log-group-header')) {
          // Get the full timestamp from the group data
          const otherGroupId = child.id.replace('group-header-', '');
          const otherGroup = getLogGroup(otherGroupId);

          if (otherGroup && otherGroup.startTime) {
            const otherTime = new Date(otherGroup.startTime);

            if (startTime < otherTime) {
              insertPosition = child;
              break;
            }
          } else {
            // Fallback to extracting time from the element
            const timeElem = child.querySelector('.group-start-time');
            if (timeElem) {
              const timeText = timeElem.textContent.replace('Started: ', '');
              // Use a dummy date for time-only comparison
              const otherTime = new Date(`2000-01-01 ${timeText}`);

              if (startTime < otherTime) {
                insertPosition = child;
                break;
              }
            }
          }

          // Skip the content container of this group
          if (i + 1 < childElements.length) {
            const nextElem = childElements[i + 1];
            if (nextElem.classList.contains('log-group-content')) {
              i++; // Skip next element
            }
          }
        }
      }

      // Insert at the determined position or append at the end
      if (insertPosition) {
        parentContentElement.insertBefore(headerElement, insertPosition);
        parentContentElement.insertBefore(groupContainer, insertPosition);
      } else {
        // Add to end of parent container
        parentContentElement.appendChild(headerElement);
        parentContentElement.appendChild(groupContainer);
      }
    } else {
      // Fallback if parent not found - add to main container
      const logContent = document.getElementById('logContent');
      logContent.appendChild(headerElement);
      logContent.appendChild(groupContainer);
    }
  } else {
    // This is a top-level group - add to main container
    const logContent = document.getElementById('logContent');
    logContent.appendChild(headerElement);
    logContent.appendChild(groupContainer);
  }

  // Add click handler to the header for toggling - now done directly on the DOM element
  headerElement.addEventListener('click', (event) => {
    // Stop event propagation to prevent parent toggles from also firing
    event.stopPropagation();

    const content = document.getElementById(`group-content-${group.id}`);
    if (!content) return;

    if (content.style.display === 'none') {
      content.style.display = 'block';
      headerElement.querySelector('.group-toggle i').className =
        'codicon codicon-chevron-down';
      setGroupToggleState(group.id, false); // Not collapsed
    } else {
      content.style.display = 'none';
      headerElement.querySelector('.group-toggle i').className =
        'codicon codicon-chevron-right';
      setGroupToggleState(group.id, true); // Collapsed
    }

    // Save the updated state
    saveState();
  });
}

/**
 * Updates the UI of a log group's header
 * @param {string} groupId - ID of the group to update
 * @param {string} status - New status
 * @param {string} endTime - End time (optional)
 */
export function updateLogGroupUI(groupId, status, endTime) {
  const group = getLogGroup(groupId);
  if (!group) return;

  group.status = status;
  if (endTime) {
    group.endTime = endTime;
  }

  // Update the header in the UI if it exists
  const header = document.getElementById(`group-header-${groupId}`);
  if (header) {
    header.className = `log-group-header ${status}`;

    // Update the status icon
    const statusIconElem = header.querySelector('.group-status-icon');
    if (statusIconElem) {
      statusIconElem.innerHTML = getStatusIcon(status);
    }

    // Update or add the duration display when the group finishes
    const timeContainer = header.querySelector('.group-time');

    if (endTime) {
      const endDate = new Date(endTime);
      const startDate = new Date(group.startTime);
      const durationMs = endDate - startDate;

      // Update or create duration element
      const durationElem = header.querySelector('.group-duration');
      if (durationElem) {
        durationElem.textContent = `${formatDuration(durationMs)}`;
        durationElem.style.display = 'inline';
      } else if (timeContainer) {
        const durationSpan = document.createElement('span');
        durationSpan.className = 'group-duration';
        durationSpan.textContent = `${formatDuration(durationMs)}`;
        durationSpan.style.display = 'inline';
        timeContainer.appendChild(durationSpan);
      }
    }

    // Automatically collapse the group if it finished normally (status is "stopped")
    if (status === 'stopped') {
      // Get the content element
      const content = document.getElementById(`group-content-${groupId}`);
      if (content) {
        // Collapse the content
        content.style.display = 'none';

        // Update the toggle icon
        const toggleIcon = header.querySelector('.group-toggle i');
        if (toggleIcon) {
          toggleIcon.className = 'codicon codicon-chevron-right';
        }

        // Update the group toggle state
        setGroupToggleState(groupId, true); // Set to collapsed

        // Save the updated state
        saveState();
      }
    }
  }
}

/**
 * Appends a log message to its group or to the main content
 * @param {Object} logMessage - The log message to append
 * @returns {boolean} Whether the message was appended to a group
 */
export function appendLogToGroup(logMessage) {
  // If the message has a group ID, append it to the right group
  if (logMessage.groupId) {
    const groupContent = document.getElementById(
      `group-content-${logMessage.groupId}`,
    );
    if (groupContent) {
      const messageElement = document.createElement('div');
      messageElement.innerHTML = formatLogEntry(logMessage);
      const logLineElement = messageElement.firstElementChild;

      // Extract timestamp from the message for chronological ordering
      const msgTimestamp = getMessageTimestamp(logMessage.message);
      const msgDate = msgTimestamp.includes('-')
        ? new Date(msgTimestamp)
        : null;

      // Find where to insert this message chronologically
      let insertPosition = null;

      // Get all child elements (both messages and child group containers)
      const childElements = Array.from(groupContent.children);

      // Find the right position based on timestamp
      for (let i = 0; i < childElements.length; i++) {
        const child = childElements[i];

        // If this is a group header, get its start time
        if (child.classList.contains('log-group-header')) {
          const startTimeElem = child.querySelector('.group-start-time');
          if (startTimeElem) {
            // Get full ISO timestamp from the group data
            const groupId = child.id.replace('group-header-', '');
            const group = getLogGroup(groupId);
            if (group && group.startTime) {
              const childDate = new Date(group.startTime);

              // Compare using full date objects if available
              if (msgDate && childDate) {
                if (msgDate < childDate) {
                  insertPosition = child;
                  break;
                }
              } else {
                // Fallback to simple time string comparison
                const timeText = startTimeElem.textContent;
                const childTimestamp = timeText.replace('Started: ', '');
                if (msgTimestamp < childTimestamp) {
                  insertPosition = child;
                  break;
                }
              }
            }
          }
          // Skip the corresponding content container of this child group
          if (
            i + 1 < childElements.length &&
            childElements[i + 1].classList.contains('log-group-content')
          ) {
            i++; // Skip the next element (content container)
          }
        }
        // If this is a log message, extract its timestamp
        else if (child.classList.contains('log-line')) {
          // Try to get the full timestamp from data attribute
          const childFullTimestamp = child.dataset.fullTimestamp;

          if (childFullTimestamp && msgTimestamp) {
            // Compare using full timestamps
            const childDate = new Date(childFullTimestamp);

            if (msgDate && childDate) {
              if (msgDate < childDate) {
                insertPosition = child;
                break;
              }
            } else {
              // Fallback to string comparison
              const childTimestamp = getMessageTimestamp(child.outerHTML);
              if (msgTimestamp < childTimestamp) {
                insertPosition = child;
                break;
              }
            }
          } else {
            // Fallback to original behavior
            const childTimestamp = getMessageTimestamp(child.outerHTML);
            if (msgTimestamp < childTimestamp) {
              insertPosition = child;
              break;
            }
          }
        }
      }

      // Insert the message at the right position or append to the end
      if (insertPosition) {
        groupContent.insertBefore(logLineElement, insertPosition);
      } else {
        groupContent.appendChild(logLineElement);
      }
      return true;
    }
  }

  return false;
}

/**
 * Apply saved toggle states to any groups already in the DOM
 */
export function applyGroupToggleStates() {
  const logGroups = getLogGroups();
  for (const [groupId, _] of logGroups) {
    const isCollapsed = getGroupToggleState(groupId);
    const headerElem = document.getElementById(`group-header-${groupId}`);
    const contentElem = document.getElementById(`group-content-${groupId}`);

    if (headerElem && contentElem && isCollapsed !== undefined) {
      if (isCollapsed) {
        contentElem.style.display = 'none';
        const toggleIcon = headerElem.querySelector('.group-toggle i');
        if (toggleIcon) {
          toggleIcon.className = 'codicon codicon-chevron-right';
        }
      } else {
        contentElem.style.display = 'block';
        const toggleIcon = headerElem.querySelector('.group-toggle i');
        if (toggleIcon) {
          toggleIcon.className = 'codicon codicon-chevron-down';
        }
      }
    }
  }
}

/**
 * Sets up all event listeners for the UI
 */
export function setupEventListeners() {
  // Stream tab click handler
  document.getElementById('streamTabs').addEventListener('click', (e) => {
    const tabButton = e.target.closest('.tab');
    const deleteButton = e.target.closest('.tab-delete');
    if (tabButton) {
      const stream = tabButton.dataset.stream;
      vscode.postMessage({ command: COMMANDS.SWITCH_STREAM, stream });
    } else if (deleteButton) {
      const stream = deleteButton.dataset.stream;
      vscode.postMessage({ command: COMMANDS.DELETE_STREAM, stream });
    }
  });

  // Stop button click handler
  document.getElementById('stopStreamBtn').addEventListener('click', () => {
    const currentStream = getCurrentStream();
    if (currentStream) {
      vscode.postMessage({
        command: COMMANDS.STOP_STREAM,
        stream: currentStream,
      });
    }
  });

  // Run again button click handler
  document.getElementById('runAgainBtn').addEventListener('click', () => {
    const currentStream = getCurrentStream();
    if (currentStream) {
      vscode.postMessage({
        command: COMMANDS.RUN_AGAIN,
        stream: currentStream,
      });
    }
  });

  // Restore state button click handler
  document.getElementById('restoreStateBtn').addEventListener('click', () => {
    const currentStream = getCurrentStream();
    if (currentStream) {
      vscode.postMessage({
        command: COMMANDS.RESTORE_STATE,
        stream: currentStream,
      });
    }
  });

  // Diff button click handler
  document.getElementById('diffStreamBtn').addEventListener('click', () => {
    const currentStream = getCurrentStream();
    if (currentStream) {
      vscode.postMessage({
        command: COMMANDS.DIFF_STREAM,
        stream: currentStream,
      });
    }
  });

  // Pack button click handler
  document.getElementById('packStreamBtn').addEventListener('click', () => {
    const currentStream = getCurrentStream();
    if (currentStream) {
      vscode.postMessage({
        command: COMMANDS.PACK_STREAM,
        stream: currentStream,
      });
    }
  });

  // Clean button click handler
  document.getElementById('cleanStreamBtn').addEventListener('click', () => {
    const currentStream = getCurrentStream();
    if (currentStream) {
      vscode.postMessage({
        command: COMMANDS.CLEAN_STREAM,
        stream: currentStream,
      });
    }
  });

  // Erase button click handler
  document.getElementById('eraseStreamBtn').addEventListener('click', () => {
    const currentStream = getCurrentStream();
    if (currentStream) {
      vscode.postMessage({
        command: COMMANDS.ERASE_STREAM,
        stream: currentStream,
      });
    }
  });

  // Delete all button click handler
  document.getElementById('deleteAllBtn').addEventListener('click', () => {
    clearAllGroupToggleStates();
    vscode.postMessage({ command: COMMANDS.DELETE_ALL });
  });

  // Initialize split view
  Split(['.content-area', '.tabs'], {
    sizes: [SPLIT_SIZES.CONTENT, SPLIT_SIZES.TABS],
    minSize: [200, 100],
    gutterSize: 5,
    cursor: 'col-resize',
  });
}
