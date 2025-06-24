import { logState } from './modules/webviewLogState.js';
import { setupMessageHandlers } from './modules/messageHandlers.js';
import {
  setupEventListeners,
  applyGroupToggleStates,
  renderToolbar,
} from './modules/domHandlers.js';
import { vscode } from '@common/webviewContext.js';
import { COMMANDS } from './modules/constants.js';

// Initialize the state when the window loads
logState.initialize();

// Setup message handlers for VSCode messages
setupMessageHandlers();

// Initialize event listeners and state when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  renderToolbar();
  // Setup UI event listeners
  setupEventListeners();

  // Apply saved group toggle states to any groups already in the DOM
  applyGroupToggleStates();

  // Notify extension that the webview is ready to receive messages
  vscode.postMessage({ command: COMMANDS.WEBVIEW_READY });
});
