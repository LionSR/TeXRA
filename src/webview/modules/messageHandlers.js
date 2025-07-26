// Local imports - webview context
import { vscode, registerMessageHandlers } from '@common/webviewContext.js';
import {
  safeSetElementValue,
  safeGetElementById,
  updateChevronIcon,
} from '@common/domUtils.js';
import { capitalize, uncapitalize } from '@common/stringUtils.js';
import { createFromTemplate } from '@common/templateUtils.js';
import { mainViewState } from './mainViewState.js';
import { mainViewDomHandler } from './domHandlers.js';

// Local imports - UI managers
import { fileList } from './uiManagers/FileList.js';
import { fileSelect } from './uiManagers/FileSelect.js';
import { webviewEventBus } from './eventBus.js';

import {
  FILE_TYPES,
  INPUT_FILE,
  REFERENCE_FILE,
  AUXILIARY_FILE,
  MEDIA_FILE,
  EDITED_FILE,
  BASE_FILE,
  ELEMENT_IDS,
} from './constants.js';

// Import standardized commands
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';

/**
 * Handles messages from the extension and syncs the webview state.
 */
export class MainViewMessageHandler {
  constructor() {
    this._skipNextRestoreState = false;
    this._cleanupFn = null;

    // Cached DOM elements
    this._instructionEl = null;
    this._elementCache = new Map();
    // Track file list event handlers for cleanup
    this._fileListHandlers = {};

    this._handlers = {
      ...this._createThemeHandlers(),
      ...this._createStateHandlers(),
      ...this._createInstructionHandlers(),
      ...this._createRecordingHandlers(),
      ...this._createSingleFileHandlers(),
      ...this._createMultiFileHandlers(),
      ...this._createMiscHandlers(),
    };
  }

  _createThemeHandlers() {
    return {
      [MAIN_VIEW_COMMANDS.THEME_SET]: (m) => this.handleSetTheme(m),
      [MAIN_VIEW_COMMANDS.DEBUG_MODE_SET]: (m) => this.handleSetDebugMode(m),
      [MAIN_VIEW_COMMANDS.MODEL_SELECTED]: (m) => this.handleModelSelected(m),
    };
  }

  _createStateHandlers() {
    return {
      [MAIN_VIEW_COMMANDS.STATE_RESTORE]: (m) => this.handleRestoreState(m),
      [MAIN_VIEW_COMMANDS.CHECK_RESTORED_BASE_FILE]: () =>
        this.handleCheckRestoredBaseFile(),
    };
  }

  _createInstructionHandlers() {
    return {
      [MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISHED]: (m) =>
        this.handleInstructionTextPolished(m),
      [MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_TRANSCRIBED]: (m) =>
        this.handleInstructionTextTranscribed(m),
    };
  }

  _createRecordingHandlers() {
    return {
      [MAIN_VIEW_COMMANDS.RECORDING_STARTED]: () =>
        this.handleRecordingStarted(),
      [MAIN_VIEW_COMMANDS.RECORDING_ERROR]: () => this.handleRecordingError(),
    };
  }

  _createSingleFileHandlers() {
    return {
      [MAIN_VIEW_COMMANDS.SET_INPUT_FILE]: (m) => this.handleSetInputFile(m),
      [MAIN_VIEW_COMMANDS.SET_REFERENCE_FILE]: (m) =>
        this.handleSetReferenceFile(m),
      [MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILE]: (m) =>
        this.handleSetAuxiliaryFile(m),
      [MAIN_VIEW_COMMANDS.SET_MEDIA_FILE]: (m) => this.handleSetMediaFile(m),
      [MAIN_VIEW_COMMANDS.SET_EDITED_FILE]: (m) => this.handleSetEditedFile(m),
      [MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED]: (m) =>
        this.handleInputFileSelected(m),
      [MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED]: (m) =>
        this.handleReferenceFileSelected(m),
      [MAIN_VIEW_COMMANDS.AUXILIARY_FILE_SELECTED]: (m) =>
        this.handleAuxiliaryFileSelected(m),
      [MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED]: (m) =>
        this.handleMediaFileSelected(m),
      [MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED]: (m) =>
        this.handleEditedFileSelected(m),
      [MAIN_VIEW_COMMANDS.SET_DEFAULT_OUTPUT_FILES]: (m) =>
        this.handleSetDefaultOutputFiles(m),
    };
  }

