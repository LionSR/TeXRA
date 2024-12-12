const vscode = acquireVsCodeApi();

function handleCheckboxChange(event) {
  const checkboxId = event.target.id;
  const isChecked = event.target.checked;
  vscode.postMessage({
    command: `update${checkboxId.charAt(0).toUpperCase() + checkboxId.slice(1)}`,
    value: isChecked,
  });
}

function updateFileSelect(selectId, files) {
  const select = document.getElementById(selectId);
  if (!select) return console.error(`Element with id '${selectId}' not found`);
  select.innerHTML =
    '<option value="">None</option>' +
    files.map((file) => `<option value="${file}">${file}</option>`).join('');
}

function updateEditedFileSelect(baseFile) {
  if (baseFile) {
    vscode.postMessage({
      command: 'requestEditedFile',
      baseFile: baseFile,
    });
  } else {
    updateFileSelect('editedFileSelect', []);
  }
}

function updateMultipleFileSelect(selectId, toggleIconId, files) {
  const selectDiv = document.getElementById(selectId);
  const toggleIcon = document.getElementById(toggleIconId);
  const existingFiles = getSelectedFiles(selectDiv);
  const newFiles = files.filter((file) => !existingFiles.includes(file));
  if (newFiles.length > 0) {
    newFiles.forEach((file) => {
      addFileToList(selectId, file);
    });
    selectDiv.style.display = 'block';
    toggleIcon.textContent = '▲';
    const containerDiv = selectDiv.closest('.file-select');
    if (containerDiv) {
      containerDiv.style.display = 'block';
    }
    vscode.postMessage({
      command: 'showInformationMessage',
      text: `Added ${newFiles.length} file(s) to ${selectId}`,
    });
  }
  saveState();
}

function safeGetElementById(id) {
  const element = document.getElementById(id);
  if (!element) {
    console.warn(`Element with id '${id}' not found`);
  }
  return element;
}

function addEventListenerSafely(elementId, event, handler) {
  const element = safeGetElementById(elementId);
  if (element) {
    element.addEventListener(event, handler);
  }
}


function addFileToList(containerId, file) {
  const container = document.getElementById(containerId);
  const toggleIcon = document.getElementById(
    `toggle${containerId.charAt(0).toUpperCase() + containerId.slice(1)}`,
  );
  const fileElement = document.createElement('div');
  fileElement.innerHTML = `${file} <span class="remove-button">-</span>`;
  fileElement.querySelector('.remove-button').addEventListener('click', () => {
    container.removeChild(fileElement);
    if (container.children.length === 0) {
      containerId === 'outputFilesList'
        ? handleEmptyOutputFiles()
        : ((container.style.display = 'none'),
          (toggleIcon.textContent = '▼'),
          saveState());
    }
  });
  container.appendChild(fileElement);
}

function handleEmptyOutputFiles() {
  const outputFilesContainer = document.getElementById('outputFilesContainer');
  const toggleIcon = document.getElementById('toggleOutputFiles');
  outputFilesContainer.style.display = 'none';
  toggleIcon.textContent = '▼';
  saveState();
}

function getSelectedFiles(multipleFilesSelectDiv) {
  const fileElements = multipleFilesSelectDiv.getElementsByTagName('div');
  return Array.from(fileElements).map(
    (el) => el.textContent.replace(' -', '') || '',
  );
}

function initializeOutputFiles() {
  const inputFileSelect = document.getElementById('inputFileSelect');
  const multipleInputFilesSelect = document.getElementById(
    'multipleInputFilesSelect',
  );
  const outputFilesList = document.getElementById('outputFilesList');
  outputFilesList.innerHTML = '';

  // Add the main input file
  if (inputFileSelect.value) {
    addFileToList('outputFilesList', inputFileSelect.value);
  }

  // Add multiple input files
  const additionalFiles = getSelectedFiles(multipleInputFilesSelect);
  additionalFiles.forEach((file) => {
    addFileToList('outputFilesList', file);
  });
}

function addOptionToSelect(select, value, text) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = text;
  select.appendChild(option);
}

