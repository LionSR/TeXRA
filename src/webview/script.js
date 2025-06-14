import { restoreState, saveState } from './modules/stateManager.js';
import { vscode } from '@common/vscodeApi.js';
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
import { setupPasteListener } from './modules/pasteHandler.js';

function insertTextAtCursor(textarea, text) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const original = textarea.value;
  textarea.value = original.slice(0, start) + text + original.slice(end);
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
}

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

    // Setup paste event listener for image handling
    setupPasteListener(
      instruction,
      vscode,
      autoResizeTextarea,
      saveState,
      insertTextAtCursor,
    );
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