  _createMultiFileHandlers() {
    return {
      [MAIN_VIEW_COMMANDS.SET_INPUT_FILES]: (m) => this.handleSetInputFiles(m),
      [MAIN_VIEW_COMMANDS.SET_REFERENCE_FILES]: (m) =>
        this.handleSetReferenceFiles(m),
      [MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILES]: (m) =>
        this.handleSetAuxiliaryFiles(m),
      [MAIN_VIEW_COMMANDS.SET_MEDIA_FILES]: (m) => this.handleSetMediaFiles(m),
      [MAIN_VIEW_COMMANDS.ADD_MEDIA_FILE]: (m) => this.handleAddMediaFile(m),
      [MAIN_VIEW_COMMANDS.SET_OUTPUT_FILES]: (m) =>
        this.handleSetOutputFiles(m),
    };
  }

  _createMiscHandlers() {
    return {
      [MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS]: (m) =>
        this.handleSetRecentCommits(m),
      [MAIN_VIEW_COMMANDS.SET_CURRENT_FILE]: (m) =>
        this.handleSetCurrentFile(m),
      [MAIN_VIEW_COMMANDS.SET_OPENED_FILES]: (m) =>
        this.handleSetOpenedFiles(m),
      [MAIN_VIEW_COMMANDS.SET_BASE_FILE]: (m) => this.handleSetBaseFile(m),
    };
  }

  /** Register handlers and optionally request initial data. */
  setup(options = {}) {
    const { requestData = true } = options;
    this._cleanupFn = registerMessageHandlers(this._handlers);
    if (requestData) {
      this._initializeDataRequests();
    }
  }

  requestInitialData() {
    this._initializeDataRequests();
  }

  cleanup() {
    if (this._cleanupFn) {
      this._cleanupFn();
      this._cleanupFn = null;
    }
    Object.values(this._fileListHandlers).forEach(({ container, handler }) => {
      container.removeEventListener('click', handler);
    });
    this._fileListHandlers = {};
    this._instructionEl = null;
    this._elementCache.clear();
  }

  /* ---------- Private helpers ---------- */
  _setToggleIcon(element, isVisible) {
    if (!element) return;
    updateChevronIcon(element, isVisible);
  }

  _createFileItem(file) {
    const element = createFromTemplate('fileListEntryTemplate', {
      text: { '.file-name': file },
      dataset: { '': { path: file } },
    });
    if (element) return element;

    const fileItem = document.createElement('div');
    fileItem.className = 'file-item';
    fileItem.dataset.path = file;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'file-name';
    nameSpan.textContent = file;
    fileItem.appendChild(nameSpan);

    const removeButton = document.createElement('span');
    removeButton.className = 'remove-button';
    removeButton.textContent = '-';
    fileItem.appendChild(removeButton);

    return fileItem;
  }

  _setupFileListHandler(fileType, container) {
    if (!container || this._fileListHandlers[fileType]) return;
    const handler = (e) => {
      if (
        e.target instanceof HTMLElement &&
        e.target.classList.contains('remove-button')
      ) {
        e.stopPropagation();
        const item = e.target.closest('.file-item');
        if (item) {
          item.remove();
          const updated = Array.from(
            container.querySelectorAll('.file-item'),
          ).map((el) => el.dataset.path);
          const updateCommands = {
            input: MAIN_VIEW_COMMANDS.UPDATE_INPUT_FILES,
            reference: MAIN_VIEW_COMMANDS.UPDATE_REFERENCE_FILES,
            auxiliary: MAIN_VIEW_COMMANDS.UPDATE_AUXILIARY_FILES,
            media: MAIN_VIEW_COMMANDS.UPDATE_MEDIA_FILES,
            output: MAIN_VIEW_COMMANDS.UPDATE_OUTPUT_FILES,
          };
          vscode.postMessage({
            command: updateCommands[fileType],
            files: updated,
          });
          mainViewState.update({ [`${fileType}Files`]: updated });
        }
      }
    };
    container.addEventListener('click', handler);
    this._fileListHandlers[fileType] = { container, handler };
  }

  _getElement(id) {
    if (!this._elementCache.has(id)) {
      this._elementCache.set(id, safeGetElementById(id));
    }
    return this._elementCache.get(id);
  }

