import { vscode } from './vscodeApi.js';
import {
  updateFileSelect,
  updateEditedFileSelect,
  updateMultipleFileSelect,
  handleRecentCommits,
} from './fileHandlers.js';
import {
  safeSetElementValue,
  safeSetElementChecked,
  safeGetElementById,
} from './utils.js';
import { restoreState } from './stateManager.js';
import { MULTIPLE_SELECTIONS } from './utils.js';

export function setupMessageHandlers() {
  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.command) {
      case 'setTheme':
        document.body.className = message.theme;
        break;
      case 'modelSelected':
        safeSetElementValue('model', message.model);
        break;
      // File selection
      case 'setInputFile':
      case 'setReferenceFile':
      case 'setAuxiliaryFile':
      case 'setFigureFile':
      case 'setEditedFile':
        updateFileSelect(
          `${message.command.charAt(3).toLowerCase() + message.command.slice(4)}`,
          message.files,
        );
        break;
      case 'inputFileSelected':
      case 'referenceFileSelected':
      case 'auxiliaryFileSelected':
      case 'figureFileSelected':
      case 'editedFileSelected':
        safeSetElementValue(
          message.command.replace('Selected', ''),
          message.filePath,
        );
        break;
      // Multiple file selection
      case 'setMultipleInputFiles':
      case 'setMultipleReferenceFiles':
      case 'setMultipleAuxiliaryFiles':
      case 'setMultipleFigures':
      case 'setMultipleOutputFiles':
        updateMultipleFileSelect(
          `${message.command.replace('setMultiple', 'multiple')}`,
          `toggle${message.command.replace('set', '')}`,
          message.files,
        );
        break;
      case 'setRecentCommits':
        handleRecentCommits(message);
        break;
      case 'setCurrentFile':
        const fileId = `${message.fileType}File`;
        const fileDiv = document.getElementById(fileId);
        if (!fileDiv) {
          console.warn(`Element with id '${fileId}' not found`);
          return;
        }
        const options = Array.from(fileDiv.options);
        if (options.some((option) => option.value === message.filePath)) {
          safeSetElementValue(fileId, message.filePath);
          fileDiv.dispatchEvent(new Event('change'));
        } else {
          vscode.postMessage({
            command: 'showInformationMessage',
            text: `The current file is not in the ${message.fileType} file list: ${message.filePath}`,
          });
        }
        break;
      case 'setOpenedFiles':
        MULTIPLE_SELECTIONS.forEach((id) => {
          const toggleId = `toggle${id.charAt(0).toUpperCase() + id.slice(1)}`;
          updateMultipleFileSelect(id, toggleId, message.files);
        });
        break;
      case 'setBaseFile':
        updateFileSelect('baseFile', message.files);
        const baseFileDiv = safeGetElementById('baseFile');
        if (baseFileDiv) {
          updateEditedFileSelect(baseFileDiv.value);
        }
        break;
    }

    restoreState();
  });
}
