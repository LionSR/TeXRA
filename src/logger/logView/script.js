const vscode = acquireVsCodeApi();
let currentStream = '';
let streamStatuses = new Map();
let logGroups = new Map(); // groupId -> group details
let groupToggleStates = new Map(); // groupId -> collapsed state

// Restore state if available
const previousState = vscode.getState() || {};
if (previousState.groupToggleStates) {
  try {
    groupToggleStates = new Map(JSON.parse(previousState.groupToggleStates));
  } catch (e) {
    console.error('Failed to restore group toggle states:', e);
  }
}

import Split from 'split.js';

// Helper function to extract timestamp from HTML message
function getMessageTimestamp(message) {
  // First try to extract the full timestamp from data-full-timestamp attribute
  const div = document.createElement('div');
  div.innerHTML = message;
  const logLine = div.querySelector('.log-line');
  if (logLine && logLine.dataset.fullTimestamp) {
    return logLine.dataset.fullTimestamp; // Return the full precise timestamp
  }

  // Fallback: extract from the message content using regex
  const match = message.match(/\[(.*?)\]/);
  return match ? match[1] : ''; // Extract timestamp or empty string
}

function formatLogEntry(logMessage) {
  // The message is already formatted HTML from the server
  return logMessage.message;
}

function updateStreamTabs(streams, activeStream) {
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
    updateStatus('ready');
  } else {
    updateStatus(streamStatuses.get(activeStream) || 'stopped');
  }
}

function updateStatus(status) {
  const statusIndicator = document.getElementById('statusIndicator');
  const stopButton = document.getElementById('stopStreamBtn');
  const runAgainBtn = document.getElementById('runAgainBtn');
  const packButton = document.getElementById('packStreamBtn');
  const cleanButton = document.getElementById('cleanStreamBtn');
  const eraseButton = document.getElementById('eraseStreamBtn');
  const restoreButton = document.getElementById('restoreStateBtn');

  // First disable all action buttons (we'll enable them based on status)
  stopButton.disabled = true;
  runAgainBtn.disabled = true;
  packButton.disabled = true;
  cleanButton.disabled = true;
  restoreButton.disabled = true;

  // Default status is empty - ready for input
  statusIndicator.className = 'status-indicator';
  statusIndicator.dataset.status = 'Ready';

  if (status) {
    // Remove the old status classes
    statusIndicator.classList.remove('running', 'error', 'stopped', 'ready');

    // Configure UI based on status
    switch (status) {
      case 'running':
        statusIndicator.classList.add('running');
        statusIndicator.dataset.status = 'Running';
        stopButton.disabled = false;
        break;
      case 'error':
        statusIndicator.classList.add('error');
        statusIndicator.dataset.status = 'Error';
        runAgainBtn.disabled = false;
        packButton.disabled = false;
        cleanButton.disabled = false;
        restoreButton.disabled = false;
        break;
      case 'stopped':
        statusIndicator.classList.add('stopped');
        statusIndicator.dataset.status = 'Stopped';
        runAgainBtn.disabled = false;
        packButton.disabled = false;
        cleanButton.disabled = false;
        restoreButton.disabled = false;
        break;
      case 'ready':
        statusIndicator.classList.add('ready');
        statusIndicator.dataset.status = 'Ready';
        break;
      default:
        statusIndicator.classList.add('stopped');
        statusIndicator.dataset.status = status || 'Ready';
        break;
    }

    // Store status for current stream
    if (currentStream && status !== 'ready') {
      streamStatuses.set(currentStream, status);
    }
  }
}

function addLogGroup(group) {
  logGroups.set(group.id, group);

  // Create the header element programmatically instead of using innerHTML
  const headerTemplate = document.createElement('template');
  headerTemplate.innerHTML = createGroupHeader(group);
  const headerElement = headerTemplate.content.firstElementChild;

  // Create a container for the group's messages
  const groupContainer = document.createElement('div');
  groupContainer.className = 'log-group-content';
  groupContainer.id = `group-content-${group.id}`;

  // Check if we have a saved collapsed state for this group
  const isCollapsed = groupToggleStates.get(group.id);
  if (isCollapsed === true) {
    groupContainer.style.display = 'none';
    // Update the toggle icon to reflect collapsed state
    const toggleIcon = headerElement.querySelector('.group-toggle i');
    if (toggleIcon) {
      toggleIcon.className = 'codicon codicon-chevron-right';
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
          const otherGroup = logGroups.get(otherGroupId);

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
      groupToggleStates.set(group.id, false); // Not collapsed
    } else {
      content.style.display = 'none';
      headerElement.querySelector('.group-toggle i').className =
        'codicon codicon-chevron-right';
      groupToggleStates.set(group.id, true); // Collapsed
    }

    // Save the updated state
    saveState();
  });
}

