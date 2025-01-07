const vscode = acquireVsCodeApi();
let currentStream = '';

function formatLogEntry(logMessage) {
  // The message is already formatted HTML from the server
  return logMessage.message;
}

function updateStreamTabs(streams, activeStream) {
  const tabsContainer = document.getElementById('streamTabs');
  tabsContainer.innerHTML = streams
    .map(
      (stream) =>
        `<button class="tab ${
          stream === activeStream ? 'active' : ''
        }" data-stream="${stream}">${stream}</button>`,
    )
    .join('');

  // Update current stream name
  document.getElementById('currentStreamName').textContent = activeStream;
}

function setupEventListeners() {
  // Stream switching
  document.getElementById('streamTabs').addEventListener('click', (event) => {
    if (event.target.classList.contains('tab')) {
      const stream = event.target.dataset.stream;
      currentStream = stream;
      document.querySelectorAll('.tab').forEach((t) => {
        t.classList.toggle('active', t.dataset.stream === stream);
      });
      document.getElementById('currentStreamName').textContent = stream;
      vscode.postMessage({ command: 'switchStream', stream });
    }
  });

  // Clear current stream
  document.getElementById('clearStreamBtn').addEventListener('click', () => {
    vscode.postMessage({ command: 'clearStream', stream: currentStream });
  });

  // Clear all streams
  document.getElementById('clearAllBtn').addEventListener('click', () => {
    vscode.postMessage({ command: 'clearAll' });
  });

  // Delete current stream
  document.getElementById('deleteStreamBtn').addEventListener('click', () => {
    vscode.postMessage({ command: 'deleteStream', stream: currentStream });
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
  }
});

// Initialize event listeners when DOM is loaded
document.addEventListener('DOMContentLoaded', setupEventListeners);
