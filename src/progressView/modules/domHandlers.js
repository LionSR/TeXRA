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
import { STATUS, COMMANDS, SPLIT_SIZES, TOOLBAR_BUTTONS } from './constants.js';
import { createIconButton } from '../../webview/modules/utils.js';

const STATUS_MAP = {
  [STATUS.RUNNING]: {
    className: 'running',
    label: 'Running',
    enable: ['stopStreamBtn'],
  },
  [STATUS.ERROR]: {
    className: 'error',
    label: 'Error',
    enable: [
      'runAgainBtn',
      'packStreamBtn',
      'cleanStreamBtn',
      'restoreStateBtn',
      'diffStreamBtn',
    ],
  },
  [STATUS.STOPPED]: {
    className: 'stopped',
    label: 'Stopped',
    enable: [
      'runAgainBtn',
      'packStreamBtn',
      'cleanStreamBtn',
      'restoreStateBtn',
      'diffStreamBtn',
    ],
  },
  [STATUS.READY]: {
    className: 'ready',
    label: 'Ready',
    enable: [],
  },
};

const BUTTON_IDS = TOOLBAR_BUTTONS.map((b) => b.id);

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
            <i class="codicon codicon-close"></i>
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

export function renderToolbar() {
  const container = document.getElementById('toolbarContainer');
  if (!container) return;
  container.innerHTML = '';
  TOOLBAR_BUTTONS.forEach((def) => {
    const btn = createIconButton({
      id: def.id,
      icon: def.icon,
      title: def.title,
      className: def.className,
      disabled: def.disabled,
      dataset: { command: def.command },
    });
    container.appendChild(btn);
  });
}

/**
 * Updates the stream status indicator and enables/disables buttons accordingly
 * @param {string} status - The status to set
 */
export function updateStatus(status) {
  const statusIndicator = document.getElementById('statusIndicator');
  const buttons = BUTTON_IDS.map((id) => document.getElementById(id));

  buttons.forEach((b) => {
    if (b) b.disabled = true;
  });

  statusIndicator.className = 'status-indicator';
  statusIndicator.dataset.status = 'Ready';

  if (status) {
    statusIndicator.classList.remove('running', 'error', 'stopped', 'ready');

    const cfg = STATUS_MAP[status] || {
      className: 'stopped',
      label: status || 'Ready',
      enable: [],
    };

    statusIndicator.classList.add(cfg.className);
    statusIndicator.dataset.status = cfg.label;

    cfg.enable.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = false;
    });

    const currentStream = getCurrentStream();
    if (currentStream && status !== STATUS.READY) {
      setStreamStatus(currentStream, status);
    }
  }
}

/**
 * Update token and cost summary in the header (now cleared since we show per-group)
 * @param {Object} usage - Usage data with inputTokens, outputTokens, cost
 */
export function updateUsageSummary(usage) {
  const summaryElem = document.getElementById('runSummary');
  if (!summaryElem) return;

  // Clear global usage display since we now show usage per-group
  summaryElem.textContent = '';
}

/**
 * Update token and cost usage for a specific group
 * @param {string} groupId - ID of the group to update
 * @param {Object} usage - Usage data with inputTokens, outputTokens, cost
 */
export function updateGroupUsage(groupId, usage) {
  const groupHeader = document.getElementById(`group-header-${groupId}`);
  if (!groupHeader) return;

  // Find or create usage display element in the group header
  let usageElem = groupHeader.querySelector('.group-usage');
  if (!usageElem) {
    usageElem = document.createElement('span');
    usageElem.className = 'group-usage';

    // Insert usage display after the group time element
    const timeContainer = groupHeader.querySelector('.group-time');
    if (timeContainer) {
      timeContainer.appendChild(usageElem);
    } else {
      // Fallback: append to the header
      groupHeader.appendChild(usageElem);
    }
  }

  if (!usage) {
    usageElem.textContent = '';
    return;
  }

  const { inputTokens = 0, outputTokens = 0, cost = 0 } = usage;
  usageElem.textContent = ` • in: ${inputTokens}, out: ${outputTokens}, $${cost.toFixed(3)}`;
}

/**
 * Update the generated files list
 * @param {Array<string>} files - Array of file paths
 */
