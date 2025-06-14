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
      let hasImage = false;
      let images = [];

      // First, collect all images and check if there's text
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          hasImage = true;
          const file = item.getAsFile();
          if (file) {
            images.push({ file, type: item.type });
          }
        }
      }

      // If we have images, prevent default and handle everything manually
      if (hasImage) {
        e.preventDefault();

        // Get any text content from clipboard
        const textContent = e.clipboardData?.getData('text/plain') || '';
        if (textContent) {
          insertText = textContent;
        }

        // Process each image
        images.forEach((imageData, index) => {
          // Better MIME type to extension mapping
          const mimeToExt = {
            'image/jpeg': 'jpg',
            'image/jpg': 'jpg',
            'image/png': 'png',
            'image/gif': 'gif',
            'image/webp': 'webp',
            'image/bmp': 'bmp',
            'image/svg+xml': 'svg',
            'image/pjpeg': 'jpg', // Handle progressive JPEG
          };
          const ext =
            mimeToExt[imageData.type] || imageData.type.split('/')[1] || 'png';
          // Note: We can't import the utility here, so we keep the pattern consistent
          const fileName = `pasted_${Date.now()}_${Math.random()
            .toString(16)
            .slice(2, 8)}.${ext}`;
          const reader = new FileReader();

          reader.onload = () => {
            const result = reader.result;
            if (typeof result === 'string') {
              const base64 = result.split(',')[1];
              if (base64) {
                vscode.postMessage({
                  command: 'clipboardImage',
                  base64,
                  mediaType: imageData.type,
                  fileName,
                });
              }
            }
          };

          reader.onerror = () => {
            console.error(`Failed to read file: ${fileName}`);
            vscode.postMessage({
              command: 'showInformationMessage',
              text: `Failed to process pasted image: ${fileName}`,
            });
          };

          try {
            reader.readAsDataURL(imageData.file);
            // Add spacing if needed
            if (
              insertText &&
              !insertText.endsWith(' ') &&
              !insertText.endsWith('\n')
            ) {
              insertText += ' ';
            }
            insertText += `[${fileName}]`;
          } catch (err) {
            console.error(`Error reading file: ${err}`);
          }
        });

        // Insert all text and image references at once
        if (insertText) {
          insertTextAtCursor(instruction, insertText);
        }
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
