// Local imports
import { vscode } from '@common/webviewContext.js';
import {
  addEventListenerSafely,
  safeGetElementById,
  safeGetElementValue,
} from '@common/domUtils.js';
import { capitalize } from '@common/stringUtils.js';
import Sortable from 'sortablejs';
import {
  FILE_TYPES,
  MULTIPLE_SELECTIONS,
  ELEMENTS_TO_SAVE,
} from '../constants.js';
import { webviewState } from '../webviewState.js';
import { fileList } from './FileList.js';
import { fileSelect } from './FileSelect.js';

/**
 * Handles single and multiple file selector events.
 */
export class FileInputManager {
  constructor(vscodeApi = vscode, state = webviewState) {
    this.vscode = vscodeApi;
    this.state = state;
  }

  /** Initialize drag-and-drop sorting for file lists */
  initSortables() {
    MULTIPLE_SELECTIONS.forEach((id) => {
      const element = safeGetElementById(id);
      if (element) {
        new Sortable(element, {
          animation: 150,
          onEnd: () => this.state.save(),
        });
      }
    });

    const outputFiles = safeGetElementById('outputFiles');
    if (outputFiles) {
      new Sortable(outputFiles, {
        animation: 150,
        onEnd: () => this.state.save(),
      });
    }
  }

  /** Setup handlers for single file dropdowns */
  setupSingleFileSelects() {
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

    addEventListenerSafely('baseFile', 'change', () => {
      const baseFile = safeGetElementValue('baseFile');
      vscode.postMessage({ command: 'requestEditedFile', baseFile });
      fileSelect.updateEdited(baseFile);
    });
  }

  /** Setup handlers for multi-file selection buttons */
  setupMultiFileButtons() {
    const selectors = FILE_TYPES.map((type) => ({
      id: `${capitalize(type)}Files`,
      selectId: type === 'output' ? 'inputFile' : `${type}File`,
    }));

    selectors.forEach(({ id, selectId }) => {
      const selectBtnId = `select${id}Button`;
      addEventListenerSafely(selectBtnId, 'click', () => {
        const currentFile = safeGetElementValue(selectId);
        this.vscode.postMessage({
          command: 'selectMultipleFiles',
          fileType: id,
          currentFile,
        });
      });
    });

    const fileTypesWithOperations = ['input', 'reference', 'auxiliary'];
    fileTypesWithOperations.forEach((type) => {
      const cap = capitalize(type);
      addEventListenerSafely(`addOpened${cap}FilesButton`, 'click', () => {
        this.vscode.postMessage({ command: 'addOpenedFiles', fileType: type });
      });
      addEventListenerSafely(`current${cap}FileButton`, 'click', () => {
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

  /** Setup handlers for empty buttons */
  setupEmptyButtons() {
    const types = [
      'input',
      'reference',
      'auxiliary',
      'media',
      'base',
      'edited',
    ];
    types.forEach((type) => {
      const cap = capitalize(type);
      addEventListenerSafely(`empty${cap}FileButton`, 'click', () => {
        const selectElement = safeGetElementById(`${type}File`);
        if (selectElement) {
          selectElement.value = '';
          this.state.save();
        }
      });
    });

    MULTIPLE_SELECTIONS.forEach((id) => {
      const toggleId = `toggle${capitalize(id)}`;
      const emptyId = `empty${capitalize(id)}Button`;
      addEventListenerSafely(emptyId, 'click', () =>
        fileList.empty(id, toggleId),
      );
    });
  }

  /** Setup handlers for commit refresh icon */
  setupCommitRefresh() {
    const icons = document.querySelectorAll(
      '.file-select-header label .codicon.clickable',
    );
    icons.forEach((icon) => {
      if (icon.classList.contains('codicon-git-commit')) {
        icon.addEventListener('click', () => {
          this.vscode.postMessage({ command: 'refreshCommits' });
        });
      }
    });
  }

  /** Attach change listeners for form elements to persist state */
  setupStateSaving() {
    ELEMENTS_TO_SAVE.forEach((id) => {
      if (id !== 'instruction') {
        addEventListenerSafely(id, 'change', () => this.state.save());
      }
    });
    addEventListenerSafely('instruction', 'input', () => this.state.save());
  }

  /** Set up all handlers */
  setup() {
    this.initSortables();
    this.setupSingleFileSelects();
    this.setupMultiFileButtons();
    this.setupEmptyButtons();
    this.setupCommitRefresh();
    this.setupStateSaving();
  }
}

export const fileInputManager = new FileInputManager();
