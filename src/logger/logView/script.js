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
