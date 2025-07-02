// Local imports
import { vscode } from '@common/webviewContext.js';
import Sortable from 'sortablejs';
import { safeGetElementById, safeGetElementValue } from '@common/domUtils.js';
import { capitalize } from '@common/stringUtils.js';
import {
  MULTIPLE_SELECTIONS,
  FILE_TYPES,
  ELEMENTS_TO_SAVE,
} from '../constants.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
import { fileList } from './FileList.js';
import { fileSelect } from './FileSelect.js';
import { outputFilesManager } from './OutputFilesManager.js';
import { mainViewState } from '../mainViewState.js';

export class FileInputManager {
  constructor(
    vscodeInstance = vscode,
    state = mainViewState,
    list = fileList,
    select = fileSelect,
    outputMgr = outputFilesManager,
  ) {
    this.vscode = vscodeInstance;
    this.state = state;
    this.fileList = list;
    this.fileSelect = select;
    this.outputFilesManager = outputMgr;
    this._listeners = [];
    this._sortables = [];
  }

  _addListener(elementOrId, event, handler) {
    const element =
      typeof elementOrId === 'string'
        ? safeGetElementById(elementOrId)
        : elementOrId;
    if (element) {
      element.addEventListener(event, handler);
      this._listeners.push({ element, event, handler });
    }
  }

  _setupSortable() {
    MULTIPLE_SELECTIONS.forEach((id) => {
      const element = safeGetElementById(id);
      if (element) {
        const sortable = new Sortable(element, {
          animation: 150,
          onEnd: () => this.state.save(),
        });
        this._sortables.push(sortable);
      }
    });
  }

  _setupSingleFileSelectors() {
    this._addListener('inputFile', 'change', (e) => {
      const inputFile = e.target.value;
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED,
        filePath: inputFile,
      });
    });

    this._addListener('referenceFile', 'change', (e) => {
      const referenceFile = e.target.value;
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED,
        filePath: referenceFile,
      });
    });

    this._addListener('baseFile', 'change', () => {
      const baseFile = safeGetElementValue('baseFile');
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE,
        baseFile,
      });
      this.fileSelect.updateEdited(baseFile);
    });
  }

  _setupMultipleFileSelectors() {
    this._setupMultipleFileButtons();
    this._setupFileTypeButtons();
    this._setupEmptyAndToggleButtons();
    this._setupRefreshIcons();
  }

  _setupMultipleFileButtons() {
    const selectors = FILE_TYPES.map((type) => ({
      id: `${capitalize(type)}Files`,
      selectId: type === 'output' ? 'inputFile' : `${type}File`,
    }));

    selectors.forEach(({ id, selectId }) => {
      const buttonId = `select${id}Button`;
      this._addListener(buttonId, 'click', () => {
        const currentFile = safeGetElementValue(selectId);
        this.vscode.postMessage({
          command: MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES,
          fileType: id,
          currentFile,
        });
      });
    });
  }

  _setupFileTypeButtons() {
    const fileTypes = ['input', 'reference', 'auxiliary'];
    fileTypes.forEach((type) => {
      const cap = capitalize(type);
      this._addListener(`addOpened${cap}FilesButton`, 'click', () => {
        this.vscode.postMessage({
          command: MAIN_VIEW_COMMANDS.ADD_OPENED_FILES,
          fileType: type,
        });
      });
      this._addListener(`current${cap}FileButton`, 'click', () => {
        this.vscode.postMessage({
          command: MAIN_VIEW_COMMANDS.GET_CURRENT_FILE,
          fileType: type,
        });
      });
    });

    ['base', 'edited'].forEach((type) => {
      this._addListener(`current${capitalize(type)}FileButton`, 'click', () => {
        const baseFile = safeGetElementValue('baseFile');
        this.vscode.postMessage({
          command: MAIN_VIEW_COMMANDS.GET_CURRENT_FILE,
          fileType: type,
          baseFile,
        });
      });
    });
  }

  _setupEmptyAndToggleButtons() {
    MULTIPLE_SELECTIONS.forEach((id) => {
      const toggleId = `toggle${capitalize(id)}`;
      const emptyButtonId = `empty${capitalize(id)}Button`;
      this._addListener(emptyButtonId, 'click', () =>
        this.fileList.empty(id, toggleId),
      );
      this._addListener(toggleId, 'click', () => {
        if (id === 'outputFiles') {
          this.outputFilesManager.toggleOutputFiles();
        } else {
          this.fileList.toggle(id, toggleId);
        }
      });
    });
  }

  _setupRefreshIcons() {
    const icons = document.querySelectorAll(
      '.file-select-header label .codicon.clickable',
    );
    icons.forEach((icon) => {
      if (icon.classList.contains('codicon-git-commit')) {
        const handler = () => {
          this.vscode.postMessage({
            command: MAIN_VIEW_COMMANDS.REFRESH_COMMITS,
          });
        };
        icon.addEventListener('click', handler);
        this._listeners.push({ element: icon, event: 'click', handler });
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
      this._addListener(`empty${capitalize(type)}FileButton`, 'click', () => {
        const selectEl = safeGetElementById(`${type}File`);
        if (selectEl) {
          selectEl.value = '';
          this.state.save();
        }
      });
    });
  }

  _setupSaveListeners() {
    ELEMENTS_TO_SAVE.forEach((id) => {
      if (id === 'agent' || id === 'model') {
        return; // handled by SettingsButtonManager
      }
      if (id !== 'instruction') {
        this._addListener(id, 'change', () => this.state.save());
      }
    });
    this._addListener('instruction', 'input', () => this.state.save());
  }

  setup() {
    this._setupSortable();
    this._setupSingleFileSelectors();
    this._setupMultipleFileSelectors();
    this._setupEmptyButtons();
    this._setupSaveListeners();
  }

  cleanup() {
    this._listeners.forEach(({ element, event, handler }) => {
      element.removeEventListener(event, handler);
    });
    this._listeners = [];
    this._sortables.forEach((s) => s.destroy());
    this._sortables = [];
  }
}
