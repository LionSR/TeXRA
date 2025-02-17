import {
  updateFileSelect,
  updateEditedFileSelect,
  updateMultipleFileSelect,
  handleRecentCommits,
  handleSetCurrentFile,
} from './fileHandlers.js';
import {
  safeSetElementValue,
  safeSetElementChecked,
  safeGetElementById,
} from './utils.js';
import { restoreState } from './stateManager.js';
import { MULTIPLE_SELECTIONS } from './utils.js';
import { capitalize, uncapitalize } from './utils.js';

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
        updateFileSelect(uncapitalize(message.command.slice(3)), message.files);
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
      case 'setMultipleFigureFiles':
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
        handleSetCurrentFile({
          fileType: message.fileType,
          filePath: message.filePath,
        });
        break;
      case 'setOpenedFiles':
        MULTIPLE_SELECTIONS.forEach((id) => {
          const toggleId = `toggle${capitalize(id)}`;
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
