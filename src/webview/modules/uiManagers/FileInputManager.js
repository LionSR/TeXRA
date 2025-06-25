// Local imports
import { vscode } from '@common/webviewContext.js';
import Sortable from 'sortablejs';
import {
  safeGetElementById,
  addEventListenerSafely,
  safeGetElementValue,
} from '@common/domUtils.js';
import { capitalize } from '@common/stringUtils.js';
import {
  MULTIPLE_SELECTIONS,
  FILE_TYPES,
  ELEMENTS_TO_SAVE,
} from '../constants.js';
import { fileList } from './FileList.js';
import { fileSelect } from './FileSelect.js';
import { outputFilesManager } from './OutputFilesManager.js';
import { webviewState } from '../webviewState.js';

export class FileInputManager {
  constructor(
    vscodeInstance = vscode,
    state = webviewState,
    list = fileList,
    select = fileSelect,
    outputMgr = outputFilesManager,
  ) {
    this.vscode = vscodeInstance;
    this.state = state;
    this.fileList = list;
    this.fileSelect = select;
    this.outputFilesManager = outputMgr;
  }

  _setupSortable() {
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
  }

  _setupSingleFileSelectors() {
    addEventListenerSafely('inputFile', 'change', (e) => {
      const inputFile = e.target.value;
      this.vscode.postMessage({
        command: 'inputFileSelected',
        filePath: inputFile,
      });
    });

    addEventListenerSafely('referenceFile', 'change', (e) => {
      const referenceFile = e.target.value;
      this.vscode.postMessage({
        command: 'referenceFileSelected',
        filePath: referenceFile,
      });
    });

    addEventListenerSafely('baseFile', 'change', () => {
      const baseFile = safeGetElementValue('baseFile');
      this.vscode.postMessage({
        command: 'requestEditedFile',
        baseFile,
      });
      this.fileSelect.updateEdited(baseFile);
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

    const fileTypes = ['input', 'reference', 'auxiliary'];
    fileTypes.forEach((type) => {
      const cap = capitalize(type);
      addEventListenerSafely(`addOpened${cap}FilesButton`, 'click', () => {
        this.vscode.postMessage({
          command: 'addOpenedFiles',
          fileType: type,
        });
      });
      addEventListenerSafely(`current${cap}FileButton`, 'click', () => {
        this.vscode.postMessage({
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
          this.vscode.postMessage({
            command: 'getCurrentFile',
            fileType: type,
            baseFile,
          });
        },
      );
    });

    MULTIPLE_SELECTIONS.forEach((id) => {
      const toggleId = `toggle${capitalize(id)}`;
      const emptyButtonId = `empty${capitalize(id)}Button`;
      addEventListenerSafely(emptyButtonId, 'click', () =>
        this.fileList.empty(id, toggleId),
      );
      addEventListenerSafely(toggleId, 'click', () => {
        if (id === 'outputFiles') {
          this.outputFilesManager.toggleOutputFiles();
        } else {
          this.fileList.toggle(id, toggleId);
        }
      });
    });

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

  _setupEmptyButtons() {
    const types = [
      'input',
      'reference',
      'auxiliary',
      'media',
      'base',
      'edited',
    ];
    types.forEach((type) => {
      addEventListenerSafely(
        `empty${capitalize(type)}FileButton`,
        'click',
        () => {
          const selectEl = safeGetElementById(`${type}File`);
          if (selectEl) {
            selectEl.value = '';
            this.state.save();
          }
        },
      );
    });
  }

  _setupSaveListeners() {
    ELEMENTS_TO_SAVE.forEach((id) => {
      if (id !== 'instruction') {
        addEventListenerSafely(id, 'change', () => this.state.save());
      }
    });
    addEventListenerSafely('instruction', 'input', () => this.state.save());
  }

  setup() {
    this._setupSortable();
    this._setupSingleFileSelectors();
    this._setupMultipleFileSelectors();
    this._setupEmptyButtons();
    this._setupSaveListeners();
  }
}

export const fileInputManager = new FileInputManager();
