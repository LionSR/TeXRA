import { vscode, registerMessageHandlers } from '@common/webviewContext.js';
import { safeSetElementValue, safeGetElementById } from '@common/domUtils.js';
import { capitalize, uncapitalize } from '@common/stringUtils.js';
import { webviewState } from './webviewState.js';
import {
  CHEVRON_UP_CLASS,
  CHEVRON_DOWN_CLASS,
} from '@common/webviewContext.js';
import { setDebugMode as applyDebugMode } from './uiHandlers.js';

import { fileList } from './uiManagers/FileList.js';
import { fileSelect } from './uiManagers/FileSelect.js';

import { FILE_TYPES } from './constants.js';

/**
 * Initialize data requests on window load
 */
export function initializeDataRequests() {
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

/**
 * Handle state restoration from log view
 */
function handleStateRestoration(state) {
  console.log('Restoring state:', state);

  // Restore basic form elements
  if (state.agent) safeSetElementValue('agent', state.agent);
  if (state.model) safeSetElementValue('model', state.model);

  // Fix instruction restoration - needs to use the correct ID
  const instructionContent = state.instruction || '';
  const instruction = safeGetElementById('instruction');
  if (instruction) {
    instruction.value = instructionContent;
    // Also trigger any associated events/validation
    instruction.dispatchEvent(new Event('input'));
  }

  // Restore single file selections
  if (state.inputFile) safeSetElementValue('inputFile', state.inputFile);
  if (state.referenceFile)
    safeSetElementValue('referenceFile', state.referenceFile);
  if (state.auxiliaryFile)
    safeSetElementValue('auxiliaryFile', state.auxiliaryFile);
  if (state.mediaFile) safeSetElementValue('mediaFile', state.mediaFile);
  // Output filename override removed

  // Prepare the state to save with all necessary properties
  const toolConfig = state.toolConfig || {};
  const savedState = {
    // Basic properties
    agent: state.agent,
    model: state.model,
    instruction: instructionContent, // Use the resolved instruction content

    // File selections
    inputFile: state.inputFile,
    referenceFile: state.referenceFile,
    auxiliaryFile: state.auxiliaryFile,
    mediaFile: state.mediaFile,

    // Tool config settings - flattened from either direct or toolConfig property
    reflect: state.reflect || (toolConfig ? toolConfig.reflect : false),
    autoExtractFigure:
      state.autoExtractFigure ||
      (toolConfig ? toolConfig.autoExtractFigure : false),
    autoExtractTikzFigure:
      state.autoExtractTikzFigure ||
      (toolConfig ? toolConfig.autoExtractTikzFigure : false),
    attachTeXCount:
      state.attachTeXCount || (toolConfig ? toolConfig.attachTeXCount : false),
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

  // Process multiple file selections
  for (const fileType of FILE_TYPES) {
    // Handle both formats (inputFiles and multipleInputFiles)
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

    // Save to the state object for later use by restoreState
    const targetArrayName = `${fileType}Files`;
    const visibilityName = `${targetArrayName}Active`;
    savedState[targetArrayName] = filesArray;
    savedState[visibilityName] = isVisible;

    // Get current UI state to see if we have existing files
    const multipleFilesId = `${fileType}Files`;
    const multipleFiles = safeGetElementById(multipleFilesId);
    const existingFiles = multipleFiles
      ? Array.from(multipleFiles.querySelectorAll('.file-item')).map(
          (item) => item.dataset.path,
        )
      : [];

    // Only clear and update if we have files to restore or visibility has changed
    if (filesArray.length > 0 || isVisible) {
      // Show or hide the multi file container if visibility is specified
      const container = safeGetElementById(containerId);
      if (container) {
        container.style.display = isVisible ? 'block' : 'none';
      }

      // Update the toggle indicator based on visibility
      const toggleElement = safeGetElementById(toggleId);
      if (toggleElement) {
        toggleElement.innerHTML = `<i class="${
          isVisible ? CHEVRON_UP_CLASS : CHEVRON_DOWN_CLASS
        }"></i>`;
      }

      // Only update the file list if we have files to restore
      if (filesArray.length > 0 && multipleFiles) {
        // Clear existing content
        multipleFiles.innerHTML = '';

        // Add each file
        filesArray.forEach((file) => {
          const fileItem = document.createElement('div');
          fileItem.className = 'file-item';
          fileItem.dataset.path = file;
          fileItem.innerHTML = `${file} <span class="remove-button">-</span>`;
          multipleFiles.appendChild(fileItem);

          // Add event listeners for the remove button
          const removeButton = fileItem.querySelector('.remove-button');
          if (removeButton) {
            removeButton.addEventListener('click', (e) => {
              e.stopPropagation();
              fileItem.remove();

              // Update the state
              const updatedFiles = Array.from(
                multipleFiles.querySelectorAll('.file-item'),
              ).map((item) => item.dataset.path);

              // Send message to update the state
              vscode.postMessage({
                command: `update${capitalize(fileType)}Files`,
                files: updatedFiles,
              });

              // Save state to persist changes
              webviewState.update({
                [`${fileType}Files`]: updatedFiles,
              });
            });
          }
        });
      }
    }
  }

  // Save the prepared state
  webviewState.set(savedState);

  // Restore UI elements from the saved state
  // This will handle setting all form values and updating indicators
  webviewState.restore();

  // Let the user know we've restored their configuration
  // vscode.postMessage({
  //   command: 'showInformationMessage',
  //   text: 'Configuration restored from selected task',
  // });

  // Prevent the automatic restoreState that would happen at the end of the message handler
  window._skipNextRestoreState = true;
}

function postHandle() {
  if (window._skipNextRestoreState) {
    window._skipNextRestoreState = false;
  } else {
    webviewState.restore();
  }
}

export function setupMessageHandlers() {
  const handlers = {
    setTheme: (m) => {
      document.body.className = m.theme;
      postHandle();
    },
    setDebugMode: (m) => {
      applyDebugMode(m.debugMode);
      postHandle();
    },
    modelSelected: (m) => {
      safeSetElementValue('model', m.model);
      postHandle();
    },
    restoreState: (m) => {
      handleStateRestoration(m.state);
      postHandle();
    },
    checkRestoredBaseFile: () => {
      const restoredBaseFileDiv = safeGetElementById('baseFile');
      if (restoredBaseFileDiv && restoredBaseFileDiv.value) {
        fileSelect.updateEdited(restoredBaseFileDiv.value);
      }
      postHandle();
    },
    instructionTextPolished: (m) => {
      const instruction = safeGetElementById('instruction');
      if (instruction && m.text) {
        instruction.value = m.text;
        vscode.postMessage({
          command: 'showInformationMessage',
          text: 'Instruction text has been polished!',
        });
        webviewState.save();
      }
      postHandle();
    },
    instructionTextTranscribed: (m) => {
      const instruction = safeGetElementById('instruction');
      if (instruction && m.text) {
        // Insert text at cursor position instead of replacing all text
        const startPos = instruction.selectionStart;
        const endPos = instruction.selectionEnd;
        const textBefore = instruction.value.substring(0, startPos);
        const textAfter = instruction.value.substring(endPos);

        // Insert the transcribed text at cursor position
        instruction.value = textBefore + m.text + textAfter;

        // Set cursor position after the inserted text
        const newCursorPos = startPos + m.text.length;
        instruction.setSelectionRange(newCursorPos, newCursorPos);

        // Focus the instruction field
        instruction.focus();

        vscode.postMessage({
          command: 'showInformationMessage',
          text: 'Instruction text transcribed!',
        });
        webviewState.save();
      }
      // Reset recording UI state
      if (window.updateRecordingUI) {
        window.updateRecordingUI(false);
      }
      postHandle();
    },
    recordingStarted: () => {
      // Recording has started successfully
      if (window.updateRecordingUI) {
        window.updateRecordingUI(true);
      }
      postHandle();
    },
    recordingError: (m) => {
      // Reset UI on error
      if (window.updateRecordingUI) {
        window.updateRecordingUI(false);
      }
      postHandle();
    },
    setInputFile: (m) => {
      fileSelect.update('inputFile', m.files);
      postHandle();
    },
    setReferenceFile: (m) => {
      fileSelect.update('referenceFile', m.files);
      postHandle();
    },
    setAuxiliaryFile: (m) => {
      fileSelect.update('auxiliaryFile', m.files);
      postHandle();
    },
    setMediaFile: (m) => {
      fileSelect.update('mediaFile', m.files);
      postHandle();
    },
    setEditedFile: (m) => {
      fileSelect.update('editedFile', m.files);
      postHandle();
    },
    inputFileSelected: (m) => {
      safeSetElementValue('inputFile', m.filePath);
      postHandle();
    },
    referenceFileSelected: (m) => {
      safeSetElementValue('referenceFile', m.filePath);
      postHandle();
    },
    auxiliaryFileSelected: (m) => {
      safeSetElementValue('auxiliaryFile', m.filePath);
      postHandle();
    },
    mediaFileSelected: (m) => {
      safeSetElementValue('mediaFile', m.filePath);
      postHandle();
    },
    editedFileSelected: (m) => {
      safeSetElementValue('editedFile', m.filePath);
      postHandle();
    },
    setDefaultOutputFiles: (m) => {
      fileSelect.setAgentDefaultOutputFiles(m.files || []);
      postHandle();
    },
    setInputFiles: (m) => {
      fileList.update('inputFiles', 'toggleInputFiles', m.files);
      postHandle();
    },
    setReferenceFiles: (m) => {
      fileList.update('referenceFiles', 'toggleReferenceFiles', m.files);
      postHandle();
    },
    setAuxiliaryFiles: (m) => {
      fileList.update('auxiliaryFiles', 'toggleAuxiliaryFiles', m.files);
      postHandle();
    },
    setMediaFiles: (m) => {
      fileList.update('mediaFiles', 'toggleMediaFiles', m.files);
      postHandle();
    },
    addMediaFile: (m) => {
      const listDiv = safeGetElementById('mediaFiles');
      const existingFiles = listDiv ? fileList.getSelected(listDiv) : [];
      fileList.update('mediaFiles', 'toggleMediaFiles', [
        ...existingFiles,
        m.file,
      ]);

      // Ensure the media files container is visible
      const container = safeGetElementById('mediaFilesContainer');
      if (container && container.style.display === 'none') {
        container.style.display = 'block';
        const toggleIcon = safeGetElementById('toggleMediaFiles');
        if (toggleIcon) {
          toggleIcon.innerHTML = `<i class="${CHEVRON_UP_CLASS}"></i>`;
        }
      }

      postHandle();
    },
    setOutputFiles: (m) => {
      fileList.update('outputFiles', 'toggleOutputFiles', m.files);
      postHandle();
    },
    setRecentCommits: (m) => {
      fileSelect.handleRecentCommits(m);
      postHandle();
    },
    setCurrentFile: (m) => {
      fileSelect.handleSetCurrentFile({
        fileType: m.fileType,
        filePath: m.filePath,
      });
      postHandle();
    },
    setOpenedFiles: (m) => {
      if (m.fileType) {
        const fileType = m.fileType.replace('Files', '');
        const singleFileId = `${uncapitalize(fileType)}File`;
        const multipleFileId = `${uncapitalize(fileType)}Files`;
        const toggleId = `toggle${capitalize(fileType)}Files`;

        let filesToAdd = m.files ?? [];
        if (m.shouldFilter) {
          const singleFileSelect = safeGetElementById(singleFileId);
          if (singleFileSelect && singleFileSelect.value) {
            filesToAdd = filesToAdd.filter((f) => f !== singleFileSelect.value);
          }
        }

        fileList.update(multipleFileId, toggleId, filesToAdd);
      }
      postHandle();
    },
    setBaseFile: (m) => {
      const currentBaseFileDiv = safeGetElementById('baseFile');
      if (currentBaseFileDiv) {
        const currentBaseFile = currentBaseFileDiv.value;
        fileSelect.update('baseFile', m.files);

        const state = webviewState.get();
        const storedBaseFile = state?.baseFile;

        if (storedBaseFile && m.files.includes(storedBaseFile)) {
          currentBaseFileDiv.value = storedBaseFile;
        } else if (
          m.preserveBaseFile &&
          currentBaseFile &&
          m.files.includes(currentBaseFile)
        ) {
          currentBaseFileDiv.value = currentBaseFile;
        }

        fileSelect.updateEdited(currentBaseFileDiv.value);
      }
      postHandle();
    },
  };

  registerMessageHandlers(handlers);
}
