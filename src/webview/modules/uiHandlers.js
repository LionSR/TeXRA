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
import {
  safeGetElementById,
  addEventListenerSafely,
  safeGetElementValue,
  safeGetElementChecked,
  capitalize,
  uncapitalize,
} from './utils.js';

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

  // Add auto-extract toggle handler
  function updateAutoToggleState() {
    const autoExtractToggle = safeGetElementById('toggleAutoExtract');
    const autoExtractOptions = safeGetElementById('autoExtractOptions');
    const isVisible = autoExtractOptions.style.display === 'block';

    // Check if any auto-extract checkbox is checked
    const hasChecked = [
      'autoExtractFigure',
      'autoExtractTikzFigure',
      'autoExtractTikzFigureReflect',
    ].some((id) => safeGetElementChecked(id));

    const indicator = hasChecked ? '●' : '○';
    const direction = isVisible ? 'up' : 'down';

    autoExtractToggle.innerHTML = `Auto Extract ${indicator}<i class="codicon codicon-chevron-${direction}"></i>`;
  }

  addEventListenerSafely('toggleAutoExtract', 'click', function () {
    const autoExtractOptions = safeGetElementById('autoExtractOptions');
    const isVisible = autoExtractOptions.style.display === 'block';

    autoExtractOptions.style.display = isVisible ? 'none' : 'block';
    updateAutoToggleState();
  });

  // Add checkbox change listeners for auto-extract options
  [
    'autoExtractFigure',
    'autoExtractTikzFigure',
    'autoExtractTikzFigureReflect',
  ].forEach((id) => {
    addEventListenerSafely(id, 'change', function () {
      updateAutoToggleState();
      handleCheckboxChange.call(this);
    });
  });

  // Add event listeners for the empty buttons
  ['Input', 'Reference', 'Auxiliary', 'Figure', 'Base', 'Edited'].forEach(
    (type) => {
      addEventListenerSafely(`empty${type}FileButton`, 'click', () => {
        const selectElement = safeGetElementById(`${uncapitalize(type)}File`);
        if (selectElement) {
          selectElement.value = '';
          saveState();
        }
      });
    },
  );

  addEventListenerSafely('agent', 'change', function () {
    const selectedAgent = this.value;
    if (selectedAgent.startsWith('correct')) {
      const figure = safeGetElementById('figureFile');
      const reflect = safeGetElementById('reflect');
      if (figure) figure.value = '';
      if (reflect) reflect.value = 'False';
    } else {
      vscode.postMessage({ command: 'requestFigureFile' });
      const reflect = safeGetElementById('reflect');
      if (reflect) reflect.value = 'True';
    }
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
  const multipleFileSelectors = [
    { id: 'InputFiles', selectId: 'inputFile' },
    { id: 'ReferenceFiles', selectId: 'referenceFile' },
    { id: 'AuxiliaryFiles', selectId: 'auxiliaryFile' },
    { id: 'FigureFiles', selectId: 'figureFile' },
    { id: 'OutputFiles', selectId: 'inputFile' }, // OutputFiles uses inputFile as reference
  ];

  multipleFileSelectors.forEach(({ id, selectId }) => {
    const selectMultipleButtonId = `selectMultiple${capitalize(id)}Button`;
    addEventListenerSafely(selectMultipleButtonId, 'click', function () {
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

  addEventListenerSafely('eraseInstructionsButton', 'click', function () {
    const instructionInput = safeGetElementById('instructionInput');
    if (instructionInput) {
      instructionInput.value = '';
      saveState();
    }
  });

  addEventListenerSafely('executeButton', 'click', function () {
    const agent = safeGetElementValue('agent');
    const model = safeGetElementValue('model');
    const reflect = safeGetElementValue('reflect');

    // Get single files
    const inputFile = safeGetElementValue('inputFile');
    const referenceFile = safeGetElementValue('referenceFile');
    const auxiliaryFile = safeGetElementValue('auxiliaryFile');
    const figureFile = safeGetElementValue('figureFile');

    // Get multiple files
    const getMultipleFiles = (selectId) => {
      const selectDiv = safeGetElementById(selectId);
      const containerDiv = safeGetElementById(`${selectId}Container`);
      return selectDiv && containerDiv && containerDiv.style.display === 'block'
        ? getSelectedFiles(selectDiv)
        : [];
    };

    const inputFiles = getMultipleFiles('multipleInputFiles').filter(
      (file) => file !== inputFile,
    );
    const referenceFiles = getMultipleFiles('multipleReferenceFiles').filter(
      (file) => file !== referenceFile,
    );
    const auxiliaryFiles = getMultipleFiles('multipleAuxiliaryFiles').filter(
      (file) => file !== auxiliaryFile,
    );
    const figureFiles = getMultipleFiles('multipleFigureFiles').filter(
      (file) => file !== figureFile,
    );
    const outputFiles = getMultipleFiles('multipleOutputFiles');

    const outputNameOverrideDiv = safeGetElementById('outputNameOverride');
    const outputNameOverride =
      outputNameOverrideDiv && outputNameOverrideDiv.style.display !== 'none'
        ? outputNameOverrideDiv.value.trim()
        : null;

    const instruction = safeGetElementValue('instructionInput');

    const autoExtractFigure = safeGetElementChecked('autoExtractFigure');
    const autoExtractTikzFigure = safeGetElementChecked(
      'autoExtractTikzFigure',
    );
    const autoExtractTikzFigureReflect = safeGetElementChecked(
      'autoExtractTikzFigureReflect',
    );
    const attachTeXCount = safeGetElementChecked('attachTeXCount');
    const usePrefillFromInput = safeGetElementChecked('usePrefillFromInput');
    const autoConfirmation = safeGetElementChecked('autoConfirmation');
    const printInputPrompt = safeGetElementChecked('printInputPrompt');

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
      // instruction
      instruction: instruction,
      // options
      autoExtractFigure: autoExtractFigure,
      autoExtractTikzFigure: autoExtractTikzFigure,
      autoExtractTikzFigureReflect: autoExtractTikzFigureReflect,
      attachTeXCount: attachTeXCount,
      usePrefillFromInput: usePrefillFromInput,
      autoConfirmation: autoConfirmation,
      printInputPrompt: printInputPrompt,
      // output
      outputFiles: outputFiles,
      outputNameOverride: outputNameOverride,
    });
  });

  addEventListenerSafely('mergeButton', 'click', function () {
    const inputFile = safeGetElementValue('inputFile');
    const editedFile = safeGetElementValue('editedFile');

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

  ['pack', 'clean'].forEach((action) => {
    addEventListenerSafely(`${action}Button`, 'click', function () {
      const inputFile = safeGetElementValue('inputFile');
      const agent = safeGetElementValue('agent');
      const model = safeGetElementValue('model');
      const outputNameOverrideDiv = safeGetElementById('outputNameOverride');
      const outputNameOverride =
        outputNameOverrideDiv && outputNameOverrideDiv.style.display !== 'none'
          ? outputNameOverrideDiv.value.trim()
          : null;

      const inputFiles = getSelectedFiles(
        safeGetElementById('multipleInputFiles'),
      );
      const outputFiles = getSelectedFiles(
        safeGetElementById('multipleOutputFiles'),
      );

      // BUG: Determine if we should use multiple or single mode
      // Note: inputFiles.length>0 is reserved for agents with default output files
      // but this is not currently supported due to back-front end separation
      const outputFilesContainer = safeGetElementById(
        'multipleOutputFilesContainer',
      );
      const useMultiple =
        outputFilesContainer &&
        outputFilesContainer.style.display === 'block' &&
        outputFiles.length > 0;

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
          text: `${capitalize(action)}ing multiple files: ${[inputFile, ...inputFiles].join(', ')}`,
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
          text: `${capitalize(action)}ing single file: ${inputFile}`,
        });
      }
    });
  });

  addEventListenerSafely('latexdiffButton', 'click', function () {
    const inputFile = safeGetElementValue('inputFile');
    const baseFile = safeGetElementValue('baseFile');
    const editedFile = safeGetElementValue('editedFile');

    vscode.postMessage({
      command: 'latexdiff',
      inputFile: inputFile,
      baseFile: baseFile,
      editedFile: editedFile,
    });

    vscode.postMessage({
      command: 'showInformationMessage',
      text: `Running LaTeX diff between ${baseFile} and ${editedFile}`,
    });
  });

  addEventListenerSafely('latexdiffvcButton', 'click', function () {
    const inputFile = safeGetElementValue('inputFile');
    const baseFile = safeGetElementValue('baseFile');
    const commitHash = safeGetElementValue('commit');

    vscode.postMessage({
      command: 'latexdiffvc',
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
    addEventListenerSafely(`${action}LatexdiffvcButton`, 'click', function () {
      const inputFile = safeGetElementValue('inputFile');
      const baseFile = safeGetElementValue('baseFile');
      const commitHash = safeGetElementValue('commit');

      vscode.postMessage({
        command: `${action}Latexdiffvc`,
        inputFile: inputFile,
        baseFile: baseFile,
        commitHash: commitHash,
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
    if (id !== 'instructionInput') {
      addEventListenerSafely(id, 'change', saveState);
    }
  });

  // Special case for instructionInput as it uses 'input' event
  addEventListenerSafely('instructionInput', 'input', saveState);
  addEventListenerSafely('outputNameOverride', 'input', saveState);

  new Sortable(safeGetElementById('multipleOutputFiles'), {
    animation: 150,
    onEnd: saveState,
  });

  addEventListenerSafely(
    'toggleOutputNameOverride',
    'click',
    toggleOutputNameOverride,
  );

  addEventListenerSafely('addOpenedFilesButton', 'click', function () {
    vscode.postMessage({
      command: 'addOpenedFiles',
    });
  });

  // Add event listeners for current file buttons
  ['Input', 'Reference', 'Auxiliary'].forEach((type) => {
    const currentFileButtonId = `current${capitalize(type)}FileButton`;
    addEventListenerSafely(currentFileButtonId, 'click', () => {
      vscode.postMessage({
        command: 'getCurrentFile',
        fileType: uncapitalize(type),
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
      if (id === 'multipleOutputFiles') {
        toggleMultipleOutputFiles();
      } else {
        toggleMultipleFiles(id, toggleId);
      }
    });
  });
}
