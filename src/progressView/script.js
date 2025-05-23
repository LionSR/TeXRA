import { initializeState } from './modules/stateManager.js';
import { setupMessageHandlers } from './modules/messageHandlers.js';
import {
  setupEventListeners,
  applyGroupToggleStates,
  renderHeaderActions,
} from './modules/domHandlers.js';
import { vscode } from './modules/vscodeApi.js';
import { COMMANDS } from './modules/constants.js';

// Initialize the state when the window loads
initializeState();

// Setup message handlers for VSCode messages
setupMessageHandlers();

// Initialize event listeners and state when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  // Render toolbar and setup UI event listeners
  renderHeaderActions();
  setupEventListeners();

  // Apply saved group toggle states to any groups already in the DOM
  applyGroupToggleStates();
});
