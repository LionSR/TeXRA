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
    const cap = capitalize(type);
    const ids = {
      singleId: `${type}File`,
      emptySingleId: `empty${cap}FileButton`,
      listId: `${type}Files`,
      toggleId: `toggle${cap}Files`,
      emptyListId: `empty${cap}FilesButton`,
    };

    if (type === 'output') {
      ids.singleId = undefined;
      ids.emptySingleId = undefined;
    }

    if (type === 'base' || type === 'edited') {
      ids.listId = undefined;
      ids.toggleId = undefined;
      ids.emptyListId = undefined;
    }

    return ids;
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
    const selectors = FILE_TYPES.map((type) => ({
      id: `${capitalize(type)}Files`,
      selectId: type === 'output' ? INPUT_FILE : `${type}File`,
    }));

    selectors.forEach(({ id, selectId }) => {
      const buttonId = `select${id}Button`;
      this.addListener(buttonId, 'click', () => {
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
    const baseTypes = FILE_TYPES.filter(
      (type) => type !== 'media' && type !== 'output',
    );

    const buttonConfigs = [
      {
        prefix: 'addOpened',
        suffix: 'FilesButton',
        command: MAIN_VIEW_COMMANDS.ADD_OPENED_FILES,
        types: baseTypes,
      },
      {
        prefix: 'current',
        suffix: 'FileButton',
        command: MAIN_VIEW_COMMANDS.GET_CURRENT_FILE,
        types: [...baseTypes, 'base', 'edited'],
      },
    ];

    buttonConfigs.forEach(({ prefix, suffix, command, types }) => {
      types.forEach((type) => {
        const cap = capitalize(type);
        const id = `${prefix}${cap}${suffix}`;
        this.addListener(id, 'click', () => {
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
    const iconConfigs = [
      {
        className: 'codicon-file-code',
        getRequests: () => [
          {
            command: MAIN_VIEW_COMMANDS.REQUEST_INPUT_FILE,
            payload: {
              notifyWhenEmpty: true,
            },
          },
        ],
      },
      {
        className: 'codicon-book',
        getRequests: () => [
          {
            command: MAIN_VIEW_COMMANDS.REQUEST_REFERENCE_FILE,
            payload: {
              notifyWhenEmpty: true,
            },
          },
        ],
      },
      {
        className: 'codicon-file-add',
        getRequests: () => [
          {
            command: MAIN_VIEW_COMMANDS.REQUEST_AUXILIARY_FILE,
            payload: {
              notifyWhenEmpty: true,
            },
          },
        ],
      },
      {
        className: 'codicon-file-media',
        getRequests: () => [
          {
            command: MAIN_VIEW_COMMANDS.REQUEST_MEDIA_FILE,
            payload: {
              notifyWhenEmpty: true,
            },
          },
        ],
      },
      {
        className: 'codicon-edit',
        getRequests: () => {
          const baseFile = safeGetElementValue(BASE_FILE);
          return [
            {
              command: MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE,
              payload: {
                preserveBaseFile: true,
              },
            },
            {
              command: MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE,
              payload: {
                baseFile,
                preserveSelection: safeGetElementValue(EDITED_FILE),
                notifyWhenEmpty: true,
              },
            },
          ];
        },
      },
      {
        className: 'codicon-git-commit',
        getRequests: () => [
          {
            command: MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS,
            payload: {
              notifyWhenEmpty: true,
            },
          },
        ],
      },
    ];

    const icons = document.querySelectorAll(
      '.file-select-header label .codicon.clickable',
    );

    icons.forEach((icon) => {
      const config = iconConfigs.find((item) =>
        icon.classList.contains(item.className),
      );
      if (!config) {
        return;
      }

      const handler = () => {
        const requests = config.getRequests ? config.getRequests() : [];
        requests.forEach(({ command, payload = {} }) => {
          this.vscode.postMessage({
            command,
            ...payload,
          });
        });
      };

      this.addListener(icon, 'click', handler);
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
