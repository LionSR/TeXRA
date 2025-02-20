const vscode = acquireVsCodeApi();
let currentStream = '';
let streamStatuses = new Map();

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
  const packButton = document.getElementById('packStreamBtn');
  const cleanButton = document.getElementById('cleanStreamBtn');
  const runAgainButton = document.getElementById('runAgainBtn');
  if (
    !statusIndicator ||
    !stopButton ||
    !packButton ||
    !cleanButton ||
    !runAgainButton
  )
    return;

  // Remove all existing status classes
  statusIndicator.classList.remove('running', 'error', 'stopped', 'ready');

  // Add the new status class
  if (status) {
    statusIndicator.classList.add(status);
    // Set tooltip text
    const tooltipText =
      {
        running: 'Task is running',
        error: 'Task failed with error',
        stopped: 'Task completed or interrupted',
        ready: 'Ready',
      }[status] || 'Ready';
    statusIndicator.setAttribute('data-status', tooltipText);

    // Update button states and tooltips
    const isRunning = status === 'running';
    const isReady = status === 'ready';
    const isTaskActive = isRunning || isReady;

    // Stop button
    stopButton.disabled = !isRunning;
    stopButton.title = isRunning
      ? 'Request task interruption (note: current API call will complete)'
      : 'No running task to stop';

    // Run Again button
    runAgainButton.disabled = isTaskActive;
    runAgainButton.title = isTaskActive
      ? 'Cannot run task while another task is active'
      : 'Run this task again';

    // Pack button
    packButton.disabled = isTaskActive;
    packButton.title = isTaskActive
      ? 'Cannot pack while task is active'
      : 'Pack the output for this agent';

    // Clean button
    cleanButton.disabled = isTaskActive;
    cleanButton.title = isTaskActive
      ? 'Cannot clean while task is active'
      : 'Clean the output for this agent';

    // Store status for current stream
    if (currentStream && status !== 'ready') {
      streamStatuses.set(currentStream, status);
    }
  }
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
    vscode.postMessage({ command: 'deleteAll' });
  });

  // Run Again button
  const runAgainBtn = document.getElementById('runAgainBtn');
  runAgainBtn.addEventListener('click', () => {
    if (currentStream) {
      vscode.postMessage({
        command: 'runAgain',
        stream: currentStream,
      });
    }
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
        logContent.innerHTML = message.messages.map(formatLogEntry).join('');
        logContent.scrollTop = logContent.scrollHeight;
      }
      break;
    case 'clearLogs':
      logContent.innerHTML = '';
      break;
    case 'appendLog':
      if (message.stream === currentStream) {
        const formattedLog = formatLogEntry(message.logMessage);
        if (logContent.innerHTML) {
          logContent.innerHTML += formattedLog;
        } else {
          logContent.innerHTML = formattedLog;
        }
        logContent.scrollTop = logContent.scrollHeight;
      }
      break;
    case 'updateStatus':
      updateStatus(message.status);
      break;
  }
});

// Initialize event listeners when DOM is loaded
document.addEventListener('DOMContentLoaded', setupEventListeners);