  _initializeDataRequests() {
    const dataRequests = [
      MAIN_VIEW_COMMANDS.GET_THEME,
      MAIN_VIEW_COMMANDS.GET_DEBUG_MODE,
      MAIN_VIEW_COMMANDS.REQUEST_INPUT_FILE,
      MAIN_VIEW_COMMANDS.REQUEST_REFERENCE_FILE,
      MAIN_VIEW_COMMANDS.REQUEST_AUXILIARY_FILE,
      MAIN_VIEW_COMMANDS.REQUEST_MEDIA_FILE,
      MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS,
      MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE,
    ];
    dataRequests.forEach((command) => {
      vscode.postMessage({ command });
    });

    // Also request default output files for the current agent
    const agentElement = this._getElement('agent');
    if (agentElement && agentElement.value) {
      vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.REQUEST_DEFAULT_OUTPUT_FILES,
        agent: agentElement.value,
      });
    }
  }

  _handleStateRestoration(state) {
    console.log('Restoring state:', state);

    const config = state.agentConfig || state;
    const activeFiles = state.activeFiles || {};

    const savedState = {};
    this._restoreFormFields(config, savedState);
    this._restoreFileArrays(config, savedState, activeFiles);
    mainViewState.set(savedState);
    mainViewState.restore();
    this._skipNextRestoreState = true;
  }

  _restoreFormFields(state, savedState) {
    if (state.agent) safeSetElementValue('agent', state.agent);
    if (state.model) safeSetElementValue('model', state.model);

    const instructionContent = state.instruction || '';
    const instruction =
      this._instructionEl ||
      (this._instructionEl = this._getElement('instruction'));
    if (instruction) {
      instruction.value = instructionContent;
      instruction.dispatchEvent(new Event('input'));
    }

    if (state.inputFile) safeSetElementValue(INPUT_FILE, state.inputFile);
    if (state.referenceFile)
      safeSetElementValue(REFERENCE_FILE, state.referenceFile);
    if (state.auxiliaryFile)
      safeSetElementValue(AUXILIARY_FILE, state.auxiliaryFile);
    if (state.mediaFile) safeSetElementValue(MEDIA_FILE, state.mediaFile);

    const toolConfig = state.toolConfig || {};
    Object.assign(savedState, {
      agent: state.agent,
      model: state.model,
      instruction: instructionContent,
      inputFile: state.inputFile,
      referenceFile: state.referenceFile,
      auxiliaryFile: state.auxiliaryFile,
      mediaFile: state.mediaFile,
      reflect: state.reflect ?? toolConfig.reflect ?? false,
      autoExtractFigure:
        state.autoExtractFigure ?? toolConfig.autoExtractFigure ?? false,
      autoExtractTikzFigure:
        state.autoExtractTikzFigure ??
        toolConfig.autoExtractTikzFigure ??
        false,
      attachTeXCount:
        state.attachTeXCount ?? toolConfig.attachTeXCount ?? false,
      usePrefillFromInput:
        state.usePrefillFromInput ?? toolConfig.usePrefillFromInput ?? false,
      printInputPrompt:
        state.printInputPrompt ?? toolConfig.printInputPrompt ?? false,
      autoCompileInputPdf:
        state.autoCompileInputPdf ?? toolConfig.autoCompileInputPdf ?? false,
    });
  }

  _restoreFileArrays(state, savedState, activeFiles = {}) {
    for (const fileType of FILE_TYPES) {
      const filesArray =
        state[`${fileType}Files`] ||
        state[`multiple${capitalize(fileType)}Files`] ||
        [];
      const isVisible =
        activeFiles[fileType] ||
        state[`${fileType}FilesActive`] ||
        state[`multiple${capitalize(fileType)}FilesActive`] ||
        false;

      const targetArrayName = `${fileType}Files`;
      const visibilityName = `${targetArrayName}Active`;
      savedState[targetArrayName] = filesArray;
      savedState[visibilityName] = isVisible;

      const multipleFilesId = `${fileType}Files`;
      const multipleFiles = this._getElement(multipleFilesId);
      if (filesArray.length > 0 || isVisible) {
        const containerId = `${fileType}FilesContainer`;
        const toggleId = `toggle${capitalize(fileType)}Files`;

        const container = this._getElement(containerId);
        if (container) {
          container.style.display = isVisible ? 'block' : 'none';
        }

        const toggleElement = this._getElement(toggleId);
        this._setToggleIcon(toggleElement, isVisible);

        if (filesArray.length > 0 && multipleFiles) {
          multipleFiles.innerHTML = '';
          filesArray.forEach((file) => {
            multipleFiles.appendChild(this._createFileItem(file));
          });
          this._setupFileListHandler(fileType, multipleFiles);
        }
      }
    }
  }

  _postHandle() {
    if (this._skipNextRestoreState) {
      this._skipNextRestoreState = false;
    } else {
      mainViewState.restore();
    }
  }

  /* ---------- Command handlers ---------- */
  // Theme & debug
  handleSetTheme(message) {
    if (!message || typeof message.theme !== 'string') {
      console.warn('Invalid theme message:', message);
      return;
    }
    document.body.className = message.theme;
    this._postHandle();
  }

  handleSetDebugMode(message) {
    mainViewDomHandler.setDebugMode(message.debugMode);
    this._postHandle();
  }

  handleModelSelected(message) {
    safeSetElementValue('model', message.model);
    this._postHandle();
  }

  // State restoration
  handleRestoreState(message) {
    this._handleStateRestoration(message.state);
    this._postHandle();
  }

  handleCheckRestoredBaseFile() {
    const restoredBaseFileDiv = this._getElement(BASE_FILE);
    if (restoredBaseFileDiv && restoredBaseFileDiv.value) {
      fileSelect.updateEdited(restoredBaseFileDiv.value);
    }
    this._postHandle();
  }

  // Instruction updates
  handleInstructionTextPolished(message) {
    const instruction = this._getElement('instruction');
    if (instruction && message.text) {
      instruction.value = message.text;
      vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE,
        text: 'Instruction text has been polished!',
      });
      mainViewState.save();
    }
    this._postHandle();
  }

  handleInstructionTextTranscribed(message) {
    const instruction = this._getElement('instruction');
    if (instruction && message.text) {
      const startPos = instruction.selectionStart;
      const endPos = instruction.selectionEnd;
      const textBefore = instruction.value.substring(0, startPos);
      const textAfter = instruction.value.substring(endPos);
      instruction.value = textBefore + message.text + textAfter;
      const newCursorPos = startPos + message.text.length;
      instruction.setSelectionRange(newCursorPos, newCursorPos);
      instruction.focus();
      vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE,
        text: 'Instruction text transcribed!',
      });
      mainViewState.save();
    }
    webviewEventBus.dispatchEvent(
      new CustomEvent('recordingUIUpdate', { detail: { recording: false } }),
    );
    this._postHandle();
  }

  // Recording
  handleRecordingStarted() {
    webviewEventBus.dispatchEvent(
      new CustomEvent('recordingUIUpdate', { detail: { recording: true } }),
    );
    this._postHandle();
  }

  handleRecordingError() {
    webviewEventBus.dispatchEvent(
      new CustomEvent('recordingUIUpdate', { detail: { recording: false } }),
    );
    this._postHandle();
  }

  // Single file updates
  handleSetInputFile(message) {
    fileSelect.update(INPUT_FILE, message.files);
    this._postHandle();
  }

  handleSetReferenceFile(message) {
    fileSelect.update(REFERENCE_FILE, message.files);
    this._postHandle();
  }

  handleSetAuxiliaryFile(message) {
    fileSelect.update(AUXILIARY_FILE, message.files);
    this._postHandle();
  }

  handleSetMediaFile(message) {
    fileSelect.update(MEDIA_FILE, message.files);
    this._postHandle();
  }

  handleSetEditedFile(message) {
    fileSelect.update(EDITED_FILE, message.files);
    this._postHandle();
  }

  handleInputFileSelected(message) {
    safeSetElementValue(INPUT_FILE, message.filePath);
    this._postHandle();
  }

  handleReferenceFileSelected(message) {
    safeSetElementValue(REFERENCE_FILE, message.filePath);
    this._postHandle();
  }

  handleAuxiliaryFileSelected(message) {
    safeSetElementValue(AUXILIARY_FILE, message.filePath);
    this._postHandle();
  }

  handleMediaFileSelected(message) {
    safeSetElementValue(MEDIA_FILE, message.filePath);
    this._postHandle();
  }

  handleEditedFileSelected(message) {
    safeSetElementValue(EDITED_FILE, message.filePath);
    this._postHandle();
  }

  handleSetDefaultOutputFiles(message) {
    fileSelect.setAgentDefaultOutputFiles(message.files || []);
    this._postHandle();
  }

  // Multi-file updates
  handleSetInputFiles(message) {
    fileList.update('inputFiles', 'toggleInputFiles', message.files);
    this._setupFileListHandler('input', this._getElement('inputFiles'));
    this._postHandle();
  }

  handleSetReferenceFiles(message) {
    fileList.update('referenceFiles', 'toggleReferenceFiles', message.files);
    this._setupFileListHandler('reference', this._getElement('referenceFiles'));
    this._postHandle();
  }

  handleSetAuxiliaryFiles(message) {
    fileList.update('auxiliaryFiles', 'toggleAuxiliaryFiles', message.files);
    this._setupFileListHandler('auxiliary', this._getElement('auxiliaryFiles'));
    this._postHandle();
  }

  handleSetMediaFiles(message) {
    fileList.update('mediaFiles', 'toggleMediaFiles', message.files);
    this._setupFileListHandler('media', this._getElement('mediaFiles'));
    this._postHandle();
  }

  handleAddMediaFile(message) {
    const listDiv = this._getElement('mediaFiles');
    const existingFiles = listDiv ? fileList.getSelected(listDiv) : [];
    fileList.update('mediaFiles', 'toggleMediaFiles', [
      ...existingFiles,
      message.file,
    ]);
    this._setupFileListHandler('media', listDiv);

    const container = this._getElement('mediaFilesContainer');
    if (container && container.style.display === 'none') {
      container.style.display = 'block';
      const toggleIcon = this._getElement('toggleMediaFiles');
      this._setToggleIcon(toggleIcon, true);
    }

    this._postHandle();
  }

  handleSetOutputFiles(message) {
    fileList.update(
      ELEMENT_IDS.OUTPUT_FILES,
      ELEMENT_IDS.TOGGLE_OUTPUT_FILES,
      message.files,
    );
    this._setupFileListHandler(
      'output',
      this._getElement(ELEMENT_IDS.OUTPUT_FILES),
    );
    this._postHandle();
  }

  // Misc updates
  handleSetRecentCommits(message) {
    fileSelect.handleRecentCommits(message);
    this._postHandle();
  }

  handleSetCurrentFile(message) {
    fileSelect.handleSetCurrentFile({
      fileType: message.fileType,
      filePath: message.filePath,
    });
    this._postHandle();
  }

  handleSetOpenedFiles(message) {
    if (message.fileType) {
      const fileType = message.fileType.replace('Files', '');
      const singleFileId = `${uncapitalize(fileType)}File`;
      const multipleFileId = `${uncapitalize(fileType)}Files`;
      const toggleId = `toggle${capitalize(fileType)}Files`;

      let filesToAdd = message.files ?? [];
      if (message.shouldFilter) {
        const singleFileSelect = this._getElement(singleFileId);
        if (singleFileSelect && singleFileSelect.value) {
          filesToAdd = filesToAdd.filter((f) => f !== singleFileSelect.value);
        }
      }

      fileList.update(multipleFileId, toggleId, filesToAdd);
    }
    this._postHandle();
  }

  handleSetBaseFile(message) {
    const currentBaseFileDiv = this._getElement(BASE_FILE);
    if (currentBaseFileDiv) {
      const currentBaseFile = currentBaseFileDiv.value;
      fileSelect.update(BASE_FILE, message.files);

      const state = mainViewState.get();
      const storedBaseFile = state?.baseFile;

      if (storedBaseFile && message.files.includes(storedBaseFile)) {
        currentBaseFileDiv.value = storedBaseFile;
      } else if (
        message.preserveBaseFile &&
        currentBaseFile &&
        message.files.includes(currentBaseFile)
      ) {
        currentBaseFileDiv.value = currentBaseFile;
      }

      fileSelect.updateEdited(currentBaseFileDiv.value);
    }
    this._postHandle();
  }
}

export const messageHandler = new MainViewMessageHandler();
