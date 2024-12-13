import { vscode } from './vscodeApi.js';
import { saveState } from './stateManager.js';
import { MULTIPLE_SELECTIONS, CHECK_BOXES, ELEMENTS_TO_SAVE } from './utils.js';
import {
  updateEditedFileSelect,
  getSelectedFiles,
  handleCheckboxChange,
  toggleMultipleFiles,
  toggleMultipleOutputFiles,
  toggleOutputNameOverride,
  emptyMultipleFiles,
} from './fileHandlers.js';

import { safeGetElementById, addEventListenerSafely } from './utils.js';


export function setupUIHandlers() {
  const sortableElements = [
    ...MULTIPLE_SELECTIONS,
    'multipleOutputFilesSelect',
  ];

  sortableElements.forEach((id) => {
    const element = safeGetElementById(id);
    if (element) {
      new Sortable(element, {
        animation: 150,
        onEnd: saveState,
      });
    } else {
      console.warn(
        `Element with id '${id}' not found for Sortable initialization`,
      );
    }
  });

  // Add event listeners for the empty buttons
  ['Input', 'Reference', 'Auxiliary', 'Figure', 'Base', 'Edited'].forEach(
    (type) => {
      addEventListenerSafely(`empty${type}FileButton`, 'click', () => {
        const selectElement = safeGetElementById(`${type.toLowerCase()}FileSelect`);
        if (selectElement) {
          selectElement.value = '';
          saveState();
        }
      });
    },
  );

  addEventListenerSafely('agentSelect', 'change', function() {
    const selectedAgent = this.value;
    if (selectedAgent.startsWith('correct')) {
      const figureSelect = safeGetElementById('figureFileSelect');
      const reflectSelect = safeGetElementById('reflectSelect');
      if (figureSelect) figureSelect.value = '';
      if (reflectSelect) reflectSelect.value = 'False';
    } else {
      vscode.postMessage({ command: 'requestFigureFile' });
      const reflectSelect = safeGetElementById('reflectSelect');
      if (reflectSelect) reflectSelect.value = 'True';
    }
    saveState();
  });

  addEventListenerSafely('modelSelect', 'change', function() {
    vscode.postMessage({
      command: 'modelSelected',
      model: this.value,
    });
  });

  addEventListenerSafely('inputFileSelect', 'change', function() {
    const inputFile = this.value;
    const outputNameOverride = safeGetElementById('outputNameOverride')?.value.trim() || null;
    vscode.postMessage({
      command: 'inputFileSelected',
      filePath: inputFile,
      outputNameOverride: outputNameOverride,
    });
  });

  addEventListenerSafely('referenceFileSelect', 'change', function() {
    const referenceFile = this.value;
    vscode.postMessage({
      command: 'referenceFileSelected',
      filePath: referenceFile,
    });
  });

  const multipleFileSelectors = [
    { id: 'InputFiles', selectId: 'inputFileSelect' },
    { id: 'ReferenceFiles', selectId: 'referenceFileSelect' },
    { id: 'AuxiliaryFiles', selectId: 'auxiliaryFileSelect' },
    { id: 'Figures', selectId: 'figureFileSelect' },
  ];

  multipleFileSelectors.forEach(({ id, selectId }) => {
    addEventListenerSafely(`selectMultiple${id}Button`, 'click', function () {
      const currentFile = safeGetElementById(selectId).value;
      vscode.postMessage({
        command: 'selectMultipleFiles',
        fileType: id,
        currentFile: currentFile,
      });
    });
  });

  addEventListenerSafely('selectMultipleOutputFilesButton', 'click', function () {
    const inputFile = safeGetElementById('inputFileSelect').value;
    vscode.postMessage({
      command: 'selectMultipleFiles',
      fileType: 'OutputFiles',
      currentFile: inputFile,
    });
  });

  MULTIPLE_SELECTIONS.forEach((id) => {
    let baseId = id.replace('Select', '');
    baseId = baseId.charAt(0).toUpperCase() + baseId.slice(1);
    addEventListenerSafely(`empty${baseId}Button`, 'click', () =>
      emptyMultipleFiles(id, `toggle${baseId}`),
    );
  });

  addEventListenerSafely('emptyMultipleOutputFilesButton', 'click', function () {
    emptyMultipleFiles(
      'multipleOutputFilesSelect',
      'toggleMultipleOutputFiles',
    );
  });

  CHECK_BOXES.forEach((id) => {
    addEventListenerSafely(id, 'change', handleCheckboxChange);
  });

  addEventListenerSafely('emptyInstructionsButton', 'click', function () {
    const instructionInput = safeGetElementById('instructionInput');
    if (instructionInput) {
      instructionInput.value = '';
      saveState();
    }
  });

  const buttonCommands = {
    cleanOutputButton: 'cleanOutput',
    cleanBuildButton: 'cleanBuild',
    indentTexButton: 'indentTex',
    refreshCommitsButton: 'refreshCommits',
  };

  Object.entries(buttonCommands).forEach(([id, command]) => {
    addEventListenerSafely(id, 'click', () => {
      vscode.postMessage({ command });
    });
  });

  addEventListenerSafely('executeButton', 'click', function () {
    const agent = safeGetElementById('agentSelect').value;
    const model = safeGetElementById('modelSelect').value;
    const reflect = safeGetElementById('reflectSelect').value;

    // Get single files
    const inputFile = safeGetElementById('inputFileSelect').value;
    const referenceFile = safeGetElementById(
      'referenceFileSelect',
    ).value;
    const auxiliaryFile = safeGetElementById(
      'auxiliaryFileSelect',
    ).value;
    const figureFile = safeGetElementById('figureFileSelect').value;

    // Get multiple files
    const getMultipleFiles = (selectId) => {
      const selectDiv = safeGetElementById(selectId);
      return selectDiv.style.display === 'block'
        ? getSelectedFiles(selectDiv)
        : [];
    };

    const inputFiles = getMultipleFiles('multipleInputFilesSelect').filter(
      (file) => file !== inputFile,
    );
    const referenceFiles = getMultipleFiles(
      'multipleReferenceFilesSelect',
    ).filter((file) => file !== referenceFile);
    const auxiliaryFiles = getMultipleFiles(
      'multipleAuxiliaryFilesSelect',
    ).filter((file) => file !== auxiliaryFile);
    const figureFiles = getMultipleFiles('multipleFiguresSelect').filter(
      (file) => file !== figureFile,
    );

    const outputFilesContainer = safeGetElementById(
      'outputFilesContainer',
    );
    const outputFiles =
      outputFilesContainer.style.display === 'block'
        ? getSelectedFiles(
            safeGetElementById('multipleOutputFilesSelect'),
          )
        : null;
    const outputNameOverrideElement =
      safeGetElementById('outputNameOverride');
    const outputNameOverride =
      outputNameOverrideElement.style.display !== 'none'
        ? outputNameOverrideElement.value.trim()
        : null;

    const instructions = safeGetElementById('instructionInput').value;

    const autoExtractFigure =
      safeGetElementById('autoExtractFigure').checked;
    const autoExtractTikzFigure = safeGetElementById(
      'autoExtractTikzFigure',
    ).checked;
    const autoExtractTikzFigureReflect = safeGetElementById(
      'autoExtractTikzFigureReflect',
    ).checked;
    const includeTexCount =
      safeGetElementById('includeTexCount').checked;

    vscode.postMessage({
      command: 'execute',
      // parameters
      agent: agent,
      model: model,
      reflect: reflect,
      // files
      inputFile: inputFile,
      inputFiles: inputFiles,
      referenceFile: referenceFile,
      referenceFiles: referenceFiles,
      auxiliaryFile: auxiliaryFile,
      auxiliaryFiles: auxiliaryFiles,
      figureFile: figureFile,
      figureFiles: figureFiles,
      // instructions
      instructions: instructions,
      // options
      autoExtractFigure: autoExtractFigure,
      autoExtractTikzFigure: autoExtractTikzFigure,
      autoExtractTikzFigureReflect: autoExtractTikzFigureReflect,
      includeTexCount: includeTexCount,
      // output
      outputFiles: outputFiles,
      outputNameOverride: outputNameOverride,
    });
  });

  addEventListenerSafely('mergeButton', 'click', function () {
    const inputFile = safeGetElementById('inputFileSelect').value;
    const editedFile = safeGetElementById('editedFileSelect').value;

    vscode.postMessage({
      command: 'merge',
      inputFile: inputFile,
      editedFile: editedFile,
    });

    vscode.postMessage({
      command: 'showInformationMessage',
      text: `Merging files: ${inputFile} and ${editedFile}`,
    });
  });

  addEventListenerSafely('refreshAllFilesButton', 'click', function () {
    vscode.postMessage({ command: 'refreshAllFiles' });
  });

  ['pack', 'clean'].forEach((action) => {
    addEventListenerSafely(`${action}Button`, 'click', function () {
      const inputFile = safeGetElementById('inputFileSelect').value;
      const agent = safeGetElementById('agentSelect').value;
      const model = safeGetElementById('modelSelect').value;
      const outputNameOverrideElement =
        safeGetElementById('outputNameOverride');
      const outputNameOverride =
        outputNameOverrideElement.style.display !== 'none'
          ? outputNameOverrideElement.value.trim()
          : null;

      const inputFiles = getSelectedFiles(
        safeGetElementById('multipleInputFilesSelect'),
      );
      const outputFiles = getSelectedFiles(
        safeGetElementById('multipleOutputFilesSelect'),
      );

      // Determine if we should use multiple or single mode
      const useMultiple = inputFiles.length > 0 || outputFiles.length > 0;

      if (useMultiple) {
        vscode.postMessage({
          command: `${action}Multiple`,
          inputFile: inputFile,
          agent: agent,
          model: model,
          outputNameOverride: outputNameOverride,
          outputFiles: outputFiles,
        });

        vscode.postMessage({
          command: 'showInformationMessage',
          text: `${action.charAt(0).toUpperCase() + action.slice(1)}ing multiple files: ${[inputFile, ...inputFiles].join(', ')}`,
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
          inputFile: inputFile,
          agent: agent,
          model: model,
          outputNameOverride: outputNameOverride,
        });

        vscode.postMessage({
          command: 'showInformationMessage',
          text: `${action.charAt(0).toUpperCase() + action.slice(1)}ing single file: ${inputFile}`,
        });
      }
    });
  });

  addEventListenerSafely('latexDiffButton', 'click', function () {
    const inputFile = safeGetElementById('inputFileSelect').value;
    const baseFile = safeGetElementById('baseFileSelect').value;
    const editedFile = safeGetElementById('editedFileSelect').value;

    vscode.postMessage({
      command: 'latexDiff',
      inputFile: inputFile,
      baseFile: baseFile,
      editedFile: editedFile,
    });

    vscode.postMessage({
      command: 'showInformationMessage',
      text: `Running LaTeX diff between ${baseFile} and ${editedFile}`,
    });
  });

  addEventListenerSafely('latexDiffVCButton', 'click', function () {
    const inputFile = safeGetElementById('inputFileSelect').value;
    const baseFile = safeGetElementById('baseFileSelect').value;
    const commitHash = safeGetElementById('commitSelect').value;

    vscode.postMessage({
      command: 'latexDiffVC',
      inputFile: inputFile,
      baseFile: baseFile,
      commitHash: commitHash,
    });

    vscode.postMessage({
      command: 'showInformationMessage',
      text: `Running LaTeX diff with version control: ${baseFile} at commit ${commitHash}`,
    });
  });

  ['pack', 'clean'].forEach((action) => {
    addEventListenerSafely(`${action}LatexDiffVCButton`, 'click', function () {
      const inputFile = safeGetElementById('inputFileSelect').value;
      const baseFile = safeGetElementById('baseFileSelect').value;
      const commitHash = safeGetElementById('commitSelect').value;

      vscode.postMessage({
        command: `${action}LatexDiffVC`,
        inputFile: inputFile,
        baseFile: baseFile,
        commitHash: commitHash,
        clean: action === 'clean',
      });

      const actionText = action === 'pack' ? 'Packing' : 'Cleaning';
      vscode.postMessage({
        command: 'showInformationMessage',
        text: `${actionText} LaTeX diff with version control: ${baseFile} at commit ${commitHash}`,
      });
    });
  });

  ['base', 'edited'].forEach((type) => {
    addEventListenerSafely(
      `current${type.charAt(0).toUpperCase() + type.slice(1)}FileButton`,
      'click',
      function () {
        const baseFile = safeGetElementById('baseFileSelect').value;
        vscode.postMessage({
          command: 'getCurrentFile',
          fileType: type,
          baseFile: baseFile,
        });
      },
    );
  });

  ELEMENTS_TO_SAVE.forEach((id) => {
    if (id !== 'instructionInput') {
      addEventListenerSafely(id, 'change', saveState);
    }
  });

  // Special case for instructionInput as it uses 'input' event
  addEventListenerSafely('instructionInput', 'input', saveState);
  addEventListenerSafely('outputNameOverride', 'input', saveState);

  new Sortable(safeGetElementById('multipleOutputFilesSelect'), {
    animation: 150,
    onEnd: saveState,
  });

  addEventListenerSafely('toggleOutputNameOverride', 'click', toggleOutputNameOverride);

  addEventListenerSafely('addOpenedFilesButton', 'click', function () {
    vscode.postMessage({
      command: 'addOpenedFiles',
    });
  });

  // Add event listeners for current file buttons
  ['Input', 'Reference', 'Auxiliary', 'Figure'].forEach((type) => {
    addEventListenerSafely(
      `current${type}FileButton`,
      'click',
      () => {
        vscode.postMessage({
          command: 'getCurrentFile',
          fileType: type.toLowerCase(),
        });
      },
    );
  });

  // Add event listener for base file select
  addEventListenerSafely('baseFileSelect', 'change', function () {
    const baseFile = this.value;
    vscode.postMessage({
      command: 'requestEditedFile',
      baseFile: baseFile,
    });
    updateEditedFileSelect(baseFile);
    // sus
  });

  // Add event listener for the refresh button
  addEventListenerSafely('refreshEditedFileButton', 'click', function () {
    const baseFile = safeGetElementById('baseFileSelect').value;
    if (baseFile) {
      vscode.postMessage({
        command: 'requestEditedFile',
        baseFile: baseFile,
      });
    } else {
      vscode.postMessage({
        command: 'showInformationMessage',
        text: 'Please select a base file first.',
      });
    }
  });

  addEventListenerSafely('toggleMultipleOutputFiles', 'click', toggleMultipleOutputFiles);

  MULTIPLE_SELECTIONS.forEach((id) => {
    const baseId = id.replace('Select', '');
    const toggleId = `toggle${baseId.charAt(0).toUpperCase() + baseId.slice(1)}`;
    addEventListenerSafely(toggleId, 'click', () => toggleMultipleFiles(id, toggleId));
  });
}