function updateLogGroup(groupId, status, endTime) {
  const group = logGroups.get(groupId);
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

    // Update the timestamp display
    const endTimeElem = header.querySelector('.group-end-time');
    if (endTime) {
      if (endTimeElem) {
        const date = new Date(endTime);
        endTimeElem.textContent = `Ended: ${formatTime(date)}`;
        endTimeElem.style.display = 'inline';
      } else {
        // If endTimeElem doesn't exist, create it
        const timeContainer = header.querySelector('.group-time');
        if (timeContainer) {
          const date = new Date(endTime);
          const endTimeSpan = document.createElement('span');
          endTimeSpan.className = 'group-end-time';
          endTimeSpan.textContent = `Ended: ${formatTime(date)}`;
          endTimeSpan.style.display = 'inline';
          timeContainer.appendChild(endTimeSpan);
        }
      }
    }
  }
}

function createGroupHeader(group) {
  const startDate = new Date(group.startTime);
  const formattedStartTime = formatTime(startDate);

  let endTimeDisplay = '';
  if (group.endTime) {
    const endDate = new Date(group.endTime);
    endTimeDisplay = `<span class="group-end-time">Ended: ${formatTime(endDate)}</span>`;
  }

  // Add indicator based on status
  const statusIcon = getStatusIcon(group.status);

  return `
    <div id="group-header-${group.id}" class="log-group-header ${group.status}">
      <span class="group-toggle"><i class="codicon codicon-chevron-down"></i></span>
      <span class="group-status-icon">${statusIcon}</span>
      <span class="group-title">${group.name}</span>
      <span class="group-time">
        <span class="group-start-time">Started: ${formattedStartTime}</span>
        ${endTimeDisplay}
      </span>
    </div>
  `;
}

function getStatusIcon(status) {
  switch (status) {
    case 'running':
      return '<i class="codicon codicon-sync spin"></i>';
    case 'error':
      return '<i class="codicon codicon-error"></i>';
    case 'stopped':
      return '<i class="codicon codicon-check"></i>';
    default:
      return '<i class="codicon codicon-circle-outline"></i>';
  }
}