function toggleOutputFiles() {
  const outputFilesContainer = document.getElementById('outputFilesContainer');
  const toggleIcon = document.getElementById('toggleOutputFiles');
  if (outputFilesContainer.style.display === 'none') {
    outputFilesContainer.style.display = 'block';
    toggleIcon.textContent = '▲';
    initializeOutputFiles();
  } else {
    outputFilesContainer.style.display = 'none';
    toggleIcon.textContent = '▼';
  }
  saveState();
}

function toggleOutputNameOverride() {
  const outputNameOverride = document.getElementById('outputNameOverride');
  const toggleIcon = document.getElementById('toggleOutputNameOverride');
  if (outputNameOverride.style.display === 'none') {
    outputNameOverride.style.display = 'inline-block';
    toggleIcon.textContent = '▲';
  } else {
    outputNameOverride.style.display = 'none';
    toggleIcon.textContent = '▼';
  }
  saveState();
}

function toggleMultipleFiles(containerId, toggleIconId) {
  const container = document.getElementById(containerId);
  const isVisible = container.style.display !== 'none';
  setMultipleFileSelectVisibility(containerId, toggleIconId, !isVisible);

  saveState();
}

function setMultipleFileSelectVisibility(containerId, toggleId, isVisible) {
  const container = document.getElementById(containerId);
  const toggleIcon = document.getElementById(toggleId);
  container.style.display = isVisible ? 'block' : 'none';
  toggleIcon.textContent = isVisible ? '▲' : '▼';
}

function setDefaultState() {
  // Hide output name override by default
  const outputNameOverride = document.getElementById('outputNameOverride');
  const toggleOutputNameOverride = document.getElementById(
    'toggleOutputNameOverride',
  );
  outputNameOverride.style.display = 'none';
  toggleOutputNameOverride.textContent = '▼';

  // Hide multiple file output by default
  const outputFilesContainer = document.getElementById('outputFilesContainer');
  const toggleOutputFiles = document.getElementById('toggleOutputFiles');
  outputFilesContainer.style.display = 'none';
  toggleOutputFiles.textContent = '▼';

  // Clear any existing output files
  document.getElementById('outputFilesList').innerHTML = '';

  // Hide all multiple file select containers
  const multipleSelections = [
    'multipleInputFilesSelect',
    'multipleReferenceFilesSelect',
    'multipleAuxiliaryFilesSelect',
    'multipleFiguresSelect',
  ];

  multipleSelections.forEach((id) => {
    const selectDiv = document.getElementById(id);
    const toggleId = `toggle${id.charAt(0).toUpperCase() + id.slice(1)}`;
    const toggleIcon = document.getElementById(toggleId);
    selectDiv.innerHTML = '';
    setMultipleFileSelectVisibility(id, toggleId, false);
  });

  // Save this default state
  saveState();
}