export function updateFileList(filesByRound) {
  const container = document.getElementById('generatedFiles');
  if (!container) return;

  container.innerHTML = '';

  if (!filesByRound || Object.keys(filesByRound).length === 0) {
    container.textContent = 'No generated files';
    return;
  }

  const rounds = Object.keys(filesByRound)
    .map((r) => parseInt(r, 10))
    .sort((a, b) => a - b);

  rounds.forEach((round) => {
    const group = document.createElement('div');
    group.className = 'round-group';

    const header = document.createElement('div');
    header.className = 'round-header';
    header.textContent = `Round ${round}`;
    group.appendChild(header);

    const files = filesByRound[round] || [];
    files.forEach((info) => {
      const item = document.createElement('div');
      item.className = 'file-item';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'file-name';

      // Get basename of the file for cleaner display
      const basename = info.path.split('/').pop();
      const dirPath = info.path.substring(
        0,
        info.path.length - basename.length,
      );

      // Create a clickable container for the directory and filename
      const pathSpan = document.createElement('span');
      pathSpan.className = 'file-path clickable';

      const dirSpan = document.createElement('span');
      dirSpan.className = 'file-dir';
      dirSpan.style.opacity = '0.7';
      dirSpan.textContent = dirPath;

      const fileSpan = document.createElement('span');
      fileSpan.className = 'file-basename';
      fileSpan.textContent = basename;

      pathSpan.appendChild(dirSpan);
      pathSpan.appendChild(fileSpan);
      nameSpan.appendChild(pathSpan);

      // Create diff stats outside the file-name container so they're always visible
      let statsSpan = null;
      if (info.added !== undefined && info.removed !== undefined) {
        statsSpan = document.createElement('span');
        statsSpan.className = 'file-stats';
        statsSpan.innerHTML = `<span class="added">+${info.added}</span><span class="removed">-${info.removed}</span>`;
      }

      const actions = document.createElement('span');
      actions.className = 'file-actions button-group';

      // Create all buttons

      // Only create the previous round comparison button if there's a previous file
      // Put this first since this is right aligned to be more symmetric
      const prevBtn = info.prev ? document.createElement('button') : null;
      if (prevBtn) {
        prevBtn.className = 'vscode-button tiny';
        prevBtn.title = 'Compare with previous round';
        prevBtn.innerHTML = '<i class="codicon codicon-diff-added"></i>';
        prevBtn.addEventListener('click', () => {
          vscode.postMessage({
            command: COMMANDS.COMPARE_PREVIOUS,
            file: info.path,
            prev: info.prev,
          });
        });
      }

      // Make the file path clickable to open the file directly
      pathSpan.addEventListener('click', () => {
        vscode.postMessage({ command: COMMANDS.OPEN_FILE, file: info.path });
      });

      const compareBtn = document.createElement('button');
      compareBtn.className = 'vscode-button tiny';
      compareBtn.title = 'Compare with base';
      compareBtn.innerHTML = '<i class="codicon codicon-diff"></i>';
      compareBtn.addEventListener('click', () => {
        vscode.postMessage({
          command: COMMANDS.COMPARE_ORIGINAL,
          file: info.path,
          base: info.base,
        });
      });

      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'vscode-button tiny';
      acceptBtn.title = 'Accept edits';
      acceptBtn.innerHTML = '<i class="codicon codicon-check"></i>';
      acceptBtn.addEventListener('click', () => {
        vscode.postMessage({
          command: COMMANDS.ACCEPT_FILE,
          file: info.path,
          base: info.base,
        });
      });

      const mergeBtn = document.createElement('button');
      mergeBtn.className = 'vscode-button tiny';
      mergeBtn.title = 'Merge edits';
      mergeBtn.innerHTML = '<i class="codicon codicon-git-merge"></i>';
      mergeBtn.addEventListener('click', () => {
        vscode.postMessage({
          command: COMMANDS.MERGE_FILE,
          file: info.path,
          base: info.base,
        });
      });

      const diffBtn = document.createElement('button');
      diffBtn.className = 'vscode-button tiny';
      diffBtn.title = 'LaTeXdiff';
      diffBtn.innerHTML = '<i class="codicon codicon-git-compare"></i>';
      diffBtn.addEventListener('click', () => {
        vscode.postMessage({
          command: COMMANDS.LATEXDIFF_FILE,
          file: info.path,
          base: info.base,
          prev: info.prev,
        });
      });

      // Add all buttons to the actions container
      actions.appendChild(compareBtn);
      actions.appendChild(acceptBtn);
      actions.appendChild(mergeBtn);
      actions.appendChild(diffBtn);
      if (prevBtn) {
        actions.appendChild(prevBtn);
      }

      item.appendChild(nameSpan);
      if (statsSpan) {
        item.appendChild(statsSpan);
      }
      item.appendChild(actions);
      group.appendChild(item);
    });

    container.appendChild(group);
  });
}

