// Third-party imports
import Sortable from 'sortablejs';

// Local imports - webview
import {
  MULTIPLE_SELECTIONS,
  FILE_TYPES,
  ELEMENTS_TO_SAVE,
  INPUT_FILE,
  REFERENCE_FILE,
  AUXILIARY_FILE,
  MEDIA_FILE,
  EDITED_FILE,
  BASE_FILE,
} from '../constants.js';
import { mainViewState } from '../mainViewState.js';
import { BaseUIManager } from './BaseUIManager.js';
import { fileList } from './FileList.js';
import { fileSelect } from './FileSelect.js';
import { outputFilesManager } from './OutputFilesManager.js';
import { safeGetElementById, safeGetElementValue } from '@common/domUtils.js';
import {
  getAddOpenedFilesButtonId,
  getCurrentFileButtonId,
  getEmptyMultipleFilesButtonId,
  getEmptySingleFileButtonId,
  getMultipleFilesId,
  getSelectMultipleFilesButtonId,
  getSingleFileId,
  getToggleId,
} from '@common/domIdUtils.js';
import { capitalize } from '@common/stringUtils.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
import { vscode } from '@common/webviewContext.js';

export class FileInputManager extends BaseUIManager {
  constructor(
    vscodeInstance = vscode,
    state = mainViewState,
    list = fileList,
    select = fileSelect,
    outputMgr = outputFilesManager,
  ) {
    super();
    this.vscode = vscodeInstance;
    this.state = state;
    this.fileList = list;
    this.fileSelect = select;
    this.outputFilesManager = outputMgr;
    this._sortables = [];
  }

  _getFileIds(type) {
    return {
      singleId: getSingleFileId(type),
      emptySingleId: getEmptySingleFileButtonId(type),
      listId: getMultipleFilesId(type),
      toggleId: getToggleId(type),
      emptyListId: getEmptyMultipleFilesButtonId(type),
    };
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
    // Show instruction on focus, before user makes selection
    this.addListener(INPUT_FILE, 'focus', () => {
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.SHOW_INSTRUCTION,
        key: 'inputFileSelect',
        text: 'Choose the main LaTeX file to process. Use the Current button to pick the active editor.',
      });
    });

    this.addListener(INPUT_FILE, 'change', (e) => {
      const inputFile = e.target.value;
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED,
        filePath: inputFile,
      });
    });

    this.addListener(REFERENCE_FILE, 'change', (e) => {
      const referenceFile = e.target.value;
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED,
        filePath: referenceFile,
      });
    });

    this.addListener(BASE_FILE, 'change', () => {
      const baseFile = safeGetElementValue(BASE_FILE);
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
    this._setupFileTypeHandlers();
    this._setupRefreshIcons();
  }

  _setupMultipleFileButtons() {
    const selectors = FILE_TYPES.map((type) => {
      const listId = getMultipleFilesId(type);
      const selectId = type === 'output' ? INPUT_FILE : getSingleFileId(type);
      const buttonId = getSelectMultipleFilesButtonId(type);
      const fileType = listId ? capitalize(listId) : undefined;

      return { buttonId, selectId, fileType };
    }).filter(({ buttonId, selectId, fileType }) =>
      Boolean(buttonId && selectId && fileType),
    );

    selectors.forEach(({ buttonId, selectId, fileType }) => {
      this.addListener(buttonId, 'click', () => {
        const currentFile = safeGetElementValue(selectId);
        this.vscode.postMessage({
          command: MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES,
          fileType,
          currentFile,
        });
      });
    });
  }

  _setupFileTypeButtons() {
    const baseTypes = FILE_TYPES.filter(
      (type) => type !== 'media' && type !== 'output',
    );

    const buttonConfigs = [
      {
        getId: getAddOpenedFilesButtonId,
        command: MAIN_VIEW_COMMANDS.ADD_OPENED_FILES,
        types: baseTypes,
      },
      {
        getId: getCurrentFileButtonId,
        command: MAIN_VIEW_COMMANDS.GET_CURRENT_FILE,
        types: [...baseTypes, 'base', 'edited'],
      },
    ];

    buttonConfigs.forEach(({ getId, command, types }) => {
      types.forEach((type) => {
        const buttonId = getId(type);
        if (!buttonId) return;
        this.addListener(buttonId, 'click', () => {
          const payload = { command, fileType: type };
          if (
            (type === 'edited' || type === 'base') &&
            command === MAIN_VIEW_COMMANDS.GET_CURRENT_FILE
          ) {
            payload.baseFile = safeGetElementValue(BASE_FILE);
          }
          this.vscode.postMessage(payload);
        });
      });
    });
  }

  _setupFileTypeHandlers() {
    const allTypes = [...FILE_TYPES, 'base', 'edited'];
    allTypes.forEach((type) => {
      const { singleId, emptySingleId, listId, toggleId, emptyListId } =
        this._getFileIds(type);

      if (emptySingleId) {
        this.addListener(emptySingleId, 'click', () => {
          const selectEl = safeGetElementById(singleId);
          if (selectEl) {
            selectEl.value = '';
            this.state.save();
          }
        });
      }

      if (emptyListId) {
        this.addListener(emptyListId, 'click', () =>
          this.fileList.empty(listId, toggleId),
        );
      }

      if (toggleId) {
        this.addListener(toggleId, 'click', () => {
          if (type === 'output') {
            this.outputFilesManager.toggleOutputFiles();
          } else {
            this.fileList.toggle(listId, toggleId);
          }
        });
      }
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
        this.addListener(icon, 'click', handler);
      }
    });
  }

  _setupSaveListeners() {
    ELEMENTS_TO_SAVE.forEach((id) => {
      if (id === 'agent' || id === 'model') {
        return; // handled by SettingsButtonManager
      }
      if (id !== 'instruction') {
        this.addListener(id, 'change', () => this.state.save());
      }
    });
    this.addListener('instruction', 'input', () => this.state.save());
  }

  setup() {
    this._setupSortable();
    this._setupSingleFileSelectors();
    this._setupMultipleFileSelectors();
    this._setupSaveListeners();
  }

  cleanup() {
    super.cleanup();
    this._sortables.forEach((s) => s.destroy());
    this._sortables = [];
  }
}