function formatTime(date) {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function appendLogToGroup(logMessage) {
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
            const group = logGroups.get(groupId);
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

function setupEventListeners() {
  // Stream tab click handler
  document.getElementById('streamTabs').addEventListener('click', (e) => {
    const tabButton = e.target.closest('.tab');
    const deleteButton = e.target.closest('.tab-delete');
    if (tabButton) {
      const stream = tabButton.dataset.stream;
      vscode.postMessage({ command: 'switchStream', stream });
    } else if (deleteButton) {
      const stream = deleteButton.dataset.stream;
      vscode.postMessage({ command: 'deleteStream', stream });
    }
  });

  // Stop button click handler
  document.getElementById('stopStreamBtn').addEventListener('click', () => {
    if (currentStream) {
      vscode.postMessage({ command: 'stopStream', stream: currentStream });
    }
  });

  // Run again button click handler
  document.getElementById('runAgainBtn').addEventListener('click', () => {
    if (currentStream) {
      vscode.postMessage({ command: 'runAgain', stream: currentStream });
    }
  });

  // Restore state button click handler
  document.getElementById('restoreStateBtn').addEventListener('click', () => {
    if (currentStream) {
      vscode.postMessage({ command: 'restoreState', stream: currentStream });
    }
  });

  // Pack button click handler
  document.getElementById('packStreamBtn').addEventListener('click', () => {
    if (currentStream) {
      vscode.postMessage({ command: 'packStream', stream: currentStream });
    }
  });

  // Clean button click handler
  document.getElementById('cleanStreamBtn').addEventListener('click', () => {
    if (currentStream) {
      vscode.postMessage({ command: 'cleanStream', stream: currentStream });
    }
  });

  // Erase button click handler
  document.getElementById('eraseStreamBtn').addEventListener('click', () => {
    if (currentStream) {
      vscode.postMessage({ command: 'eraseStream', stream: currentStream });
    }
  });

  // Delete all button click handler
  document.getElementById('deleteAllBtn').addEventListener('click', () => {
    // When deleting all streams, clear all toggle states as well
    groupToggleStates.clear();
    saveState();
    vscode.postMessage({ command: 'deleteAll' });
  });

  // Initialize split view
  Split(['.content-area', '.tabs'], {
    sizes: [80, 20],
    minSize: [200, 100],
    gutterSize: 5,
    cursor: 'col-resize',
  });
}

window.addEventListener('message', (event) => {
  const message = event.data;
  const logContent = document.getElementById('logContent');

  switch (message.command) {
    case 'updateStreams':
      currentStream = message.currentStream;
      updateStreamTabs(message.streams, currentStream);
      break;
    case 'updateLogs':
      if (message.stream === currentStream) {
        // Reset log content and log groups
        logContent.innerHTML = '';
        logGroups.clear();
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
            // Store group data
            logGroups.set(group.id, group);

            // Create and append header element
            const headerTemplate = document.createElement('template');
            headerTemplate.innerHTML = createGroupHeader(group);
            const headerElement = headerTemplate.content.firstElementChild;

            // Create content container
            const groupContainer = document.createElement('div');
            groupContainer.className = 'log-group-content';
            groupContainer.id = `group-content-${group.id}`;

            // Check if we have a saved collapsed state for this group
            const isCollapsed = groupToggleStates.get(group.id);
            if (isCollapsed === true) {
              groupContainer.style.display = 'none';
              // Update the toggle icon to reflect collapsed state
              const toggleIcon = headerElement.querySelector('.group-toggle i');
              if (toggleIcon) {
                toggleIcon.className = 'codicon codicon-chevron-right';
              }
            } else {
              groupContainer.style.display = 'block'; // Default to visible if no saved state
            }

            // Add to DOM
            logContent.appendChild(headerElement);
            logContent.appendChild(groupContainer);

            // Add click handler for toggling
            headerElement.addEventListener('click', (event) => {
              // Stop event propagation to prevent parent toggles from also firing
              event.stopPropagation();

              if (groupContainer.style.display === 'none') {
                groupContainer.style.display = 'block';
                headerElement.querySelector('.group-toggle i').className =
                  'codicon codicon-chevron-down';
                groupToggleStates.set(group.id, false); // Not collapsed
              } else {
                groupContainer.style.display = 'none';
                headerElement.querySelector('.group-toggle i').className =
                  'codicon codicon-chevron-right';
                groupToggleStates.set(group.id, true); // Collapsed
              }

              // Save the updated state
              saveState();
            });
          });

          // Sort child groups by timestamp
          childGroups.sort((a, b) => {
            const timeA = new Date(a.startTime);
            const timeB = new Date(b.startTime);
            return timeA - timeB;
          });

          // Then add child groups (after parents are in place)
          childGroups.forEach((group) => {
            addLogGroup(group); // Reuse the addLogGroup function which now handles parent-child relationships
          });
        }

        // Now add messages to their groups - sort them by timestamp first
        // This ensures we process messages in chronological order
        const sortedMessages = [...message.messages].sort((a, b) => {
          const timestampA = getMessageTimestamp(a.message);
          const timestampB = getMessageTimestamp(b.message);

          // Try to use Date objects for more accurate comparison
          const dateA = timestampA.includes('-') ? new Date(timestampA) : null;
          const dateB = timestampB.includes('-') ? new Date(timestampB) : null;

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
    case 'clearLogs':
      logContent.innerHTML = '';

      // Keep track of the groups that were in this stream
      const groupsToRemove = [];
      for (const [groupId, group] of logGroups.entries()) {
        groupsToRemove.push(groupId);
      }

      // Clear the log groups for this stream
      logGroups.clear();

      // Clear toggle states for these groups
      for (const groupId of groupsToRemove) {
        groupToggleStates.delete(groupId);
      }

      // Save the updated state
      saveState();
      break;
    case 'appendLog':
      if (message.stream === currentStream) {
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
    case 'addLogGroup':
      if (message.stream === currentStream) {
        addLogGroup(message.group);
        logContent.scrollTop = logContent.scrollHeight;
      }
      break;
    case 'updateLogGroup':
      if (message.stream === currentStream) {
        updateLogGroup(message.groupId, message.status, message.endTime);
      }
      break;
    case 'updateStatus':
      updateStatus(message.status);
      break;
    case 'deleteStream':
      if (message.command === 'deleteStream' && message.stream) {
        // Handle deleting a stream
        streamStatuses.delete(message.stream);

        // If active stream was deleted, we should clear the toggle states
        // for any groups that were in that stream
        if (message.stream === currentStream) {
          const groupsToRemove = [];
          for (const [groupId, group] of logGroups.entries()) {
            groupsToRemove.push(groupId);
          }

          // Clear toggle states for these groups
          for (const groupId of groupsToRemove) {
            groupToggleStates.delete(groupId);
          }

          // Save the updated state
          saveState();
        }
      }
      break;
  }
});

// Initialize event listeners and state when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();

  // Apply saved toggle states to any groups already in the DOM
  // (in case the page was refreshed and groups were already rendered by the server)
  if (groupToggleStates.size > 0) {
    for (const [groupId, isCollapsed] of groupToggleStates.entries()) {
      const headerElem = document.getElementById(`group-header-${groupId}`);
      const contentElem = document.getElementById(`group-content-${groupId}`);

      if (headerElem && contentElem) {
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
});

// Save state helper function
function saveState() {
  try {
    // Convert the groupToggleStates Map to an array for JSON serialization
    const serializedGroupStates = JSON.stringify([
      ...groupToggleStates.entries(),
    ]);
    vscode.setState({
      ...vscode.getState(),
      groupToggleStates: serializedGroupStates,
    });
  } catch (e) {
    console.error('Failed to save state:', e);
  }
}
