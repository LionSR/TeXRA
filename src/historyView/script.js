import { vscode } from './modules/vscodeApi.js';
import {
  renderHistoryItems,
  setupEventListeners,
} from './modules/domHandlers.js';

// Initialize the webview when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  // Request history data from the extension
  vscode.postMessage({ command: 'getHistoryData' });

  // Set up event listeners
  setupEventListeners();
});

// Handle messages from the extension
window.addEventListener('message', (event) => {
  const message = event.data;

  switch (message.command) {
    case 'updateHistory':
      renderHistoryItems(message.historyItems);
      break;

    case 'historyCleared':
      renderHistoryItems([]);
      break;
  }
});
