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
    this._handlers = {
      // Theme & debug
      setTheme: (m) => this.handleSetTheme(m),
      setDebugMode: (m) => this.handleSetDebugMode(m),
      modelSelected: (m) => this.handleModelSelected(m),

      // State restoration
      restoreState: (m) => this.handleRestoreState(m),
      checkRestoredBaseFile: () => this.handleCheckRestoredBaseFile(),

      // Instruction updates
      instructionTextPolished: (m) => this.handleInstructionTextPolished(m),
      instructionTextTranscribed: (m) =>
        this.handleInstructionTextTranscribed(m),

      // Recording
      recordingStarted: () => this.handleRecordingStarted(),
      recordingError: () => this.handleRecordingError(),

      // Single file updates
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

      // Multi-file updates
      setInputFiles: (m) => this.handleSetInputFiles(m),
      setReferenceFiles: (m) => this.handleSetReferenceFiles(m),
      setAuxiliaryFiles: (m) => this.handleSetAuxiliaryFiles(m),
      setMediaFiles: (m) => this.handleSetMediaFiles(m),
      addMediaFile: (m) => this.handleAddMediaFile(m),
      setOutputFiles: (m) => this.handleSetOutputFiles(m),

      // Misc updates
      setRecentCommits: (m) => this.handleSetRecentCommits(m),
      setCurrentFile: (m) => this.handleSetCurrentFile(m),
      setOpenedFiles: (m) => this.handleSetOpenedFiles(m),
      setBaseFile: (m) => this.handleSetBaseFile(m),
    };
  }

  /** Register handlers and request initial data. */
  setup() {
    registerMessageHandlers(this._handlers);
    this._initializeDataRequests();
  }

  /* ---------- Private helpers ---------- */
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

    if (state.agent) safeSetElementValue('agent', state.agent);
    if (state.model) safeSetElementValue('model', state.model);

    const instructionContent = state.instruction || '';
    const instruction = safeGetElementById('instruction');
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
    const savedState = {
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
    };

    for (const fileType of FILE_TYPES) {
      const filesArray =
        state[`${fileType}Files`] ||
        state[`multiple${capitalize(fileType)}Files`] ||
        [];
      const isVisible =
        state[`${fileType}FilesActive`] ||
        state[`multiple${capitalize(fileType)}FilesActive`] ||
        false;
      const toggleId = `toggle${capitalize(fileType)}Files`;
      const containerId = `${fileType}FilesContainer`;

      const targetArrayName = `${fileType}Files`;
      const visibilityName = `${targetArrayName}Active`;
      savedState[targetArrayName] = filesArray;
      savedState[visibilityName] = isVisible;

      const multipleFilesId = `${fileType}Files`;
      const multipleFiles = safeGetElementById(multipleFilesId);
      const existingFiles = multipleFiles
        ? Array.from(multipleFiles.querySelectorAll('.file-item')).map(
            (item) => item.dataset.path,
          )
        : [];

      if (filesArray.length > 0 || isVisible) {
        const container = safeGetElementById(containerId);
        if (container) {
          container.style.display = isVisible ? 'block' : 'none';
        }

        const toggleElement = safeGetElementById(toggleId);
        if (toggleElement) {
          toggleElement.innerHTML = `<i class="${
            isVisible ? CHEVRON_UP_CLASS : CHEVRON_DOWN_CLASS
          }"></i>`;
        }

        if (filesArray.length > 0 && multipleFiles) {
          multipleFiles.innerHTML = '';
          filesArray.forEach((file) => {
            const fileItem = document.createElement('div');
            fileItem.className = 'file-item';
            fileItem.dataset.path = file;
            fileItem.innerHTML = `${file} <span class="remove-button">-</span>`;
            multipleFiles.appendChild(fileItem);

            const removeButton = fileItem.querySelector('.remove-button');
            if (removeButton) {
              removeButton.addEventListener('click', (e) => {
                e.stopPropagation();
                fileItem.remove();
                const updatedFiles = Array.from(
                  multipleFiles.querySelectorAll('.file-item'),
                ).map((item) => item.dataset.path);
                vscode.postMessage({
                  command: `update${capitalize(fileType)}Files`,
                  files: updatedFiles,
                });
                webviewState.update({
                  [`${fileType}Files`]: updatedFiles,
                });
              });
            }
          });
        }
      }
    }

    webviewState.set(savedState);
    webviewState.restore();
    this._skipNextRestoreState = true;
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
    this._postHandle();
  }

  handleSetReferenceFiles(message) {
    fileList.update('referenceFiles', 'toggleReferenceFiles', message.files);
    this._postHandle();
  }

  handleSetAuxiliaryFiles(message) {
    fileList.update('auxiliaryFiles', 'toggleAuxiliaryFiles', message.files);
    this._postHandle();
  }

  handleSetMediaFiles(message) {
    fileList.update('mediaFiles', 'toggleMediaFiles', message.files);
    this._postHandle();
  }

  handleAddMediaFile(message) {
    const listDiv = safeGetElementById('mediaFiles');
    const existingFiles = listDiv ? fileList.getSelected(listDiv) : [];
    fileList.update('mediaFiles', 'toggleMediaFiles', [
      ...existingFiles,
      message.file,
    ]);

    const container = safeGetElementById('mediaFilesContainer');
    if (container && container.style.display === 'none') {
      container.style.display = 'block';
      const toggleIcon = safeGetElementById('toggleMediaFiles');
      if (toggleIcon) {
        toggleIcon.innerHTML = `<i class="${CHEVRON_UP_CLASS}"></i>`;
      }
    }

    this._postHandle();
  }

  handleSetOutputFiles(message) {
    fileList.update('outputFiles', 'toggleOutputFiles', message.files);
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
