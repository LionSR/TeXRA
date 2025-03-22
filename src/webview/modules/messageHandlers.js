import { vscode } from './vscodeApi.js';
import {
  updateFileSelect,
  updateEditedFileSelect,
  updateMultipleFileSelect,
  handleRecentCommits,
  handleSetCurrentFile,
} from './fileHandlers.js';
import {
  safeSetElementValue,
  safeSetElementChecked,
  safeGetElementById,
  safeGetElementChecked,
} from './utils.js';
import { restoreState, saveState } from './stateManager.js';
import {
  MULTIPLE_SELECTIONS,
  CHECK_BOXES_AUTO_EXTRACT,
  CHECK_BOXES_TOOL_USE,
  CHECK_BOXES,
} from './constants.js';
import { capitalize, uncapitalize } from './utils.js';

/**
 * Handle state restoration from log view
 */
function handleStateRestoration(state) {
  console.log('Restoring state:', state);

  // Restore basic form elements
  if (state.agent) safeSetElementValue('agent', state.agent);
  if (state.model) safeSetElementValue('model', state.model);

  // Fix instruction restoration - needs to use the correct ID
  if (state.instruction) {
    const instructionInput = safeGetElementById('instructionInput');
    if (instructionInput) {
      instructionInput.value = state.instruction;
      // Also trigger any associated events/validation
      instructionInput.dispatchEvent(new Event('input'));
    }
  }

  // Restore single file selections
  if (state.inputFile) safeSetElementValue('inputFile', state.inputFile);
  if (state.referenceFile)
    safeSetElementValue('referenceFile', state.referenceFile);
  if (state.auxiliaryFile)
    safeSetElementValue('auxiliaryFile', state.auxiliaryFile);
  if (state.figureFile) safeSetElementValue('figureFile', state.figureFile);
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
      toggleOutputNameOverrideDiv.textContent = '<';
  } else {
    if (outputNameOverride) outputNameOverride.style.display = 'none';
    if (toggleOutputNameOverrideDiv)
      toggleOutputNameOverrideDiv.textContent = '>';
  }

  // Prepare the state to save with all necessary properties
  const toolConfig = state.toolConfig || {};
  const savedState = {
    // Basic properties
    agent: state.agent,
    model: state.model,
    instruction: state.instruction,

    // File selections
    inputFile: state.inputFile,
    referenceFile: state.referenceFile,
    auxiliaryFile: state.auxiliaryFile,
    figureFile: state.figureFile,
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
  };

  // Multiple file selections constants
  const multipleFileTypes = [
    'input',
    'reference',
    'auxiliary',
    'figure',
    'output',
  ];

  // Process multiple file selections
  for (const fileType of multipleFileTypes) {
    // Handle both formats (inputFiles and multipleInputFiles)
    const filesArray =
      state[`${fileType}Files`] ||
      state[`multiple${capitalize(fileType)}Files`] ||
      [];
    const isVisible = state[`multiple${capitalize(fileType)}FilesVisible`];
    const toggleId = `toggleMultiple${capitalize(fileType)}Files`;
    const containerId = `multiple${capitalize(fileType)}FilesContainer`;

    // Save to the state object for later use by restoreState
    const targetArrayName = `multiple${capitalize(fileType)}Files`;
    const visibilityName = `${targetArrayName}Visible`;
    savedState[targetArrayName] = filesArray;
    savedState[visibilityName] = isVisible !== undefined ? isVisible : false;

    // Get current UI state to see if we have existing files
    const multipleFilesId = `multiple${capitalize(fileType)}Files`;
    const multipleFiles = safeGetElementById(multipleFilesId);
    const existingFiles = multipleFiles
      ? Array.from(multipleFiles.querySelectorAll('.file-item')).map(
          (item) => item.dataset.path,
        )
      : [];

    // Only clear and update if we have files to restore or visibility has changed
    if (filesArray.length > 0 || isVisible !== undefined) {
      // Show or hide the multi file container if visibility is specified
      const container = safeGetElementById(containerId);
      if (container && isVisible !== undefined) {
        container.style.display = isVisible ? 'block' : 'none';
      }

      // Update the toggle indicator based on visibility
      const toggleElement = safeGetElementById(toggleId);
      if (toggleElement && isVisible !== undefined) {
        toggleElement.textContent = isVisible ? '▲' : '▼';
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
              saveState();
            });
          }
        });
      }
    }
  }

  // Save the prepared state
  vscode.setState(savedState);

  // Use the stateManager's restoreState to update UI elements from this state
  // This will handle setting all form values and updating indicators
  restoreState();

  // Let the user know we've restored their configuration
  vscode.postMessage({
    command: 'showInformationMessage',
    text: 'Configuration restored from selected task',
  });

  // Prevent the automatic restoreState that would happen at the end of the message handler
  window._skipNextRestoreState = true;
}

