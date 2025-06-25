// Local imports - webview context
import {
  vscode,
  registerMessageHandlers,
  CHEVRON_UP_CLASS,
  CHEVRON_DOWN_CLASS,
} from '@common/webviewContext.js';
import { safeSetElementValue, safeGetElementById } from '@common/domUtils.js';
import { capitalize, uncapitalize } from '@common/stringUtils.js';
import { webviewState } from './webviewState.js';
import { setDebugMode as applyDebugMode } from './uiHandlers.js';

// Local imports - UI managers
import { fileList } from './uiManagers/FileList.js';
import { fileSelect } from './uiManagers/FileSelect.js';
import { webviewEventBus } from './eventBus.js';

import { FILE_TYPES } from './constants.js';

/**
 * Handles messages from the extension and syncs the webview state.
 */
export class MessageHandlers {
  constructor() {
    this._skipNextRestoreState = false;
    this._cleanupFn = null;

    // Cached DOM elements
    this._instructionEl = null;
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
      setTheme: (m) => this.handleSetTheme(m),
      setDebugMode: (m) => this.handleSetDebugMode(m),
      modelSelected: (m) => this.handleModelSelected(m),
    };
  }

  _createStateHandlers() {
    return {
      restoreState: (m) => this.handleRestoreState(m),
      checkRestoredBaseFile: () => this.handleCheckRestoredBaseFile(),
    };
  }

  _createInstructionHandlers() {
    return {
      instructionTextPolished: (m) => this.handleInstructionTextPolished(m),
      instructionTextTranscribed: (m) =>
        this.handleInstructionTextTranscribed(m),
    };
  }

  _createRecordingHandlers() {
    return {
      recordingStarted: () => this.handleRecordingStarted(),
      recordingError: () => this.handleRecordingError(),
    };
  }

  _createSingleFileHandlers() {
    return {
      setInputFile: (m) => this.handleSetInputFile(m),
      setReferenceFile: (m) => this.handleSetReferenceFile(m),
      setAuxiliaryFile: (m) => this.handleSetAuxiliaryFile(m),
      setMediaFile: (m) => this.handleSetMediaFile(m),
      setEditedFile: (m) => this.handleSetEditedFile(m),
      inputFileSelected: (m) => this.handleInputFileSelected(m),
      referenceFileSelected: (m) => this.handleReferenceFileSelected(m),
      auxiliaryFileSelected: (m) => this.handleAuxiliaryFileSelected(m),
      mediaFileSelected: (m) => this.handleMediaFileSelected(m),
      editedFileSelected: (m) => this.handleEditedFileSelected(m),
      setDefaultOutputFiles: (m) => this.handleSetDefaultOutputFiles(m),
    };
  }

  _createMultiFileHandlers() {
    return {
      setInputFiles: (m) => this.handleSetInputFiles(m),
      setReferenceFiles: (m) => this.handleSetReferenceFiles(m),
      setAuxiliaryFiles: (m) => this.handleSetAuxiliaryFiles(m),
      setMediaFiles: (m) => this.handleSetMediaFiles(m),
      addMediaFile: (m) => this.handleAddMediaFile(m),
      setOutputFiles: (m) => this.handleSetOutputFiles(m),
    };
  }

  _createMiscHandlers() {
    return {
      setRecentCommits: (m) => this.handleSetRecentCommits(m),
      setCurrentFile: (m) => this.handleSetCurrentFile(m),
      setOpenedFiles: (m) => this.handleSetOpenedFiles(m),
      setBaseFile: (m) => this.handleSetBaseFile(m),
    };
  }

  /** Register handlers and request initial data. */
  setup() {
    this._cleanupFn = registerMessageHandlers(this._handlers);
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
  }

  /* ---------- Private helpers ---------- */
  _setToggleIcon(element, isVisible) {
    if (!element) return;
    element.innerHTML = '';
    const icon = document.createElement('i');
    icon.className = isVisible ? CHEVRON_UP_CLASS : CHEVRON_DOWN_CLASS;
    element.appendChild(icon);
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
          vscode.postMessage({
            command: `update${capitalize(fileType)}Files`,
            files: updated,
          });
          webviewState.update({ [`${fileType}Files`]: updated });
        }
      }
    };
    container.addEventListener('click', handler);
    this._fileListHandlers[fileType] = { container, handler };
  }

  _initializeDataRequests() {
    const dataRequests = [
      'getTheme',
      'getDebugMode',
      'requestInputFile',
      'requestReferenceFile',
      'requestAuxiliaryFile',
      'requestMediaFile',
      'requestRecentCommits',
      'requestBaseFile',
    ];
    dataRequests.forEach((request) => {
      vscode.postMessage({ command: request });
    });
  }

  _handleStateRestoration(state) {
    console.log('Restoring state:', state);
    const savedState = {};
    this._restoreFormFields(state, savedState);
    this._restoreFileArrays(state, savedState);
    webviewState.set(savedState);
    webviewState.restore();
    this._skipNextRestoreState = true;
  }

  _restoreFormFields(state, savedState) {
    if (state.agent) safeSetElementValue('agent', state.agent);
    if (state.model) safeSetElementValue('model', state.model);

    const instructionContent = state.instruction || '';
    const instruction =
      this._instructionEl ||
      (this._instructionEl = safeGetElementById('instruction'));
    if (instruction) {
      instruction.value = instructionContent;
      instruction.dispatchEvent(new Event('input'));
    }

    if (state.inputFile) safeSetElementValue('inputFile', state.inputFile);
    if (state.referenceFile)
      safeSetElementValue('referenceFile', state.referenceFile);
    if (state.auxiliaryFile)
      safeSetElementValue('auxiliaryFile', state.auxiliaryFile);
    if (state.mediaFile) safeSetElementValue('mediaFile', state.mediaFile);

    const toolConfig = state.toolConfig || {};
    Object.assign(savedState, {
      agent: state.agent,
      model: state.model,
      instruction: instructionContent,
      inputFile: state.inputFile,
      referenceFile: state.referenceFile,
      auxiliaryFile: state.auxiliaryFile,
      mediaFile: state.mediaFile,
      reflect: state.reflect || (toolConfig ? toolConfig.reflect : false),
      autoExtractFigure:
        state.autoExtractFigure ||
        (toolConfig ? toolConfig.autoExtractFigure : false),
      autoExtractTikzFigure:
        state.autoExtractTikzFigure ||
        (toolConfig ? toolConfig.autoExtractTikzFigure : false),
      attachTeXCount:
        state.attachTeXCount ||
        (toolConfig ? toolConfig.attachTeXCount : false),
      usePrefillFromInput:
        state.usePrefillFromInput ||
        (toolConfig ? toolConfig.usePrefillFromInput : false),
      printInputPrompt:
        state.printInputPrompt ||
        (toolConfig ? toolConfig.printInputPrompt : false),
      autoCompileInputPdf:
        state.autoCompileInputPdf ||
        (toolConfig ? toolConfig.autoCompileInputPdf : false),
    });
  }

  _restoreFileArrays(state, savedState) {
    for (const fileType of FILE_TYPES) {
      const filesArray =
        state[`${fileType}Files`] ||
        state[`multiple${capitalize(fileType)}Files`] ||
        [];
      const isVisible =
        state[`${fileType}FilesActive`] ||
        state[`multiple${capitalize(fileType)}FilesActive`] ||
        false;

      const targetArrayName = `${fileType}Files`;
      const visibilityName = `${targetArrayName}Active`;
      savedState[targetArrayName] = filesArray;
      savedState[visibilityName] = isVisible;

      const multipleFilesId = `${fileType}Files`;
      const multipleFiles = safeGetElementById(multipleFilesId);
      if (filesArray.length > 0 || isVisible) {
        const containerId = `${fileType}FilesContainer`;
        const toggleId = `toggle${capitalize(fileType)}Files`;

        const container = safeGetElementById(containerId);
        if (container) {
          container.style.display = isVisible ? 'block' : 'none';
        }

        const toggleElement = safeGetElementById(toggleId);
        this._setToggleIcon(toggleElement, isVisible);

        if (filesArray.length > 0 && multipleFiles) {
          multipleFiles.innerHTML = '';
          filesArray.forEach((file) => {
            const fileItem = document.createElement('div');
            fileItem.className = 'file-item';
            fileItem.dataset.path = file;
            fileItem.innerHTML = `${file} <span class="remove-button">-</span>`;
            multipleFiles.appendChild(fileItem);
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
      webviewState.restore();
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
    applyDebugMode(message.debugMode);
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
    const restoredBaseFileDiv = safeGetElementById('baseFile');
    if (restoredBaseFileDiv && restoredBaseFileDiv.value) {
      fileSelect.updateEdited(restoredBaseFileDiv.value);
    }
    this._postHandle();
  }

  // Instruction updates
  handleInstructionTextPolished(message) {
    const instruction = safeGetElementById('instruction');
    if (instruction && message.text) {
      instruction.value = message.text;
      vscode.postMessage({
        command: 'showInformationMessage',
        text: 'Instruction text has been polished!',
      });
      webviewState.save();
    }
    this._postHandle();
  }

  handleInstructionTextTranscribed(message) {
    const instruction = safeGetElementById('instruction');
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
        command: 'showInformationMessage',
        text: 'Instruction text transcribed!',
      });
      webviewState.save();
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
    fileSelect.update('inputFile', message.files);
    this._postHandle();
  }

  handleSetReferenceFile(message) {
    fileSelect.update('referenceFile', message.files);
    this._postHandle();
  }

  handleSetAuxiliaryFile(message) {
    fileSelect.update('auxiliaryFile', message.files);
    this._postHandle();
  }

  handleSetMediaFile(message) {
    fileSelect.update('mediaFile', message.files);
    this._postHandle();
  }

  handleSetEditedFile(message) {
    fileSelect.update('editedFile', message.files);
    this._postHandle();
  }

  handleInputFileSelected(message) {
    safeSetElementValue('inputFile', message.filePath);
    this._postHandle();
  }

  handleReferenceFileSelected(message) {
    safeSetElementValue('referenceFile', message.filePath);
    this._postHandle();
  }

  handleAuxiliaryFileSelected(message) {
    safeSetElementValue('auxiliaryFile', message.filePath);
    this._postHandle();
  }

  handleMediaFileSelected(message) {
    safeSetElementValue('mediaFile', message.filePath);
    this._postHandle();
  }

  handleEditedFileSelected(message) {
    safeSetElementValue('editedFile', message.filePath);
    this._postHandle();
  }

  handleSetDefaultOutputFiles(message) {
    fileSelect.setAgentDefaultOutputFiles(message.files || []);
    this._postHandle();
  }

  // Multi-file updates
  handleSetInputFiles(message) {
    fileList.update('inputFiles', 'toggleInputFiles', message.files);
    this._setupFileListHandler('input', safeGetElementById('inputFiles'));
    this._postHandle();
  }

  handleSetReferenceFiles(message) {
    fileList.update('referenceFiles', 'toggleReferenceFiles', message.files);
    this._setupFileListHandler(
      'reference',
      safeGetElementById('referenceFiles'),
    );
    this._postHandle();
  }

  handleSetAuxiliaryFiles(message) {
    fileList.update('auxiliaryFiles', 'toggleAuxiliaryFiles', message.files);
    this._setupFileListHandler(
      'auxiliary',
      safeGetElementById('auxiliaryFiles'),
    );
    this._postHandle();
  }

  handleSetMediaFiles(message) {
    fileList.update('mediaFiles', 'toggleMediaFiles', message.files);
    this._setupFileListHandler('media', safeGetElementById('mediaFiles'));
    this._postHandle();
  }

  handleAddMediaFile(message) {
    const listDiv = safeGetElementById('mediaFiles');
    const existingFiles = listDiv ? fileList.getSelected(listDiv) : [];
    fileList.update('mediaFiles', 'toggleMediaFiles', [
      ...existingFiles,
      message.file,
    ]);
    this._setupFileListHandler('media', listDiv);

    const container = safeGetElementById('mediaFilesContainer');
    if (container && container.style.display === 'none') {
      container.style.display = 'block';
      const toggleIcon = safeGetElementById('toggleMediaFiles');
      this._setToggleIcon(toggleIcon, true);
    }

    this._postHandle();
  }

  handleSetOutputFiles(message) {
    fileList.update('outputFiles', 'toggleOutputFiles', message.files);
    this._setupFileListHandler('output', safeGetElementById('outputFiles'));
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
        const singleFileSelect = safeGetElementById(singleFileId);
        if (singleFileSelect && singleFileSelect.value) {
          filesToAdd = filesToAdd.filter((f) => f !== singleFileSelect.value);
        }
      }

      fileList.update(multipleFileId, toggleId, filesToAdd);
    }
    this._postHandle();
  }

  handleSetBaseFile(message) {
    const currentBaseFileDiv = safeGetElementById('baseFile');
    if (currentBaseFileDiv) {
      const currentBaseFile = currentBaseFileDiv.value;
      fileSelect.update('baseFile', message.files);

      const state = webviewState.get();
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

export const messageHandlers = new MessageHandlers();
