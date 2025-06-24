// Third-party imports
import Sortable from 'sortablejs';

// Local imports - modules
import { vscode } from '@common/webviewContext.js';
import {
  addEventListenerSafely,
  safeGetElementById,
  safeGetElementValue,
} from '@common/domUtils.js';
import { capitalize } from '@common/stringUtils.js';
import { MULTIPLE_SELECTIONS, FILE_TYPES } from '../constants.js';
import { webviewState } from '../webviewState.js';
import { fileList } from './FileList.js';
import { fileSelect } from './FileSelect.js';
import { toggleOutputFiles } from '../fileHandlers.js';

export class FileInputManager {
  constructor(
    vscodeApi = vscode,
    state = webviewState,
    list = fileList,
    select = fileSelect,
  ) {
    this.vscode = vscodeApi;
    this.state = state;
    this.fileList = list;
    this.fileSelect = select;
  }

  getSingleFileData(fileTypes = ['input', 'reference', 'auxiliary', 'media']) {
    const data = {};
    fileTypes.forEach((type) => {
      data[`${type}File`] = safeGetElementValue(`${type}File`);
    });
    return data;
  }

  getMultipleFileData(singleFiles = {}) {
    const multipleFilesData = {};

    MULTIPLE_SELECTIONS.forEach((id) => {
      const container = safeGetElementById(`${id}Container`);
      const isActive = container?.style.display === 'block';
      multipleFilesData[`${id}Active`] = isActive;

      const singleFileKey = id.replace('Files', 'File');
      const singleFile = singleFiles[singleFileKey];

      const filesDiv = safeGetElementById(id);
      const files =
        isActive && filesDiv ? this.fileList.getSelected(filesDiv) : [];

      multipleFilesData[id] =
        id !== 'outputFiles' && singleFile
          ? files.filter((f) => f !== singleFile)
          : files;
    });

    return multipleFilesData;
  }

  setupSortable() {
    MULTIPLE_SELECTIONS.forEach((id) => {
      const element = safeGetElementById(id);
      if (element) {
        new Sortable(element, {
          animation: 150,
          onEnd: () => this.state.save(),
        });
      }
    });
  }

  setupEmptyButtons() {
    const fileTypes = [
      'input',
      'reference',
      'auxiliary',
      'media',
      'base',
      'edited',
    ];
    fileTypes.forEach((type) => {
      const capitalized = capitalize(type);
      addEventListenerSafely(`empty${capitalized}FileButton`, 'click', () => {
        const selectElement = safeGetElementById(`${type}File`);
        if (selectElement) {
          selectElement.value = '';
          this.state.save();
        }
      });
    });
  }

  setupSingleFileListeners() {
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

    addEventListenerSafely('editedFile', 'change', function () {
      const editedFile = this.value;
      vscode.postMessage({
        command: 'editedFileSelected',
        filePath: editedFile,
      });
    });

    addEventListenerSafely('baseFile', 'change', () => {
      const baseFile = safeGetElementValue('baseFile');
      this.vscode.postMessage({ command: 'requestEditedFile', baseFile });
      this.fileSelect.updateEdited(baseFile);
    });
  }

  setupMultipleFileButtons() {
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

    MULTIPLE_SELECTIONS.forEach((id) => {
      const toggleId = `toggle${capitalize(id)}`;
      const emptyButtonId = `empty${capitalize(id)}Button`;
      addEventListenerSafely(emptyButtonId, 'click', () =>
        this.fileList.empty(id, toggleId),
      );
    });
  }

  setupFileOperations() {
    const types = ['input', 'reference', 'auxiliary'];
    types.forEach((type) => {
      const capitalized = capitalize(type);
      addEventListenerSafely(
        `addOpened${capitalized}FilesButton`,
        'click',
        () => {
          this.vscode.postMessage({
            command: 'addOpenedFiles',
            fileType: type,
          });
        },
      );

      addEventListenerSafely(`current${capitalized}FileButton`, 'click', () => {
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

  setupToggleButtons() {
    MULTIPLE_SELECTIONS.forEach((id) => {
      const toggleId = `toggle${capitalize(id)}`;
      addEventListenerSafely(toggleId, 'click', () => {
        if (id === 'outputFiles') {
          toggleOutputFiles();
        } else {
          this.fileList.toggle(id, toggleId);
        }
      });
    });
  }

  setupIconHandlers() {
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

  setup() {
    this.setupSortable();
    this.setupEmptyButtons();
    this.setupSingleFileListeners();
    this.setupMultipleFileButtons();
    this.setupFileOperations();
    this.setupToggleButtons();
    this.setupIconHandlers();
  }
}
