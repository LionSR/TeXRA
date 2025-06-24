// Local imports
import { vscode } from '@common/webviewContext.js';
import {
  addEventListenerSafely,
  safeGetElementById,
  safeGetElementValue,
} from '@common/domUtils.js';
import { capitalize } from '@common/stringUtils.js';
import { MULTIPLE_SELECTIONS, FILE_TYPES } from '../constants.js';
import { toggleOutputFiles } from '../fileHandlers.js';
import { fileList } from './FileList.js';
import { fileSelect } from './FileSelect.js';

export class FileInputManager {
  constructor(state) {
    this.state = state;
  }

  setup() {
    MULTIPLE_SELECTIONS.forEach((id) => {
      const element = safeGetElementById(id);
      if (element) {
        new Sortable(element, {
          animation: 150,
          onEnd: () => this.state.save(),
        });
      }
    });

    new Sortable(safeGetElementById('outputFiles'), {
      animation: 150,
      onEnd: () => this.state.save(),
    });

    this.setupSingleFileInputs();
    this.setupMultipleFileButtons();
    this.setupFileOperations();
    this.setupToggles();
    this.setupIconButtons();
  }

  setupSingleFileInputs() {
    addEventListenerSafely('inputFile', 'change', function () {
      vscode.postMessage({
        command: 'inputFileSelected',
        filePath: this.value,
      });
    });

    addEventListenerSafely('referenceFile', 'change', function () {
      vscode.postMessage({
        command: 'referenceFileSelected',
        filePath: this.value,
      });
    });

    addEventListenerSafely('baseFile', 'change', () => {
      const baseFile = safeGetElementValue('baseFile');
      vscode.postMessage({
        command: 'requestEditedFile',
        baseFile,
      });
      fileSelect.updateEdited(baseFile);
    });

    ['input', 'reference', 'auxiliary', 'media', 'base', 'edited'].forEach(
      (type) => {
        const capitalizedType = capitalize(type);
        addEventListenerSafely(
          `empty${capitalizedType}FileButton`,
          'click',
          () => {
            const selectElement = safeGetElementById(`${type}File`);
            if (selectElement) {
              selectElement.value = '';
              this.state.save();
            }
          },
        );
      },
    );
  }

  setupMultipleFileButtons() {
    const multipleFileSelectors = FILE_TYPES.map((type) => ({
      id: `${capitalize(type)}Files`,
      selectId: type === 'output' ? 'inputFile' : `${type}File`,
    }));

    multipleFileSelectors.forEach(({ id, selectId }) => {
      const selectMultipleFilesButtonId = `select${id}Button`;
      addEventListenerSafely(selectMultipleFilesButtonId, 'click', () => {
        const currentFile = safeGetElementValue(selectId);
        vscode.postMessage({
          command: 'selectMultipleFiles',
          fileType: id,
          currentFile,
        });
      });
    });

    MULTIPLE_SELECTIONS.forEach((id) => {
      const toggleId = `toggle${capitalize(id)}`;
      const emptyButtonId = `empty${capitalize(id)}Button`;
      addEventListenerSafely(emptyButtonId, 'click', () =>
        fileList.empty(id, toggleId),
      );
    });
  }

  setupFileOperations() {
    const fileTypesWithOperations = ['input', 'reference', 'auxiliary'];
    fileTypesWithOperations.forEach((type) => {
      const capitalizedType = capitalize(type);

      const addOpenedButtonId = `addOpened${capitalizedType}FilesButton`;
      addEventListenerSafely(addOpenedButtonId, 'click', () => {
        vscode.postMessage({
          command: 'addOpenedFiles',
          fileType: type,
        });
      });

      const currentFileButtonId = `current${capitalizedType}FileButton`;
      addEventListenerSafely(currentFileButtonId, 'click', () => {
        vscode.postMessage({
          command: 'getCurrentFile',
          fileType: type,
        });
      });
    });

    ['base', 'edited'].forEach((type) => {
      addEventListenerSafely(
        `current${capitalize(type)}FileButton`,
        'click',
        () => {
          const baseFile = safeGetElementValue('baseFile');
          vscode.postMessage({
            command: 'getCurrentFile',
            fileType: type,
            baseFile,
          });
        },
      );
    });
  }

  setupToggles() {
    MULTIPLE_SELECTIONS.forEach((id) => {
      const toggleId = `toggle${capitalize(id)}`;
      addEventListenerSafely(toggleId, 'click', () => {
        if (id === 'outputFiles') {
          toggleOutputFiles();
        } else {
          fileList.toggle(id, toggleId);
        }
      });
    });
  }

  setupIconButtons() {
    const fileTypeIcons = document.querySelectorAll(
      '.file-select-header label .codicon.clickable',
    );
    fileTypeIcons.forEach((icon) => {
      if (icon.classList.contains('codicon-git-commit')) {
        icon.addEventListener('click', () => {
          vscode.postMessage({ command: 'refreshCommits' });
        });
      }
    });
  }
}