function restoreState() {
  const previousState = vscode.getState();
  if (previousState) {
    const defaultValues = {
      agentSelect: 'correct_tex',
      reflectSelect: 'True',
      commitSelect: 'HEAD',
    };

    const valueElements = [
      // parameters
      'agentSelect',
      'modelSelect',
      'reflectSelect',
      // files
      'inputFileSelect',
      'auxiliaryFileSelect',
      'figureFileSelect',
      'referenceFileSelect',
      'editedFileSelect',
      'baseFileSelect',
      // instructions
      'instructionInput',
      // output
      'outputNameOverride',
      // git
      'commitSelect',
    ];

    valueElements.forEach((id) => {
      document.getElementById(id).value =
        previousState[id] || defaultValues[id] || '';
    });

    const checkboxElements = [
      'autoExtractFigure',
      'autoExtractTikzFigure',
      'autoExtractTikzFigureReflect',
      'includeTexCount',
    ];
    checkboxElements.forEach((id) => {
      document.getElementById(id).checked = previousState[id] || false;
    });

    const multipleSelections = [
      { id: 'multipleInputFilesSelect', toggleId: 'toggleMultipleInputFiles' },
      {
        id: 'multipleReferenceFilesSelect',
        toggleId: 'toggleMultipleReferenceFiles',
      },
      {
        id: 'multipleAuxiliaryFilesSelect',
        toggleId: 'toggleMultipleAuxiliaryFiles',
      },
      { id: 'multipleFiguresSelect', toggleId: 'toggleMultipleFigures' },
    ];

    multipleSelections.forEach(({ id, toggleId }) => {
      const selectDiv = document.getElementById(id);
      const toggleIcon = document.getElementById(toggleId);
      selectDiv.innerHTML = '';
      if (previousState[id] && previousState[id].length > 0) {
        previousState[id].forEach((file) => {
          addFileToList(id, file);
        });
        setMultipleFileSelectVisibility(
          id,
          toggleId,
          previousState[`${id}Visible`],
        );
      } else {
        setMultipleFileSelectVisibility(id, toggleId, false);
      }
    });

    const outputFilesContainer = document.getElementById(
      'outputFilesContainer',
    );
    const toggleIcon = document.getElementById('toggleOutputFiles');
    if (
      previousState.outputFilesContainerVisible &&
      previousState.outputFiles &&
      previousState.outputFiles.length > 0
    ) {
      outputFilesContainer.style.display = 'block';
      toggleIcon.textContent = '▲';
      const outputFilesList = document.getElementById('outputFilesList');
      outputFilesList.innerHTML = '';
      previousState.outputFiles.forEach((file) => {
        addFileToList('outputFilesList', file);
      });
    } else {
      outputFilesContainer.style.display = 'none';
      toggleIcon.textContent = '▼';
    }

    const outputNameOverride = document.getElementById('outputNameOverride');
    const toggleOutputNameOverride = document.getElementById(
      'toggleOutputNameOverride',
    );
    if (previousState.outputNameOverrideVisible) {
      outputNameOverride.style.display = 'inline-block';
      toggleOutputNameOverride.textContent = '▲';
      outputNameOverride.value = previousState.outputNameOverride || '';
    } else {
      outputNameOverride.style.display = 'none';
      toggleOutputNameOverride.textContent = '▼';
    }
  } else {
    // If there's no previous state, set to default
    setDefaultState();
  }

  // Hide empty multiple file select boxes
  hideEmptyMultipleFileSelects();
}

function saveState() {
  const state = {};
  const elementsToSave = [
    'modelSelect',
    'agentSelect',
    'inputFileSelect',
    'referenceFileSelect',
    'auxiliaryFileSelect',
    'figureFileSelect',
    'reflectSelect',
    'commitSelect',
    'autoExtractFigure',
    'autoExtractTikzFigure',
    'autoExtractTikzFigureReflect',
    'includeTexCount',
    'outputNameOverride',
    'baseFileSelect',
    'editedFileSelect',
    'instructionInput',
  ];

  elementsToSave.forEach((id) => {
    const element = document.getElementById(id);
    state[id] = element.type === 'checkbox' ? element.checked : element.value;
  });

  const multipleSelects = [
    'multipleInputFilesSelect',
    'multipleReferenceFilesSelect',
    'multipleAuxiliaryFilesSelect',
    'multipleFiguresSelect',
  ];

  multipleSelects.forEach((id) => {
    state[`${id}Visible`] =
      document.getElementById(id).style.display === 'block';
    state[id] = getSelectedFiles(document.getElementById(id));
  });

  state.outputFilesContainerVisible =
    document.getElementById('outputFilesContainer').style.display === 'block';
  state.outputFiles = getSelectedFiles(
    document.getElementById('outputFilesList'),
  );
  state.outputNameOverrideVisible =
    document.getElementById('outputNameOverride').style.display !== 'none';

  vscode.setState(state);
}

function hideEmptyMultipleFileSelects() {
  const multipleSelections = [
    'multipleInputFilesSelect',
    'multipleReferenceFilesSelect',
    'multipleAuxiliaryFilesSelect',
    'multipleFiguresSelect',
  ];

  multipleSelections.forEach((id) => {
    const selectDiv = document.getElementById(id);
    const toggleId = `toggle${id.charAt(0).toUpperCase() + id.slice(1)}`;
    if (selectDiv.children.length === 0) {
      setMultipleFileSelectVisibility(id, toggleId, false);
    }
  });
}

function setElementsDisabled(elements, disabled) {
  elements.forEach((element) => {
    if (typeof element === 'string') {
      document.getElementById(element).disabled = disabled;
    } else {
      element.disabled = disabled;
    }
  });
}

