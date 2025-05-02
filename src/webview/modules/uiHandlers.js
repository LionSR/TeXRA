import { vscode } from './vscodeApi.js';
import { saveState } from './stateManager.js';
import {
  MULTIPLE_SELECTIONS,
  CHECK_BOXES,
  ELEMENTS_TO_SAVE,
  CHECK_BOXES_AUTO_EXTRACT,
  FILE_TYPES,
} from './constants.js';
import {
  updateEditedFileSelect,
  getSelectedFiles,
  handleCheckboxChange,
  toggleMultipleFiles,
  toggleOutputFiles,
  toggleOutputNameOverride,
  emptyMultipleFiles,
} from './fileHandlers.js';
import {
  safeGetElementById,
  addEventListenerSafely,
  safeGetElementValue,
  safeGetElementChecked,
  capitalize,
} from './utils.js';

// Add this function to handle textarea auto-resize
export function autoResizeTextarea(textarea) {
  // Reset height to auto to get the correct scrollHeight
  textarea.style.height = 'auto';
  const maxHeight = 400;

  // Calculate the new height
  const newHeight = Math.min(textarea.scrollHeight, maxHeight);

  // Set new height
  textarea.style.height = newHeight + 'px';

  // Show/hide scrollbar based on content height
  textarea.style.overflowY =
    textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

export function setupUIHandlers() {
  // Make all multiple file selections sortable
  MULTIPLE_SELECTIONS.forEach((id) => {
    const element = safeGetElementById(id);
    if (element) {
      new Sortable(element, {
        animation: 150,
        onEnd: saveState,
      });
    }
  });

  // Helper functions for common tasks
  function getOutputNameOverride() {
    const outputNameOverrideDiv = safeGetElementById('outputNameOverride');
    return outputNameOverrideDiv &&
      outputNameOverrideDiv.style.display !== 'none'
      ? outputNameOverrideDiv.value.trim()
      : null;
  }

  // Get values for single file inputs (input, reference, auxiliary, media)
  function getSingleFileData(
    fileTypes = ['input', 'reference', 'auxiliary', 'media'],
  ) {
    const data = {};
    fileTypes.forEach((type) => {
      data[`${type}File`] = safeGetElementValue(`${type}File`);
    });
    return data;
  }

  // Get multiple file data with filtering of single files
  function getMultipleFileData(singleFiles = {}) {
    const multipleFilesData = {};

    MULTIPLE_SELECTIONS.forEach((id) => {
      // Check if container is visible
      const container = safeGetElementById(`${id}Container`);
      const isActive = container?.style.display === 'block';
      multipleFilesData[`${id}Active`] = isActive;

      // Get the matching single file (if it exists)
      const singleFileKey = id.replace('Files', 'File');
      const singleFile = singleFiles[singleFileKey];

      // Get all files if container is visible
      const filesDiv = safeGetElementById(id);
      const files = isActive && filesDiv ? getSelectedFiles(filesDiv) : [];

      // Filter out single file if it exists (except for outputFiles)
      multipleFilesData[id] =
        id !== 'outputFiles' && singleFile
          ? files.filter((file) => file !== singleFile)
          : files;
    });

    return multipleFilesData;
  }

  // Add auto-extract toggle handler
  function updateAutoToggleState() {
    const autoExtractToggle = safeGetElementById('toggleAutoExtract');
    const autoExtractOptions = safeGetElementById('autoExtractOptions');
    const isVisible = autoExtractOptions.style.display === 'block';

    // Check if any auto-extract checkbox is checked
    const hasAutoExtractChecked = CHECK_BOXES_AUTO_EXTRACT.some((id) =>
      safeGetElementChecked(id),
    );

    const indicator = hasAutoExtractChecked ? '●' : '○';
    const direction = isVisible ? 'up' : 'down';

    autoExtractToggle.innerHTML = `<i class="codicon codicon-wand"></i> ${indicator}<i class="codicon codicon-chevron-${direction}"></i>`;
  }

  addEventListenerSafely('toggleAutoExtract', 'click', function () {
    const autoExtractOptions = safeGetElementById('autoExtractOptions');
    const isVisible = autoExtractOptions.style.display === 'block';

    autoExtractOptions.style.display = isVisible ? 'none' : 'block';
    updateAutoToggleState();
  });

  // Add checkbox change listeners for auto-extract options
  CHECK_BOXES_AUTO_EXTRACT.forEach((id) => {
    addEventListenerSafely(id, 'change', function () {
      updateAutoToggleState();
      handleCheckboxChange.call(this);
    });
  });

  // Add event listeners for the empty buttons
  const fileTypesWithEmptyButtons = [
    'input',
    'reference',
    'auxiliary',
    'media',
    'base',
    'edited',
  ];
  fileTypesWithEmptyButtons.forEach((type) => {
    const capitalizedType = capitalize(type);
    addEventListenerSafely(`empty${capitalizedType}FileButton`, 'click', () => {
      const selectElement = safeGetElementById(`${type}File`);
      if (selectElement) {
        selectElement.value = '';
        saveState();
      }
    });
  });

  addEventListenerSafely('agent', 'change', function () {
    const selectedAgent = this.value;
    // Set reflect checkbox based on agent type
    const reflectCheckbox = safeGetElementById('reflect');
    if (reflectCheckbox) {
      reflectCheckbox.checked = !selectedAgent.startsWith('correct');
    }

    vscode.postMessage({ command: 'requestMediaFile' });

    saveState();
  });

  addEventListenerSafely('model', 'change', function () {
    vscode.postMessage({
      command: 'modelSelected',
      model: this.value,
    });
  });

  addEventListenerSafely('inputFile', 'change', function () {
    const inputFile = this.value;
    const outputNameOverride =
      safeGetElementById('outputNameOverride')?.value.trim() || null;
    vscode.postMessage({
      command: 'inputFileSelected',
      filePath: inputFile,
      outputNameOverride: outputNameOverride,
    });
  });

  addEventListenerSafely('referenceFile', 'change', function () {
    const referenceFile = this.value;
    vscode.postMessage({
      command: 'referenceFileSelected',
      filePath: referenceFile,
    });
  });

  // Handle multiple file selection buttons
  const multipleFileSelectors = FILE_TYPES.map((type) => ({
    id: `${capitalize(type)}Files`,
    selectId: type === 'output' ? 'inputFile' : `${type}File`, // OutputFiles uses inputFile as reference
  }));

  multipleFileSelectors.forEach(({ id, selectId }) => {
    const selectMultipleFilesButtonId = `select${id}Button`;
    addEventListenerSafely(selectMultipleFilesButtonId, 'click', function () {
      const currentFile = safeGetElementValue(selectId);
      vscode.postMessage({
        command: 'selectMultipleFiles',
        fileType: id,
        currentFile: currentFile,
      });
    });
  });

  // Handle empty buttons and toggles for all multiple selections
  MULTIPLE_SELECTIONS.forEach((id) => {
    const toggleId = `toggle${capitalize(id)}`;
    const emptyButtonId = `empty${capitalize(id)}Button`;

    // Empty button handler
    addEventListenerSafely(emptyButtonId, 'click', () =>
      emptyMultipleFiles(id, toggleId),
    );
  });

  CHECK_BOXES.forEach((id) => {
    addEventListenerSafely(id, 'change', handleCheckboxChange);
  });

  // Add click handlers for file type icons and commit icon
  const fileTypeIcons = document.querySelectorAll(
    '.file-select-header label .codicon.clickable',
  );
  fileTypeIcons.forEach((icon) => {
    // Only handle commit icon clicks since file refreshes are handled by the file watcher
    if (icon.classList.contains('codicon-git-commit')) {
      icon.addEventListener('click', () => {
        vscode.postMessage({ command: 'refreshCommits' });
      });
    }
  });

  addEventListenerSafely('eraseInstructionButton', 'click', function () {
    const instruction = safeGetElementById('instruction');
    if (instruction) {
      instruction.value = '';
      autoResizeTextarea(instruction);
      saveState();
    }
  });

  addEventListenerSafely('magicPolishButton', 'click', function () {
    const instruction = safeGetElementById('instruction');
    if (instruction && instruction.value.trim()) {
      // Get agent and model information
      const agent = safeGetElementValue('agent');
      const model = safeGetElementValue('model');

      // Get single files and multiple files data
      const singleFiles = getSingleFileData();
      const multipleFilesData = getMultipleFileData(singleFiles);

      vscode.postMessage({
        command: 'polishInstructionText',
        text: instruction.value,
        // Context information
        agent,
        model,
        // Single files
        ...singleFiles,
        // Toggle status and multiple files
        ...multipleFilesData,
        // Output override
        outputNameOverride: getOutputNameOverride(),
      });
    }
  });

  addEventListenerSafely('executeButton', 'click', function () {
    const agent = safeGetElementValue('agent');
    const model = safeGetElementValue('model');
    const instruction = safeGetElementValue('instruction');

    // Get single files and multiple files data
    const singleFiles = getSingleFileData();
    const multipleFilesData = getMultipleFileData(singleFiles);

    // Get checkbox values using loops
    const checkboxValues = {};
    CHECK_BOXES.forEach((id) => {
      checkboxValues[id] = safeGetElementChecked(id);
    });

    vscode.postMessage({
      command: 'execute',
      // parameters
      agent,
      model,
      // instruction
      instruction,
      // single files
      ...singleFiles,
      // multiple files
      ...multipleFilesData,
      // checkboxes (auto extract options and tool config)
      ...checkboxValues,
      // output override
      outputNameOverride: getOutputNameOverride(),
    });
  });

  addEventListenerSafely('mergeButton', 'click', function () {
    const { inputFile } = getSingleFileData(['input']);
    const editedFile = safeGetElementValue('editedFile');

    vscode.postMessage({
      command: 'merge',
      inputFile,
      editedFile,
    });

    vscode.postMessage({
      command: 'showInformationMessage',
      text: `Merging files: ${inputFile} and ${editedFile}`,
    });
  });

  ['pack', 'clean'].forEach((action) => {
    addEventListenerSafely(`${action}Button`, 'click', function () {
      // Get basic data
      const { inputFile } = getSingleFileData(['input']);
      const agent = safeGetElementValue('agent');
      const model = safeGetElementValue('model');

      // Get output files
      const outputFiles = getSelectedFiles(safeGetElementById('outputFiles'));

      // Check if we should use multiple or single mode
      const outputFilesContainer = safeGetElementById('outputFilesContainer');
      const useMultiple =
        outputFilesContainer &&
        outputFilesContainer.style.display === 'block' &&
        outputFiles.length > 0;

      if (useMultiple) {
        vscode.postMessage({
          command: `${action}Multiple`,
          inputFile,
          agent,
          model,
          outputNameOverride: getOutputNameOverride(),
          outputFiles,
        });

        vscode.postMessage({
          command: 'showInformationMessage',
          text: `${capitalize(action)}ing multiple files: ${[inputFile, ...outputFiles].join(', ')}`,
        });
      } else {
        if (!inputFile || !agent || !model) {
          vscode.postMessage({
            command: 'showInformationMessage',
            text: 'Please select all required fields (input file, agent, and model)',
          });
          return;
        }

        vscode.postMessage({
          command: `${action}Single`,
          inputFile,
          agent,
          model,
          outputNameOverride: getOutputNameOverride(),
        });

        vscode.postMessage({
          command: 'showInformationMessage',
          text: `${capitalize(action)}ing single file: ${inputFile}`,
        });
      }
    });
  });

  // LaTeX diff operations
  addEventListenerSafely('latexdiffButton', 'click', function () {
    const { inputFile } = getSingleFileData(['input']);
    const baseFile = safeGetElementValue('baseFile');
    const editedFile = safeGetElementValue('editedFile');

    vscode.postMessage({
      command: 'latexdiff',
      inputFile,
      baseFile,
      editedFile,
    });

    vscode.postMessage({
      command: 'showInformationMessage',
      text: `Running LaTeX diff between ${baseFile} and ${editedFile}`,
    });
  });

  addEventListenerSafely('latexdiffvcButton', 'click', function () {
    const { inputFile } = getSingleFileData(['input']);
    const baseFile = safeGetElementValue('baseFile');
    const commitHash = safeGetElementValue('commit');

    vscode.postMessage({
      command: 'latexdiffvc',
      inputFile,
      baseFile,
      commitHash,
    });

    vscode.postMessage({
      command: 'showInformationMessage',
      text: `Running LaTeX diff with version control: ${baseFile} at commit ${commitHash}`,
    });
  });

  // Pack/clean LaTeX diff operations
  ['pack', 'clean'].forEach((action) => {
    addEventListenerSafely(`${action}LatexdiffvcButton`, 'click', function () {
      const { inputFile } = getSingleFileData(['input']);
      const baseFile = safeGetElementValue('baseFile');
      const commitHash = safeGetElementValue('commit');

      vscode.postMessage({
        command: `${action}Latexdiffvc`,
        inputFile,
        baseFile,
        commitHash,
        clean: action === 'clean',
      });

      vscode.postMessage({
        command: 'showInformationMessage',
        text: `${capitalize(action)}ing LaTeX diff with version control: ${baseFile} at commit ${commitHash}`,
      });
    });
  });

  ['base', 'edited'].forEach((type) => {
    addEventListenerSafely(
      `current${capitalize(type)}FileButton`,
      'click',
      function () {
        const baseFile = safeGetElementValue('baseFile');
        vscode.postMessage({
          command: 'getCurrentFile',
          fileType: type,
          baseFile: baseFile,
        });
      },
    );
  });

  ELEMENTS_TO_SAVE.forEach((id) => {
    if (id !== 'instruction') {
      addEventListenerSafely(id, 'change', saveState);
    }
  });

  // Special case for instruction as it uses 'input' event
  addEventListenerSafely('instruction', 'input', saveState);
  addEventListenerSafely('outputNameOverride', 'input', saveState);

  new Sortable(safeGetElementById('outputFiles'), {
    animation: 150,
    onEnd: saveState,
  });

  // Output Filename toggle only works when inside Multiple Outputs container
  addEventListenerSafely('toggleOutputNameOverride', 'click', function () {
    const outputFilesContainer = safeGetElementById('outputFilesContainer');
    if (
      outputFilesContainer &&
      outputFilesContainer.style.display === 'block'
    ) {
      toggleOutputNameOverride();
    }
  });

  // Add event listeners for file operations (add opened files, get current file)
  const fileTypesWithOperations = ['input', 'reference', 'auxiliary'];
  fileTypesWithOperations.forEach((type) => {
    const capitalizedType = capitalize(type);

    // Add opened files button
    const addOpenedButtonId = `addOpened${capitalizedType}FilesButton`;
    addEventListenerSafely(addOpenedButtonId, 'click', () => {
      vscode.postMessage({
        command: 'addOpenedFiles',
        fileType: type,
      });
    });

    // Current file button
    const currentFileButtonId = `current${capitalizedType}FileButton`;
    addEventListenerSafely(currentFileButtonId, 'click', () => {
      vscode.postMessage({
        command: 'getCurrentFile',
        fileType: type,
      });
    });
  });

  // Add event listener for base file select
  addEventListenerSafely('baseFile', 'change', function () {
    const baseFile = safeGetElementValue('baseFile');
    vscode.postMessage({
      command: 'requestEditedFile',
      baseFile: baseFile,
    });
    updateEditedFileSelect(baseFile);
  });

  MULTIPLE_SELECTIONS.forEach((id) => {
    const toggleId = `toggle${capitalize(id)}`;
    addEventListenerSafely(toggleId, 'click', () => {
      if (id === 'outputFiles') {
        toggleOutputFiles();
      } else {
        toggleMultipleFiles(id, toggleId);
      }
    });
  });

  // Add event listener for history button
  addEventListenerSafely('historyButton', 'click', function () {
    vscode.postMessage({
      command: 'showAgentHistory',
    });
  });
}
