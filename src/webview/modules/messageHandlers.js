import { vscode } from '@common/vscodeApi.js';
import { registerMessageHandlers } from '@common/messageRouter.js';
import { safeSetElementValue, safeGetElementById } from '@common/domUtils.js';
import { capitalize, uncapitalize } from '@common/stringUtils.js';
import {
  getWebviewState,
  updateWebviewState,
  setWebviewState,
} from '@common/webviewState.js';

import {
  updateFileSelect,
  updateEditedFileSelect,
  updateMultipleFileSelect,
  handleRecentCommits,
  handleSetCurrentFile,
} from './fileHandlers.js';

import { restoreState, saveState } from './stateManager.js';
import { FILE_TYPES } from './constants.js';

/**
 * Initialize data requests on window load
 */
export function initializeDataRequests() {
  const dataRequests = [
    'getTheme',
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
  if (state.outputNameOverride)
    safeSetElementValue('outputNameOverride', state.outputNameOverride);

  // Handle output name override visibility
  const outputNameOverride = safeGetElementById('outputNameOverride');
  const toggleOutputNameOverrideDiv = safeGetElementById(
    'toggleOutputNameOverride',
  );
  if (state.outputNameOverrideVisible) {
    if (outputNameOverride) outputNameOverride.style.display = 'inline-block';
    if (toggleOutputNameOverrideDiv)
      toggleOutputNameOverrideDiv.innerHTML =
        '<i class="codicon codicon-chevron-left"></i>';
  } else {
    if (outputNameOverride) outputNameOverride.style.display = 'none';
    if (toggleOutputNameOverrideDiv)
      toggleOutputNameOverrideDiv.innerHTML =
        '<i class="codicon codicon-chevron-right"></i>';
  }

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
    outputNameOverride: state.outputNameOverride,
    outputNameOverrideVisible: state.outputNameOverrideVisible,

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
        toggleElement.innerHTML = isVisible
          ? '<i class="codicon codicon-chevron-up"></i>'
          : '<i class="codicon codicon-chevron-down"></i>';
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
              updateWebviewState({
                [`${fileType}Files`]: updatedFiles,
              });
            });
          }
        });
      }
    }
  }

  // Save the prepared state
  setWebviewState(savedState);

  // Use the stateManager's restoreState to update UI elements from this state
  // This will handle setting all form values and updating indicators
  restoreState();

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
    restoreState();
  }
}

export function setupMessageHandlers() {
  const handlers = {
    setTheme: (m) => {
      document.body.className = m.theme;
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
        updateEditedFileSelect(restoredBaseFileDiv.value);
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
        saveState();
      }
      postHandle();
    },
    setInputFile: (m) => {
      updateFileSelect('inputFile', m.files);
      postHandle();
    },
    setReferenceFile: (m) => {
      updateFileSelect('referenceFile', m.files);
      postHandle();
    },
    setAuxiliaryFile: (m) => {
      updateFileSelect('auxiliaryFile', m.files);
      postHandle();
    },
    setMediaFile: (m) => {
      updateFileSelect('mediaFile', m.files);
      postHandle();
    },
    setEditedFile: (m) => {
      updateFileSelect('editedFile', m.files);
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
    setInputFiles: (m) => {
      updateMultipleFileSelect('inputFiles', 'toggleInputFiles', m.files);
      postHandle();
    },
    setReferenceFiles: (m) => {
      updateMultipleFileSelect(
        'referenceFiles',
        'toggleReferenceFiles',
        m.files,
      );
      postHandle();
    },
    setAuxiliaryFiles: (m) => {
      updateMultipleFileSelect(
        'auxiliaryFiles',
        'toggleAuxiliaryFiles',
        m.files,
      );
      postHandle();
    },
    setMediaFiles: (m) => {
      updateMultipleFileSelect('mediaFiles', 'toggleMediaFiles', m.files);
      postHandle();
    },
    setOutputFiles: (m) => {
      updateMultipleFileSelect('outputFiles', 'toggleOutputFiles', m.files);
      postHandle();
    },
    setRecentCommits: (m) => {
      handleRecentCommits(m);
      postHandle();
    },
    setCurrentFile: (m) => {
      handleSetCurrentFile({ fileType: m.fileType, filePath: m.filePath });
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

        updateMultipleFileSelect(multipleFileId, toggleId, filesToAdd);
      }
      postHandle();
    },
    setBaseFile: (m) => {
      const currentBaseFileDiv = safeGetElementById('baseFile');
      if (currentBaseFileDiv) {
        const currentBaseFile = currentBaseFileDiv.value;
        updateFileSelect('baseFile', m.files);

        const state = getWebviewState();
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

        updateEditedFileSelect(currentBaseFileDiv.value);
      }
      postHandle();
    },
  };

  registerMessageHandlers(handlers);
}
