import { initializeState } from './modules/stateManager.js';
import { setupMessageHandlers } from './modules/messageHandlers.js';
import {
  setupEventListeners,
  applyGroupToggleStates,
} from './modules/domHandlers.js';

// Initialize the state when the window loads
initializeState();

// Setup message handlers for VSCode messages
setupMessageHandlers();

// Initialize event listeners and state when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  // Setup UI event listeners
  setupEventListeners();

  // Apply saved group toggle states to any groups already in the DOM
  applyGroupToggleStates();
});
