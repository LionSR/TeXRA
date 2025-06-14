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

    // Handle paste events
    instruction.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items || [];
      let insertText = '';
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            const ext = item.type.split('/')[1].replace('jpeg', 'jpg');
            const fileName = `pasted_${Date.now()}_${Math.random()
              .toString(16)
              .slice(2, 8)}.${ext}`;
            const reader = new FileReader();
            reader.onload = () => {
              const result = reader.result;
              if (typeof result === 'string') {
                const base64 = result.split(',')[1];
                vscode.postMessage({
                  command: 'clipboardImage',
                  base64,
                  mediaType: item.type,
                  fileName,
                });
              }
            };
            reader.readAsDataURL(file);
            insertText += `[${fileName}]`;
          }
        }
      }
      if (insertText) {
        insertTextAtCursor(instruction, insertText);
      }
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
