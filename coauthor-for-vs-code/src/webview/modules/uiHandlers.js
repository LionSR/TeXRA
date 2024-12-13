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

export function setupUIHandlers() {
  const sortableElements = [
    ...MULTIPLE_SELECTIONS,
    'multipleOutputFilesSelect',
  ];

  sortableElements.forEach((id) => {
    const element = document.getElementById(id);
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
      document
        .getElementById(`empty${type}FileButton`)
        .addEventListener('click', () => {
          document.getElementById(`${type.toLowerCase()}FileSelect`).value = '';
          saveState();
        });
    },
  );

  document
    .getElementById('agentSelect')
    .addEventListener('change', function () {
      const selectedAgent = this.value;
      if (selectedAgent.startsWith('correct')) {
        document.getElementById('figureFileSelect').value = '';
        document.getElementById('reflectSelect').value = 'False';
      } else {
        // Refresh the figure file options
        vscode.postMessage({ command: 'requestFigureFile' });
        document.getElementById('reflectSelect').value = 'True';
      }
      saveState();
    });
  document
    .getElementById('modelSelect')
    .addEventListener('change', function () {
      vscode.postMessage({
        command: 'modelSelected',
        model: this.value,
      });
    });
  document
    .getElementById('inputFileSelect')
    .addEventListener('change', function () {
      const inputFile = this.value;
      const outputNameOverride =
        document.getElementById('outputNameOverride').value.trim() || null;
      vscode.postMessage({
        command: 'inputFileSelected',
        filePath: inputFile,
        outputNameOverride: outputNameOverride,
      });
    });
  document
    .getElementById('referenceFileSelect')
    .addEventListener('change', function () {
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
    document
      .getElementById(`selectMultiple${id}Button`)
      .addEventListener('click', function () {
        const currentFile = document.getElementById(selectId).value;
        vscode.postMessage({
          command: 'selectMultipleFiles',
          fileType: id,
          currentFile: currentFile,
        });
      });
  });

  document
    .getElementById('selectMultipleOutputFilesButton')
    .addEventListener('click', function () {
      const inputFile = document.getElementById('inputFileSelect').value;
      vscode.postMessage({
        command: 'selectMultipleFiles',
        fileType: 'OutputFiles',
        currentFile: inputFile,
      });
    });

  MULTIPLE_SELECTIONS.forEach((id) => {
    let baseId = id.replace('Select', '');
    baseId = baseId.charAt(0).toUpperCase() + baseId.slice(1);
    document
      .getElementById(`empty${baseId}Button`)
      .addEventListener('click', () =>
        emptyMultipleFiles(id, `toggle${baseId}`),
      );
  });

  document
    .getElementById('emptyMultipleOutputFilesButton')
    .addEventListener('click', function () {
      emptyMultipleFiles(
        'multipleOutputFilesSelect',
        'toggleMultipleOutputFiles',
      );
    });

  CHECK_BOXES.forEach((id) => {
    document
      .getElementById(id)
      .addEventListener('change', handleCheckboxChange);
  });

  document
    .getElementById('emptyInstructionsButton')
    .addEventListener('click', function () {
      document.getElementById('instructionInput').value = '';
      saveState();
    });

  const buttonCommands = {
    cleanOutputButton: 'cleanOutput',
    cleanBuildButton: 'cleanBuild',
    indentTexButton: 'indentTex',
    refreshCommitsButton: 'refreshCommits',
  };

  Object.entries(buttonCommands).forEach(([id, command]) => {
    document.getElementById(id).addEventListener('click', () => {
      vscode.postMessage({ command });
    });
  });

  document
    .getElementById('executeButton')
    .addEventListener('click', function () {
      const agent = document.getElementById('agentSelect').value;
      const model = document.getElementById('modelSelect').value;
      const reflect = document.getElementById('reflectSelect').value;

      // Get single files
      const inputFile = document.getElementById('inputFileSelect').value;
      const referenceFile = document.getElementById(
        'referenceFileSelect',
      ).value;
      const auxiliaryFile = document.getElementById(
        'auxiliaryFileSelect',
      ).value;
      const figureFile = document.getElementById('figureFileSelect').value;

      // Get multiple files
      const getMultipleFiles = (selectId) => {
        const selectDiv = document.getElementById(selectId);
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

      const outputFilesContainer = document.getElementById(
        'outputFilesContainer',
      );
      const outputFiles =
        outputFilesContainer.style.display === 'block'
          ? getSelectedFiles(
              document.getElementById('multipleOutputFilesSelect'),
            )
          : null;
      const outputNameOverrideElement =
        document.getElementById('outputNameOverride');
      const outputNameOverride =
        outputNameOverrideElement.style.display !== 'none'
          ? outputNameOverrideElement.value.trim()
          : null;

      const instructions = document.getElementById('instructionInput').value;

      const autoExtractFigure =
        document.getElementById('autoExtractFigure').checked;
      const autoExtractTikzFigure = document.getElementById(
        'autoExtractTikzFigure',
      ).checked;
      const autoExtractTikzFigureReflect = document.getElementById(
        'autoExtractTikzFigureReflect',
      ).checked;
      const includeTexCount =
        document.getElementById('includeTexCount').checked;

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

  document.getElementById('mergeButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const editedFile = document.getElementById('editedFileSelect').value;

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

  document
    .getElementById('refreshAllFilesButton')
    .addEventListener('click', function () {
      vscode.postMessage({ command: 'refreshAllFiles' });
    });

  ['pack', 'clean'].forEach((action) => {
    document
      .getElementById(`${action}Button`)
      .addEventListener('click', function () {
        const inputFile = document.getElementById('inputFileSelect').value;
        const agent = document.getElementById('agentSelect').value;
        const model = document.getElementById('modelSelect').value;
        const outputNameOverrideElement =
          document.getElementById('outputNameOverride');
        const outputNameOverride =
          outputNameOverrideElement.style.display !== 'none'
            ? outputNameOverrideElement.value.trim()
            : null;

        const inputFiles = getSelectedFiles(
          document.getElementById('multipleInputFilesSelect'),
        );
        const outputFiles = getSelectedFiles(
          document.getElementById('multipleOutputFilesSelect'),
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

  document
    .getElementById('latexDiffButton')
    .addEventListener('click', function () {
      const inputFile = document.getElementById('inputFileSelect').value;
      const baseFile = document.getElementById('baseFileSelect').value;
      const editedFile = document.getElementById('editedFileSelect').value;

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
  document
    .getElementById('latexDiffVCButton')
    .addEventListener('click', function () {
      const inputFile = document.getElementById('inputFileSelect').value;
      const baseFile = document.getElementById('baseFileSelect').value;
      const commitHash = document.getElementById('commitSelect').value;

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
    document
      .getElementById(`${action}LatexDiffVCButton`)
      .addEventListener('click', function () {
        const inputFile = document.getElementById('inputFileSelect').value;
        const baseFile = document.getElementById('baseFileSelect').value;
        const commitHash = document.getElementById('commitSelect').value;

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
    document
      .getElementById(
        `current${type.charAt(0).toUpperCase() + type.slice(1)}FileButton`,
      )
      .addEventListener('click', function () {
        const baseFile = document.getElementById('baseFileSelect').value;
        vscode.postMessage({
          command: 'getCurrentFile',
          fileType: type,
          baseFile: baseFile,
        });
      });
  });

  ELEMENTS_TO_SAVE.forEach((id) => {
    if (id !== 'instructionInput') {
      document.getElementById(id).addEventListener('change', saveState);
    }
  });

  // Special case for instructionInput as it uses 'input' event
  document
    .getElementById('instructionInput')
    .addEventListener('input', saveState);
  document
    .getElementById('outputNameOverride')
    .addEventListener('input', saveState);

  new Sortable(document.getElementById('multipleOutputFilesSelect'), {
    animation: 150,
    onEnd: saveState,
  });

  document
    .getElementById('toggleOutputNameOverride')
    .addEventListener('click', toggleOutputNameOverride);

  document
    .getElementById('addOpenedFilesButton')
    .addEventListener('click', function () {
      vscode.postMessage({
        command: 'addOpenedFiles',
      });
    });

  // Add event listeners for current file buttons
  ['Input', 'Reference', 'Auxiliary', 'Figure'].forEach((type) => {
    document
      .getElementById(`current${type}FileButton`)
      .addEventListener('click', () => {
        vscode.postMessage({
          command: 'getCurrentFile',
          fileType: type.toLowerCase(),
        });
      });
  });

  // Add event listener for base file select
  document
    .getElementById('baseFileSelect')
    .addEventListener('change', function () {
      const baseFile = this.value;
      vscode.postMessage({
        command: 'requestEditedFile',
        baseFile: baseFile,
      });
      updateEditedFileSelect(baseFile);
      // sus
    });

  // Add event listener for the refresh button
  document
    .getElementById('refreshEditedFileButton')
    .addEventListener('click', function () {
      const baseFile = document.getElementById('baseFileSelect').value;
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

  document
    .getElementById('toggleMultipleOutputFiles')
    .addEventListener('click', toggleMultipleOutputFiles);

  MULTIPLE_SELECTIONS.forEach((id) => {
    const baseId = id.replace('Select', '');
    const toggleId = `toggle${baseId.charAt(0).toUpperCase() + baseId.slice(1)}`;
    document
      .getElementById(toggleId)
      .addEventListener('click', () => toggleMultipleFiles(id, toggleId));
  });
}
