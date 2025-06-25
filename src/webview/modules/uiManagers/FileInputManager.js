// Local imports
import { vscode } from '@common/webviewContext.js';
import {
  addEventListenerSafely,
  safeGetElementValue,
} from '@common/domUtils.js';
import { capitalize } from '@common/stringUtils.js';
import { FILE_TYPES, MULTIPLE_SELECTIONS } from '../constants.js';
import { fileList } from './FileList.js';
import { fileSelect } from './FileSelect.js';
import { outputFilesManager } from './OutputFilesManager.js';
import { webviewState } from '../webviewState.js';

/**
 * Manages events for single and multiple file selectors.
 */
export class FileInputManager {
  constructor(
    vscodeApi = vscode,
    list = fileList,
    select = fileSelect,
    outputManager = outputFilesManager,
    state = webviewState,
  ) {
    this.vscode = vscodeApi;
    this.fileList = list;
    this.fileSelect = select;
    this.outputFilesManager = outputManager;
    this.state = state;
  }

  /** Initialize event listeners for all file inputs */
  setup() {
    this._setupSingleFileListeners();
    this._setupMultipleFileSelectors();
    this._setupFileOperations();
    this._setupBaseFileListener();
    this._setupListToggles();
    this._setupIconRefreshHandlers();
  }

  _setupSingleFileListeners() {
    addEventListenerSafely('inputFile', 'change', function () {
      const inputFile = this.value;
      vscode.postMessage({ command: 'inputFileSelected', filePath: inputFile });
    });

    addEventListenerSafely('referenceFile', 'change', function () {
      const referenceFile = this.value;
      vscode.postMessage({
        command: 'referenceFileSelected',
        filePath: referenceFile,
      });
    });

    addEventListenerSafely('auxiliaryFile', 'change', function () {
      const auxiliaryFile = this.value;
      vscode.postMessage({
        command: 'auxiliaryFileSelected',
        filePath: auxiliaryFile,
      });
    });

    addEventListenerSafely('mediaFile', 'change', function () {
      const mediaFile = this.value;
      vscode.postMessage({ command: 'mediaFileSelected', filePath: mediaFile });
    });
  }

  _setupMultipleFileSelectors() {
    const selectors = FILE_TYPES.map((type) => ({
      id: `${capitalize(type)}Files`,
      selectId: type === 'output' ? 'inputFile' : `${type}File`,
    }));

    selectors.forEach(({ id, selectId }) => {
      const buttonId = `select${id}Button`;
      addEventListenerSafely(buttonId, 'click', () => {
        const currentFile = safeGetElementValue(selectId);
        this.vscode.postMessage({
          command: 'selectMultipleFiles',
          fileType: id,
          currentFile,
        });
      });
    });

    const singleTypes = [
      'input',
      'reference',
      'auxiliary',
      'media',
      'base',
      'edited',
    ];
    singleTypes.forEach((type) => {
      const emptyId = `empty${capitalize(type)}FileButton`;
      addEventListenerSafely(emptyId, 'click', () => {
        const selectEl = document.getElementById(`${type}File`);
        if (selectEl) {
          selectEl.value = '';
          this.state.save();
        }
      });
    });

    MULTIPLE_SELECTIONS.forEach((id) => {
      const toggleId = `toggle${capitalize(id)}`;
      const emptyButtonId = `empty${capitalize(id)}Button`;
      addEventListenerSafely(emptyButtonId, 'click', () =>
        this.fileList.empty(id, toggleId),
      );
    });
  }

  _setupFileOperations() {
    const types = ['input', 'reference', 'auxiliary'];
    types.forEach((type) => {
      const capitalized = capitalize(type);

      const addOpenedId = `addOpened${capitalized}FilesButton`;
      addEventListenerSafely(addOpenedId, 'click', () => {
        this.vscode.postMessage({ command: 'addOpenedFiles', fileType: type });
      });

      const currentId = `current${capitalized}FileButton`;
      addEventListenerSafely(currentId, 'click', () => {
        this.vscode.postMessage({ command: 'getCurrentFile', fileType: type });
      });
    });

    ['base', 'edited'].forEach((type) => {
      addEventListenerSafely(
        `current${capitalize(type)}FileButton`,
        'click',
        () => {
          const baseFile = safeGetElementValue('baseFile');
          this.vscode.postMessage({
            command: 'getCurrentFile',
            fileType: type,
            baseFile,
          });
        },
      );
    });
  }

  _setupBaseFileListener() {
    addEventListenerSafely('baseFile', 'change', () => {
      const baseFile = safeGetElementValue('baseFile');
      this.vscode.postMessage({ command: 'requestEditedFile', baseFile });
      this.fileSelect.updateEdited(baseFile);
    });
  }

  _setupListToggles() {
    MULTIPLE_SELECTIONS.forEach((id) => {
      const toggleId = `toggle${capitalize(id)}`;
      addEventListenerSafely(toggleId, 'click', () => {
        if (id === 'outputFiles') {
          this.outputFilesManager.toggleOutputFiles();
        } else {
          this.fileList.toggle(id, toggleId);
        }
      });
    });
  }

  _setupIconRefreshHandlers() {
    const fileTypeIcons = document.querySelectorAll(
      '.file-select-header label .codicon.clickable',
    );
    fileTypeIcons.forEach((icon) => {
      if (icon.classList.contains('codicon-git-commit')) {
        icon.addEventListener('click', () => {
          this.vscode.postMessage({ command: 'refreshCommits' });
        });
      }
    });
  }
}

export const fileInputManager = new FileInputManager();
