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
} from './utils.js';
import { restoreState, saveState } from './stateManager.js';
import { MULTIPLE_SELECTIONS } from './constants.js';
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

  // Handle multiple file selections
  const multipleFileTypes = [
    'input',
    'reference',
    'auxiliary',
    'figure',
    'output',
  ];

  for (const fileType of multipleFileTypes) {
    // Handle both formats (inputFiles and multipleInputFiles)
    const filesArray =
      state[`${fileType}Files`] ||
      state[`multiple${capitalize(fileType)}Files`] ||
      [];
    const isVisible = state[`multiple${capitalize(fileType)}FilesVisible`];
    const toggleId = `toggleMultiple${capitalize(fileType)}Files`;
    const containerId = `multiple${capitalize(fileType)}FilesContainer`;

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
            });
          }
        });
      }
    }
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

    // Save the state to preserve across page refreshes
    // Here we normalize the naming to match what the system expects
    const savedState = {
      ...vscode.getState(),
      agent: state.agent,
      model: state.model,
      instruction: state.instruction,
      inputFile: state.inputFile,
      referenceFile: state.referenceFile,
      auxiliaryFile: state.auxiliaryFile,
      figureFile: state.figureFile,
      outputNameOverride: state.outputNameOverride,
      outputNameOverrideVisible: state.outputNameOverrideVisible,
      reflect:
        state.reflect || (state.toolConfig ? state.toolConfig.reflect : false),
      autoExtractFigure:
        state.autoExtractFigure ||
        (state.toolConfig ? state.toolConfig.autoExtractFigure : false),
      autoExtractTikzFigure:
        state.autoExtractTikzFigure ||
        (state.toolConfig ? state.toolConfig.autoExtractTikzFigure : false),
      attachTeXCount:
        state.attachTeXCount ||
        (state.toolConfig ? state.toolConfig.attachTeXCount : false),
      usePrefillFromInput:
        state.usePrefillFromInput ||
        (state.toolConfig ? state.toolConfig.usePrefillFromInput : false),
      printInputPrompt:
        state.printInputPrompt ||
        (state.toolConfig ? state.toolConfig.printInputPrompt : false),
    };

    // Normalize file array names (support both formats)
    for (const fileType of multipleFileTypes) {
      const sourceArrayName = `${fileType}Files`;
      const targetArrayName = `multiple${capitalize(fileType)}Files`;
      const visibilityName = `${targetArrayName}Visible`;

      savedState[targetArrayName] =
        state[sourceArrayName] || state[targetArrayName] || [];
      if (state[visibilityName] !== undefined) {
        savedState[visibilityName] = state[visibilityName];
      }
    }

    // Store the normalized state
    vscode.setState(savedState);

    // Prevent the automatic restoreState at the end of the message handler from overriding our changes
    window._skipNextRestoreState = true;

    // Show a toast notification
    vscode.postMessage({
      command: 'showInformationMessage',
      text: 'Configuration restored from selected task',
    });
  }

  // checkboxes are not being restored for now

  saveState();
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
