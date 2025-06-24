import { vscode } from '@common/webviewContext.js';
import { webviewState } from './webviewState.js';
import {
  MULTIPLE_SELECTIONS,
  CHECK_BOXES,
  ELEMENTS_TO_SAVE,
  CHECK_BOXES_AUTO_EXTRACT,
  CHECK_BOXES_TOOL_USE,
  FILE_TYPES,
} from './constants.js';
import {
  handleCheckboxChange,
  toggleOutputFiles,
  toggleLatexdiffs,
} from './fileHandlers.js';
import { fileList } from './uiManagers/FileList.js';
import { fileSelect } from './uiManagers/FileSelect.js';
import {
  safeGetElementById,
  addEventListenerSafely,
  safeGetElementValue,
  safeGetElementChecked,
} from '@common/domUtils.js';
import { capitalize } from '@common/stringUtils.js';
import { InstructionManager } from './uiManagers/InstructionManager.js';
import { ToggleManager } from './uiManagers/ToggleManager.js';
import { RecordingManager } from './uiManagers/RecordingManager.js';
import { webviewEventBus } from './eventBus.js';

export const instructionManager = new InstructionManager(
  'instruction',
  vscode,
  webviewState,
);
export const toggleManager = new ToggleManager();
export const recordingManager = new RecordingManager(vscode, webviewEventBus);

let debugMode = false;

function updateDebugButtonVisibility() {
  const packBtn = safeGetElementById('packButton');
  const cleanBtn = safeGetElementById('cleanButton');
  [packBtn, cleanBtn].forEach((btn) => {
    if (btn) {
      btn.style.display = debugMode ? '' : 'none';
    }
  });
}

export function setDebugMode(enabled) {
  debugMode = !!enabled;
  updateDebugButtonVisibility();
}

export function setupUIHandlers() {
  // Make all multiple file selections sortable
  MULTIPLE_SELECTIONS.forEach((id) => {
    const element = safeGetElementById(id);
    if (element) {
      new Sortable(element, {
        animation: 150,
        onEnd: () => webviewState.save(),
      });
    }
  });

  updateDebugButtonVisibility();

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
      const files = isActive && filesDiv ? fileList.getSelected(filesDiv) : [];

      // Filter out single file if it exists (except for outputFiles)
      multipleFilesData[id] =
        id !== 'outputFiles' && singleFile
          ? files.filter((file) => file !== singleFile)
          : files;
    });

    return multipleFilesData;
  }

  addEventListenerSafely('toggleAutoExtract', 'click', function (e) {
    e.stopPropagation();
    const autoExtractOptions = safeGetElementById('autoExtractOptions');
    const isVisible = autoExtractOptions.style.display === 'block';

    autoExtractOptions.style.display = isVisible ? 'none' : 'block';
    toggleManager.updateAutoToggleState();
  });

  addEventListenerSafely('toggleToolConfig', 'click', function (e) {
    e.stopPropagation();
    const toolConfigOptions = safeGetElementById('toolConfigOptions');
    const isVisible = toolConfigOptions.style.display === 'block';

    toolConfigOptions.style.display = isVisible ? 'none' : 'block';
    toggleManager.updateToolConfigToggleState();
  });

  // Add checkbox change listeners for auto-extract options
  CHECK_BOXES_AUTO_EXTRACT.forEach((id) => {
    addEventListenerSafely(id, 'change', function () {
      toggleManager.updateAutoToggleState();
      handleCheckboxChange.call(this);
    });
  });

  CHECK_BOXES_TOOL_USE.forEach((id) => {
    addEventListenerSafely(id, 'change', function () {
      toggleManager.updateToolConfigToggleState();
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
        webviewState.save();
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

    vscode.postMessage({
      command: 'requestDefaultOutputFiles',
      agent: selectedAgent,
    });

    webviewState.save();
  });

  addEventListenerSafely('model', 'change', function () {
    vscode.postMessage({
      command: 'modelSelected',
      model: this.value,
    });
  });

  addEventListenerSafely('inputFile', 'change', function () {
    const inputFile = this.value;
    vscode.postMessage({
      command: 'inputFileSelected',
      filePath: inputFile,
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
      fileList.empty(id, toggleId),
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
      instructionManager.autoResizeTextarea(instruction);
      webviewState.save();
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
      });
    }
  });

  recordingManager.setupRecordButton();

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
      const outputFiles = fileList.getSelected(
        safeGetElementById('outputFiles'),
      );

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
      addEventListenerSafely(id, 'change', () => webviewState.save());
    }
  });

  // Special case for instruction as it uses 'input' event
  addEventListenerSafely('instruction', 'input', () => webviewState.save());

  new Sortable(safeGetElementById('outputFiles'), {
    animation: 150,
    onEnd: () => webviewState.save(),
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
    fileSelect.updateEdited(baseFile);
  });

  MULTIPLE_SELECTIONS.forEach((id) => {
    const toggleId = `toggle${capitalize(id)}`;
    addEventListenerSafely(toggleId, 'click', () => {
      if (id === 'outputFiles') {
        toggleOutputFiles();
      } else {
        fileList.toggle(id, toggleId);
      }
    });
  });

  addEventListenerSafely('toggleLatexdiffs', 'click', () => {
    toggleLatexdiffs();
  });

  // Open agent and model settings directly from footer icons
  addEventListenerSafely('agentSettingsButton', 'click', function () {
    vscode.postMessage({
      command: 'openAgentSettings',
    });
  });

  addEventListenerSafely('modelSettingsButton', 'click', function () {
    vscode.postMessage({
      command: 'openModelSettings',
    });
  });

  // Compare and Accept button handlers
  addEventListenerSafely('compareButton', 'click', function () {
    const baseFile = safeGetElementValue('baseFile');
    const editedFile = safeGetElementValue('editedFile');

    if (baseFile && editedFile) {
      vscode.postMessage({
        command: 'compare',
        baseFile: baseFile,
        editedFile: editedFile,
      });
    } else {
      vscode.postMessage({
        command: 'showInformationMessage',
        text: 'Please select both base and edited files to compare',
      });
    }
  });

  addEventListenerSafely('acceptButton', 'click', function () {
    const baseFile = safeGetElementValue('baseFile');
    const editedFile = safeGetElementValue('editedFile');

    if (baseFile && editedFile) {
      vscode.postMessage({
        command: 'acceptEdited',
        baseFile: baseFile,
        editedFile: editedFile,
      });
    } else {
      vscode.postMessage({
        command: 'showInformationMessage',
        text: 'Please select both base and edited files to accept changes',
      });
    }
  });
}
