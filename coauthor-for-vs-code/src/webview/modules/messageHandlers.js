import { vscode } from './vscodeApi.js';
import {
  updateFileSelect,
  updateEditedFileSelect,
  updateMultipleFileSelect,
  handleRecentCommits,
} from './fileHandlers.js';
import { restoreState } from './stateManager.js';
import { MULTIPLE_SELECTIONS } from './utils.js';

export function setupMessageHandlers() {
  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.command) {
      // VS Code Logic
      case 'setTheme':
        document.body.className = message.theme;
        break;
      case 'modelSelected':
        document.getElementById('modelSelect').value = message.model;
        break;
      // File selection
      case 'setInputFile':
      case 'setReferenceFile':
      case 'setAuxiliaryFile':
      case 'setFigureFile':
      case 'setEditedFile':
        updateFileSelect(
          `${message.command.charAt(3).toLowerCase() + message.command.slice(4)}Select`,
          message.files,
        );
        break;
      case 'inputFileSelected':
      case 'referenceFileSelected':
      case 'auxiliaryFileSelected':
      case 'figureFileSelected':
      case 'editedFileSelected':
        document.getElementById(
          `${message.command.replace('Selected', 'Select')}`,
        ).value = message.filePath;
        break;
      // Multiple file selection
      case 'setMultipleInputFiles':
      case 'setMultipleReferenceFiles':
      case 'setMultipleAuxiliaryFiles':
      case 'setMultipleFigures':
      case 'setMultipleOutputFiles':
        updateMultipleFileSelect(
          `${message.command.replace('setMultiple', 'multiple')}Select`,
          `toggle${message.command.replace('set', '')}`,
          message.files,
        );
        break;
      case 'setRecentCommits':
        handleRecentCommits(message);
        break;
      case 'setCurrentFile':
        const fileSelect = document.getElementById(
          `${message.fileType}FileSelect`,
        );
        const options = Array.from(fileSelect.options);
        const matchingOption = options.find(
          (option) => option.value === message.filePath,
        );
        if (matchingOption) {
          fileSelect.value = message.filePath;
          // Trigger change event to update related fields
          fileSelect.dispatchEvent(new Event('change'));
        } else {
          vscode.postMessage({
            command: 'showInformationMessage',
            text: `The current file is not in the ${message.fileType} file list: ${message.filePath}`,
          });
        }
        break;
      case 'setOpenedFiles':
        MULTIPLE_SELECTIONS.forEach((id) => {
          const baseId = id.replace('Select', '');
          const toggleId = `toggle${baseId.charAt(0).toUpperCase() + baseId.slice(1)}`;
          updateMultipleFileSelect(id, toggleId, message.files);
        });
        break;
      case 'setBaseFile':
        updateFileSelect('baseFileSelect', message.files);
        updateEditedFileSelect(document.getElementById('baseFileSelect').value);
        // sus
        break;
    }

    // Restore previous state
    restoreState();
  });
}