function handleRecentCommits(message) {
  const commitButtons = [
    'packLatexDiffVCButton',
    'cleanLatexDiffVCButton',
    'latexDiffVCButton',
  ];
  const commitSelect = document.getElementById('commitSelect');
  commitSelect.innerHTML = '';

  if (message.isGitRepo === false) {
    addOptionToSelect(commitSelect, '', 'Not a Git repository');
    setElementsDisabled([commitSelect, ...commitButtons], true);
  } else {
    addOptionToSelect(commitSelect, 'HEAD', 'HEAD');
    message.commits.forEach((commit) => {
      const [commitHash, ...commitMessageParts] = commit.split(': ');
      const commitMessage = commitMessageParts.join(': ');
      addOptionToSelect(commitSelect, commitHash, commit);
    });
    setElementsDisabled([commitSelect, ...commitButtons], false);
  }
}

window.onload = function () {
  const dataRequests = [
    'getTheme',
    'requestInputFile',
    'requestReferenceFile',
    'requestAuxiliaryFile',
    'requestFigureFile',
    'requestRecentCommits',
    'requestBaseFile',
  ];

  dataRequests.forEach((request) => {
    vscode.postMessage({ command: request });
  });

  // Set default state for new folders
  setDefaultState();
};

window.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.command) {
    // VS Code Logic
    case 'setTheme':
      document.body.className = message.theme;
      break;
    case 'modelSelected':
      document.getElementById('modelSelect').value = message.model;
      break;
    // File selection
    case 'setInputFile':
    case 'setReferenceFile':
    case 'setAuxiliaryFile':
    case 'setFigureFile':
      updateFileSelect(
        `${message.command.charAt(3).toLowerCase() + message.command.slice(4)}Select`,
        message.files,
      );
      break;
    case 'inputFileSelected':
    case 'referenceFileSelected':
    case 'auxiliaryFileSelected':
    case 'figureFileSelected':
    case 'editedFileSelected':
      document.getElementById(
        `${message.command.replace('Selected', 'Select')}`,
      ).value = message.filePath;
      break;
    // Multiple file selection
    case 'setMultipleInputFiles':
    case 'setMultipleReferenceFiles':
    case 'setMultipleAuxiliaryFiles':
    case 'setMultipleFigures':
      updateMultipleFileSelect(
        `${message.command.replace('setMultiple', 'multiple')}Select`,
        `toggle${message.command.replace('set', '')}`,
        message.files,
      );
      break;
    case 'setMultipleOutputFiles':
      updateMultipleFileSelect(
        'outputFilesList',
        'toggleOutputFiles',
        message.files,
      );
      break;
    case 'setEditedFile':
      updateFileSelect('editedFileSelect', message.files);
      break;
    case 'setRecentCommits':
      handleRecentCommits(message);
      break;
    case 'setCurrentFile':
      const fileSelect = document.getElementById(
        `${message.fileType}FileSelect`,
      );
      const options = Array.from(fileSelect.options);
      const matchingOption = options.find(
        (option) => option.value === message.filePath,
      );
      if (matchingOption) {
        fileSelect.value = message.filePath;
        // Trigger change event to update related fields
        fileSelect.dispatchEvent(new Event('change'));
      } else {
        vscode.postMessage({
          command: 'showInformationMessage',
          text: `The current file is not in the ${message.fileType} file list: ${message.filePath}`,
        });
      }
      break;
    case 'setOpenedFiles':
      updateMultipleFileSelect(
        'multipleInputFilesSelect',
        'toggleMultipleInputFiles',
        message.files,
      );
      updateMultipleFileSelect(
        'multipleReferenceFilesSelect',
        'toggleMultipleReferenceFiles',
        message.files,
      );
      updateMultipleFileSelect(
        'multipleAuxiliaryFilesSelect',
        'toggleMultipleAuxiliaryFiles',
        message.files,
      );
      updateMultipleFileSelect(
        'multipleFiguresSelect',
        'toggleMultipleFigures',
        message.files,
      );
      break;
    case 'setBaseFile':
      updateFileSelect('baseFileSelect', message.files);
      updateEditedFileSelect(document.getElementById('baseFileSelect').value);
      // sus
      break;
  }

  // Restore previous state
  restoreState();
});

