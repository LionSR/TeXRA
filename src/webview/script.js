import { vscode } from './modules/vscodeApi.js';
import { restoreState } from './modules/stateManager.js';
import { setupMessageHandlers } from './modules/messageHandlers.js';
import { setupUIHandlers } from './modules/uiHandlers.js';

import {
  CHECK_BOXES_TOOL_USE,
  CHECK_BOXES_AUTO_EXTRACT,
} from './modules/constants.js';

// Add this function to handle textarea auto-resize
function autoResizeTextarea(textarea) {
  // Reset height to auto to get the correct scrollHeight
  textarea.style.height = 'auto';
  const maxHeight = 400;

  // Calculate the new height
  const newHeight = Math.min(textarea.scrollHeight, maxHeight);

  // Set new height
  textarea.style.height = newHeight + 'px';

  // Show/hide scrollbar based on content height
  textarea.style.overflowY =
    textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

window.onload = function () {
  const dataRequests = [
    'getTheme',
    'requestInputFile',
    'requestReferenceFile',
    'requestAuxiliaryFile',
    'requestFigureFile',
    'requestRecentCommits',
    'requestBaseFile',
  ];

  dataRequests.forEach((request) => {
    vscode.postMessage({ command: request });
  });

  // Set default state for new folders
  restoreState();

  // Setup auto-resize for instruction textarea
  const instructionInput = document.getElementById('instructionInput');
  if (instructionInput) {
    // Initial resize
    autoResizeTextarea(instructionInput);

    // Add input and change event listeners
    instructionInput.addEventListener('input', () => {
      autoResizeTextarea(instructionInput);
    });

    // Handle paste events
    instructionInput.addEventListener('paste', () => {
      // Use setTimeout to let the paste complete
      setTimeout(() => autoResizeTextarea(instructionInput), 0);
    });
  }
};

setupMessageHandlers();

document.addEventListener('DOMContentLoaded', function () {
  setupUIHandlers();

  // Pack and Clean button handlers
  const packButton = document.getElementById('packButton');
  const cleanButton = document.getElementById('cleanButton');

  if (packButton) {
    packButton.addEventListener('click', () => {
      const agent = document.getElementById('agent')?.value;
      if (agent) {
        vscode.postMessage({ command: 'packFiles', agent });
      }
    });
  }

  if (cleanButton) {
    cleanButton.addEventListener('click', () => {
      const agent = document.getElementById('agent')?.value;
      if (agent) {
        vscode.postMessage({ command: 'cleanFiles', agent });
      }
    });
  }

  // Tool Use dropdown toggle
  const toggleToolUse = document.getElementById('toggleToolUse');
  const toolUseOptions = document.getElementById('toolUseOptions');

  if (toggleToolUse && toolUseOptions) {
    // Initial state
    updateToolUseToggleState();

    toggleToolUse.addEventListener('click', (e) => {
      e.stopPropagation();
      toolUseOptions.style.display =
        toolUseOptions.style.display === 'none' ? 'block' : 'none';
    });
  }

  // Close dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    const toolUseOptions = document.getElementById('toolUseOptions');
    const autoExtractOptions = document.getElementById('autoExtractOptions');
    const toggleToolUse = document.getElementById('toggleToolUse');
    const toggleAutoExtract = document.getElementById('toggleAutoExtract');

    if (
      !toggleToolUse?.contains(e.target) &&
      !toolUseOptions?.contains(e.target)
    ) {
      toolUseOptions.style.display = 'none';
    }
    if (
      !toggleAutoExtract?.contains(e.target) &&
      !autoExtractOptions?.contains(e.target)
    ) {
      autoExtractOptions.style.display = 'none';
    }
  });

  // Update checkbox states in toggle button
  function updateToolUseToggleState() {
    const toggleToolUse = document.getElementById('toggleToolUse');

    const checkedCount = CHECK_BOXES_TOOL_USE.filter(
      (id) => document.getElementById(id)?.checked,
    ).length;

    if (toggleToolUse) {
      toggleToolUse.innerHTML = `Tool Use ${checkedCount > 0 ? '●' : '○'}<i class="codicon codicon-chevron-down"></i>`;
    }
  }

  // Add change listeners to all tool use checkboxes
  CHECK_BOXES_TOOL_USE.forEach((id) => {
    const checkbox = document.getElementById(id);
    if (checkbox) {
      checkbox.addEventListener('change', updateToolUseToggleState);
    }
  });
});
