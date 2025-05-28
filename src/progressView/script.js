import { initializeState } from './modules/stateManager.js';
import { setupMessageHandlers } from './modules/messageHandlers.js';
import {
  setupEventListeners,
  applyGroupToggleStates,
  renderToolbar,
} from './modules/domHandlers.js';
import { vscode } from './modules/vscodeApi.js';
import { COMMANDS } from './modules/constants.js';

// Initialize the state when the window loads
initializeState();

// Setup message handlers for VSCode messages
setupMessageHandlers();

// Initialize event listeners and state when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  renderToolbar();
  // Setup UI event listeners
  setupEventListeners();

  // Apply saved group toggle states to any groups already in the DOM
  applyGroupToggleStates();
});
