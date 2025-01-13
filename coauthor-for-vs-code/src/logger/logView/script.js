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
            <i class="fas fa-trash-alt"></i>
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
  if (!statusIndicator) return;

  // Remove all existing status classes
  statusIndicator.classList.remove('running', 'error', 'stopped', 'ready');

  // Add the new status class
  if (status) {
    statusIndicator.classList.add(status);
    // Set tooltip text
    const tooltipText = {
      running: 'Task is running',
      error: 'Task failed with error',
      stopped: 'Task completed',
      ready: 'Ready'
    }[status] || 'Ready';
    statusIndicator.setAttribute('data-status', tooltipText);

    // Store status for current stream
    if (currentStream && status !== 'ready') {
      streamStatuses.set(currentStream, status);
    }
  }
}

function setupEventListeners() {
  // Initialize Split.js
  const split = Split(['.content-area', '.tabs'], {
    sizes: [80, 20],
    minSize: [400, 80],
    gutterSize: 1,
    snapOffset: 0,
    dragInterval: 1,
    direction: 'horizontal',
  });

  // Stream switching and deletion
  document.getElementById('streamTabs').addEventListener('click', (event) => {
    const tabElement = event.target.closest('.tab');
    const deleteButton = event.target.closest('.tab-delete');
    
    if (tabElement) {
      const stream = tabElement.dataset.stream;
      currentStream = stream;
      document.querySelectorAll('.tab-container').forEach((t) => {
        t.classList.toggle('active', t.querySelector('.tab').dataset.stream === stream);
      });
      document.getElementById('currentStreamName').textContent = stream;
      vscode.postMessage({ command: 'switchStream', stream });
    } else if (deleteButton) {
      const stream = deleteButton.dataset.stream;
      vscode.postMessage({ command: 'deleteStream', stream });
    }
  });

  // Clear current stream
  document.getElementById('clearStreamBtn').addEventListener('click', () => {
    vscode.postMessage({ command: 'clearStream', stream: currentStream });
  });

  // Clear all streams
  document.getElementById('deleteAllBtn').addEventListener('click', () => {
    vscode.postMessage({ command: 'deleteAll' });
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