document.addEventListener('DOMContentLoaded', function () {
  const sortableElements = [
    'multipleInputFilesSelect',
    'multipleReferenceFilesSelect',
    'multipleAuxiliaryFilesSelect',
    'multipleFiguresSelect',
    'outputFilesList',
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

  // Add event listeners for the new empty buttons
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

  const emptyButtons = [
    {
      id: 'emptyMultipleInputFilesButton',
      selectId: 'multipleInputFilesSelect',
      toggleId: 'toggleMultipleInputFiles',
    },
    {
      id: 'emptyMultipleReferenceFilesButton',
      selectId: 'multipleReferenceFilesSelect',
      toggleId: 'toggleMultipleReferenceFiles',
    },
    {
      id: 'emptyMultipleAuxiliaryFilesButton',
      selectId: 'multipleAuxiliaryFilesSelect',
      toggleId: 'toggleMultipleAuxiliaryFiles',
    },
    {
      id: 'emptyMultipleFiguresButton',
      selectId: 'multipleFiguresSelect',
      toggleId: 'toggleMultipleFigures',
    },
  ];

  emptyButtons.forEach(({ id, selectId, toggleId }) => {
    document
      .getElementById(id)
      .addEventListener('click', () => emptyMultipleFiles(selectId, toggleId));
  });

  document
    .getElementById('emptyInstructionsButton')
    .addEventListener('click', function () {
      document.getElementById('instructionInput').value = '';
      saveState();
    });

  const checkBoxes = [
    'autoExtractFigure',
    'autoExtractTikzFigure',
    'autoExtractTikzFigureReflect',
    'includeTexCount',
  ];
  checkBoxes.forEach((id) => {
    document
      .getElementById(id)
      .addEventListener('change', handleCheckboxChange);
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
          ? getSelectedFiles(document.getElementById('outputFilesList'))
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

  document.getElementById('packButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const agent = document.getElementById('agentSelect').value;
    const model = document.getElementById('modelSelect').value;
    const outputNameOverrideElement =
      document.getElementById('outputNameOverride');
    const outputNameOverride =
      outputNameOverrideElement.style.display !== 'none'
        ? outputNameOverrideElement.value.trim()
        : null;

    // Get multiple files if they exist
    const inputFiles = getSelectedFiles(
      document.getElementById('multipleInputFilesSelect'),
    );

    // Get output files if they exist
    const outputFiles = getSelectedFiles(
      document.getElementById('outputFilesList'),
    );

    // Determine if we should use multiple or single mode
    const useMultiple = inputFiles.length > 0 || outputFiles.length > 0;

    if (useMultiple) {
      vscode.postMessage({
        command: 'packMultiple',
        inputFile: inputFile,
        agent: agent,
        model: model,
        outputNameOverride: outputNameOverride,
        outputFiles: outputFiles,
      });

      vscode.postMessage({
        command: 'showInformationMessage',
        text: `Packing multiple files: ${[inputFile, ...inputFiles].join(', ')}`,
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
        command: 'packSingle',
        inputFile: inputFile,
        agent: agent,
        model: model,
        outputNameOverride: outputNameOverride,
      });

      vscode.postMessage({
        command: 'showInformationMessage',
        text: `Packing single file: ${inputFile}`,
      });
    }
  });

  document.getElementById('cleanButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const agent = document.getElementById('agentSelect').value;
    const model = document.getElementById('modelSelect').value;
    const outputNameOverrideElement =
      document.getElementById('outputNameOverride');
    const outputNameOverride =
      outputNameOverrideElement.style.display !== 'none'
        ? outputNameOverrideElement.value.trim()
        : null;

    // Get multiple files if they exist
    const inputFiles = getSelectedFiles(
      document.getElementById('multipleInputFilesSelect'),
    );

    // Get output files if they exist
    const outputFiles = getSelectedFiles(
      document.getElementById('outputFilesList'),
    );

    // Determine if we should use multiple or single mode
    const useMultiple = inputFiles.length > 0 || outputFiles.length > 0;

    if (useMultiple) {
      vscode.postMessage({
        command: 'cleanMultiple',
        inputFile: inputFile,
        agent: agent,
        model: model,
        outputNameOverride: outputNameOverride,
        outputFiles: outputFiles,
      });

      vscode.postMessage({
        command: 'showInformationMessage',
        text: `Cleaning multiple files: ${[inputFile, ...inputFiles].join(', ')}`,
      });
    } else {
      vscode.postMessage({
        command: 'cleanSingle',
        inputFile: inputFile,
        agent: agent,
        model: model,
        outputNameOverride: outputNameOverride,
      });

      vscode.postMessage({
        command: 'showInformationMessage',
        text: `Cleaning single file: ${inputFile}`,
      });
    }
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
  document
    .getElementById('packLatexDiffVCButton')
    .addEventListener('click', function () {
      const inputFile = document.getElementById('inputFileSelect').value;
      const baseFile = document.getElementById('baseFileSelect').value;
      const commitHash = document.getElementById('commitSelect').value;

      vscode.postMessage({
        command: 'packLatexDiffVC',
        inputFile: inputFile,
        baseFile: baseFile,
        commitHash: commitHash,
        clean: false,
      });

      vscode.postMessage({
        command: 'showInformationMessage',
        text: `Packing LaTeX diff with version control: ${baseFile} at commit ${commitHash}`,
      });
    });
  document
    .getElementById('cleanLatexDiffVCButton')
    .addEventListener('click', function () {
      const inputFile = document.getElementById('inputFileSelect').value;
      const baseFile = document.getElementById('baseFileSelect').value;
      const commitHash = document.getElementById('commitSelect').value;

      vscode.postMessage({
        command: 'cleanLatexDiffVC',
        inputFile: inputFile,
        baseFile: baseFile,
        commitHash: commitHash,
        clean: true,
      });

      vscode.postMessage({
        command: 'showInformationMessage',
        text: `Cleaning LaTeX diff with version control: ${baseFile} at commit ${commitHash}`,
      });
    });
  document
    .getElementById('currentBaseFileButton')
    .addEventListener('click', function () {
      const baseFile = document.getElementById('baseFileSelect').value;
      vscode.postMessage({
        command: 'getCurrentFile',
        fileType: 'base',
        baseFile: baseFile,
      });
    });
  document
    .getElementById('currentEditedFileButton')
    .addEventListener('click', function () {
      const baseFile = document.getElementById('baseFileSelect').value;
      vscode.postMessage({
        command: 'getCurrentFile',
        fileType: 'edited',
        baseFile: baseFile,
      });
    });

  // Save state on input changes
  const elementsToWatch = [
    'modelSelect',
    'agentSelect',
    'reflectSelect',
    'inputFileSelect',
    'referenceFileSelect',
    'auxiliaryFileSelect',
    'figureFileSelect',
    'autoExtractFigure',
    'autoExtractTikzFigure',
    'autoExtractTikzFigureReflect',
    'includeTexCount',
    'outputNameOverride',
    'baseFileSelect',
    'editedFileSelect',
    'commitSelect',
  ];

  elementsToWatch.forEach((id) => {
    document.getElementById(id).addEventListener('change', saveState);
  });

  // Special case for instructionInput as it uses 'input' event
  document
    .getElementById('instructionInput')
    .addEventListener('input', saveState);

  document
    .getElementById('toggleOutputFiles')
    .addEventListener('click', toggleOutputFiles);

  new Sortable(document.getElementById('outputFilesList'), {
    animation: 150,
    onEnd: saveState,
  });

  document
    .getElementById('outputNameOverride')
    .addEventListener('input', saveState);

  document
    .getElementById('toggleOutputNameOverride')
    .addEventListener('click', toggleOutputNameOverride);

  // Add these event listeners
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

  document
    .getElementById('emptyOutputFilesButton')
    .addEventListener('click', function () {
      emptyMultipleFiles('outputFilesList', 'toggleOutputFiles');
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

  // Add event listener for the new refresh button
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


  const toggles = [
    {
      containerId: 'multipleInputFilesSelect',
      toggleId: 'toggleMultipleInputFiles',
    },
    {
      containerId: 'multipleReferenceFilesSelect',
      toggleId: 'toggleMultipleReferenceFiles',
    },
    {
      containerId: 'multipleAuxiliaryFilesSelect',
      toggleId: 'toggleMultipleAuxiliaryFiles',
    },
    { containerId: 'multipleFiguresSelect', toggleId: 'toggleMultipleFigures' },
  ];

  toggles.forEach(({ containerId, toggleId }) => {
    document
      .getElementById(toggleId)
      .addEventListener('click', () =>
        toggleMultipleFiles(containerId, toggleId),
      );
  });
});
