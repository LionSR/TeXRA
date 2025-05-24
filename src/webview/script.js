import { vscode } from './modules/vscodeApi.js';
import { restoreState, saveState } from './modules/stateManager.js';
import { setupMessageHandlers } from './modules/messageHandlers.js';
import {
  setupUIHandlers,
  updateAutoToggleState,
  updateToolConfigToggleState,
  autoResizeTextarea,
} from './modules/uiHandlers.js';

window.onload = function () {
  const dataRequests = [
    'getTheme',
    'requestInputFile',
    'requestReferenceFile',
    'requestAuxiliaryFile',
    'requestMediaFile',
    'requestRecentCommits',
    'requestBaseFile',
  ];

  dataRequests.forEach((request) => {
    vscode.postMessage({ command: request });
  });

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

setupMessageHandlers();

document.addEventListener('DOMContentLoaded', function () {
  setupUIHandlers();

  // Pack and Clean button handlers
  const packButton = document.getElementById('packButton');
  const cleanButton = document.getElementById('cleanButton');
  const compareButton = document.getElementById('compareButton');
  const acceptButton = document.getElementById('acceptButton');

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

  if (compareButton) {
    compareButton.addEventListener('click', () => {
      const baseFile = document.getElementById('baseFile')?.value;
      const editedFile = document.getElementById('editedFile')?.value;

      if (baseFile && editedFile) {
        vscode.postMessage({
          command: 'compare',
          baseFile: baseFile,
          editedFile: editedFile,
        });
      } else {
        vscode.postMessage({
          command: 'showInformationMessage',
          text: 'Please select both base and edited files to compare',
        });
      }
    });
  }

  if (acceptButton) {
    acceptButton.addEventListener('click', () => {
      const baseFile = document.getElementById('baseFile')?.value;
      const editedFile = document.getElementById('editedFile')?.value;

      if (baseFile && editedFile) {
        vscode.postMessage({
          command: 'acceptEdited',
          baseFile: baseFile,
          editedFile: editedFile,
        });
      } else {
        vscode.postMessage({
          command: 'showInformationMessage',
          text: 'Please select both base and edited files to accept changes',
        });
      }
    });
  }

  // Tool Config dropdown toggle
  const toggleToolConfig = document.getElementById('toggleToolConfig');
  const toolConfigOptions = document.getElementById('toolConfigOptions');

  if (toggleToolConfig && toolConfigOptions) {
    // Initial state
    updateToolConfigToggleState();

    toggleToolConfig.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = toolConfigOptions.style.display === 'block';
      toolConfigOptions.style.display = isVisible ? 'none' : 'block';
      updateToolConfigToggleState();
    });
  }

  // Close dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    const toolConfigOptions = document.getElementById('toolConfigOptions');
    const autoExtractOptions = document.getElementById('autoExtractOptions');
    const toggleToolConfig = document.getElementById('toggleToolConfig');
    const toggleAutoExtract = document.getElementById('toggleAutoExtract');

    if (
      !toggleToolConfig?.contains(e.target) &&
      !toolConfigOptions?.contains(e.target)
    ) {
      toolConfigOptions.style.display = 'none';
      updateToolConfigToggleState();
    }
    if (
      !toggleAutoExtract?.contains(e.target) &&
      !autoExtractOptions?.contains(e.target)
    ) {
      autoExtractOptions.style.display = 'none';
      updateAutoToggleState();
    }
  });
});