export function setupMessageHandlers() {
  window.addEventListener('message', (event) => {
    const message = event.data;

    switch (message.command) {
      case 'setTheme':
        document.body.className = message.theme;
        break;
      case 'modelSelected':
        safeSetElementValue('model', message.model);
        break;
      case 'restoreState':
        handleStateRestoration(message.state);
        break;
      case 'checkRestoredBaseFile':
        const restoredBaseFileDiv = safeGetElementById('baseFile');
        if (restoredBaseFileDiv && restoredBaseFileDiv.value) {
          updateEditedFileSelect(restoredBaseFileDiv.value);
        }
        break;
      case 'instructionTextPolished':
        const instructionInput = safeGetElementById('instructionInput');
        if (instructionInput && message.text) {
          instructionInput.value = message.text;
          vscode.postMessage({
            command: 'showInformationMessage',
            text: 'Instruction text has been polished!',
          });
          saveState();
        }
        break;
      // File selection
      case 'setInputFile':
      case 'setReferenceFile':
      case 'setAuxiliaryFile':
      case 'setFigureFile':
      case 'setEditedFile':
        updateFileSelect(uncapitalize(message.command.slice(3)), message.files);
        break;
      case 'inputFileSelected':
      case 'referenceFileSelected':
      case 'auxiliaryFileSelected':
      case 'figureFileSelected':
      case 'editedFileSelected':
        safeSetElementValue(
          message.command.replace('Selected', ''),
          message.filePath,
        );
        break;
      // Multiple file selection
      case 'setMultipleInputFiles':
      case 'setMultipleReferenceFiles':
      case 'setMultipleAuxiliaryFiles':
      case 'setMultipleFigureFiles':
      case 'setMultipleOutputFiles':
        updateMultipleFileSelect(
          `${message.command.replace('setMultiple', 'multiple')}`,
          `toggle${message.command.replace('set', '')}`,
          message.files,
        );
        break;
      case 'setRecentCommits':
        handleRecentCommits(message);
        break;
      case 'setCurrentFile':
        handleSetCurrentFile({
          fileType: message.fileType,
          filePath: message.filePath,
        });
        break;
      case 'setOpenedFiles':
        // Only update the specified file type's multiple selection
        if (message.fileType) {
          const id = `multiple${capitalize(message.fileType)}Files`;
          const toggleId = `toggle${capitalize(id)}`;
          updateMultipleFileSelect(id, toggleId, message.files);
        }
        break;
      case 'setBaseFile':
        const currentBaseFileDiv = safeGetElementById('baseFile');
        if (currentBaseFileDiv) {
          const currentBaseFile = currentBaseFileDiv.value;
          updateFileSelect('baseFile', message.files);

          // Get the stored state
          const state = vscode.getState();
          const storedBaseFile = state?.baseFile;

          // First try to restore from stored state, then fallback to current if preserveBaseFile
          if (storedBaseFile && message.files.includes(storedBaseFile)) {
            currentBaseFileDiv.value = storedBaseFile;
          } else if (
            message.preserveBaseFile &&
            currentBaseFile &&
            message.files.includes(currentBaseFile)
          ) {
            currentBaseFileDiv.value = currentBaseFile;
          }

          // Always update edited files based on final base file value
          updateEditedFileSelect(currentBaseFileDiv.value);
        }
        break;
    }

    // Only restore state if we didn't just handle a state restoration
    if (window._skipNextRestoreState) {
      window._skipNextRestoreState = false;
    } else {
      restoreState();
    }
  });
}