/**
 * Adds a log group to the DOM
 * @param {Object} group - Group data
 */
export function addLogGroup(group) {
  setLogGroup(group.id, group);
  // Create the details container that will manage toggle state
  const detailsElem = document.createElement('details');
  detailsElem.className = 'log-group';
  detailsElem.id = `group-${group.id}`;

  // Create the header element as a <summary>
  const headerTemplate = document.createElement('template');
  headerTemplate.innerHTML = createGroupHeader(group);
  const headerElement = headerTemplate.content.firstElementChild;

  // Create a container for the group's messages
  const groupContainer = document.createElement('div');
  groupContainer.className = 'log-group-content';
  groupContainer.id = `group-content-${group.id}`;

  // Check if we have a saved collapsed state for this group
  const isCollapsed = getGroupToggleState(group.id);
  const shouldCollapse = isCollapsed === true || group.status === 'stopped';
  detailsElem.open = !shouldCollapse;

  if (shouldCollapse && isCollapsed !== true && group.status === 'stopped') {
    setGroupToggleState(group.id, true);
  }

  detailsElem.appendChild(headerElement);
  detailsElem.appendChild(groupContainer);

  // Update toggle state when the user expands/collapses the details element
  detailsElem.addEventListener('toggle', () => {
    setGroupToggleState(group.id, !detailsElem.open);
  });

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
        else if (child.tagName === 'DETAILS') {
          const headerEl = child.querySelector('.log-group-header');
          const timeElem = headerEl?.querySelector('.group-start-time');

          if (timeElem) {
            const otherGroupId = headerEl.id.replace('group-header-', '');
            const otherGroup = getLogGroup(otherGroupId);

            if (otherGroup && otherGroup.startTime) {
              const otherTime = new Date(otherGroup.startTime);

              if (startTime < otherTime) {
                insertPosition = child;
                break;
              }
            } else {
              const timeText = timeElem.textContent.replace('Started: ', '');
              const otherTime = new Date(`2000-01-01 ${timeText}`);

              if (startTime < otherTime) {
                insertPosition = child;
                break;
              }
            }
          }
        }
      }

      // Insert at the determined position or append at the end
      if (insertPosition) {
        parentContentElement.insertBefore(detailsElem, insertPosition);
      } else {
        // Add to end of parent container
        parentContentElement.appendChild(detailsElem);
      }
    } else {
      // Fallback if parent not found - add to main container
      const logContent = document.getElementById('logContent');
      logContent.appendChild(detailsElem);
    }
  } else {
    // This is a top-level group - add to main container
    const logContent = document.getElementById('logContent');
    logContent.appendChild(detailsElem);
  }
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
      const details = document.getElementById(`group-${groupId}`);
      if (details) {
        details.open = false;
        setGroupToggleState(groupId, true);
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
      const msgDate = logMessage.timestamp
        ? new Date(logMessage.timestamp)
        : null;
      const msgTimestamp =
        msgDate?.toISOString() || getMessageTimestamp(logMessage.message);

      // Find where to insert this message chronologically
      let insertPosition = null;

      // Get all child elements (both messages and child group containers)
      const childElements = Array.from(groupContent.children);

      // Find the right position based on timestamp
      for (let i = 0; i < childElements.length; i++) {
        const child = childElements[i];

        // If this is a nested group, get its start time
        if (child.tagName === 'DETAILS') {
          const headerEl = child.querySelector('.log-group-header');
          const startTimeElem = headerEl?.querySelector('.group-start-time');
          if (startTimeElem) {
            const groupId = headerEl.id.replace('group-header-', '');
            const group = getLogGroup(groupId);
            if (group && group.startTime) {
              const childDate = new Date(group.startTime);

              if (msgDate && childDate) {
                if (msgDate < childDate) {
                  insertPosition = child;
                  break;
                }
              } else {
                const timeText = startTimeElem.textContent;
                const childTimestamp = timeText.replace('Started: ', '');
                if (msgTimestamp < childTimestamp) {
                  insertPosition = child;
                  break;
                }
              }
            }
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
    const detailsElem = document.getElementById(`group-${groupId}`);

    if (detailsElem && isCollapsed !== undefined) {
      detailsElem.open = !isCollapsed;
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

  document.getElementById('toolbarContainer').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-command]');
    if (!btn) return;
    const command = btn.dataset.command;
    const currentStream = getCurrentStream();
    if (currentStream) {
      vscode.postMessage({ command, stream: currentStream });
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
