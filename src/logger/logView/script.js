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

  // If this is a new group being added to the active view, we need to update the UI
  const logContent = document.getElementById('logContent');

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

  // Add to DOM
  logContent.appendChild(headerElement);
  logContent.appendChild(groupContainer);

  // Add click handler to the header for toggling - now done directly on the DOM element
  headerElement.addEventListener('click', () => {
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
      groupContent.appendChild(messageElement.firstElementChild);
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

        // First create all the groups
        if (message.groups && message.groups.length > 0) {
          message.groups.forEach((group) => {
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
            headerElement.addEventListener('click', () => {
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
        }

        // Now add messages to their groups
        message.messages.forEach((msg) => {
          if (msg.groupId) {
            // Append to group if it exists
            const groupContent = document.getElementById(
              `group-content-${msg.groupId}`,
            );
            if (groupContent) {
              const messageElement = document.createElement('div');
              messageElement.innerHTML = formatLogEntry(msg);
              groupContent.appendChild(messageElement.firstElementChild);
            } else {
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
