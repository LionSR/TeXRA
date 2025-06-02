import { restoreState, saveState } from './modules/stateManager.js';
import {
  setupMessageHandlers,
  initializeDataRequests,
} from './modules/messageHandlers.js';
import {
  setupUIHandlers,
  updateAutoToggleState,
  updateToolConfigToggleState,
  autoResizeTextarea,
  setupDocumentListeners,
} from './modules/uiHandlers.js';

// Initialize data requests when window loads
window.onload = function () {
  initializeDataRequests();

  // Set default state for new folders
  restoreState();

  // Setup auto-resize for instruction textarea
  const instruction = document.getElementById('instruction');
  if (instruction) {
    // Initial resize
    autoResizeTextarea(instruction);

    // Add input and change event listeners
    instruction.addEventListener('input', () => {
      autoResizeTextarea(instruction);
      // Make sure changes to the textarea get saved in the state
      saveState();
    });

    // Handle paste events
    instruction.addEventListener('paste', () => {
      // Use setTimeout to let the paste complete
      setTimeout(() => {
        autoResizeTextarea(instruction);
        saveState();
      }, 0);
    });
  }
};

// Setup message handlers
setupMessageHandlers();

// Setup UI when DOM is loaded
document.addEventListener('DOMContentLoaded', function () {
  setupUIHandlers();

  // Update initial toggle states
  updateToolConfigToggleState();
  updateAutoToggleState();

  // Setup document-level event listeners
  setupDocumentListeners();
});
