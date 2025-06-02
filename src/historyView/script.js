import { vscode } from '@common/vscodeApi.js';
import { registerMessageHandlers } from '@common/messageRouter.js';
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
registerMessageHandlers({
  updateHistory: (message) => {
    renderHistoryItems(message.historyItems);
  },
  historyCleared: () => {
    renderHistoryItems([]);
  },
});
