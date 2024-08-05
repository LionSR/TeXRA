const vscode = acquireVsCodeApi();

function handleCheckboxChange(event) {
  const checkboxId = event.target.id;
  const isChecked = event.target.checked;
  vscode.postMessage({ command: `update${checkboxId.charAt(0).toUpperCase() + checkboxId.slice(1)}`, value: isChecked });
}

function updateFileSelect(selectId, files) {
  const select = document.getElementById(selectId);
  if (!select) return console.error(`Element with id '${selectId}' not found`);
  select.innerHTML = '<option value="">None</option>' +
    files.map(file => `<option value="${file}">${file}</option>`).join('');
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
  const toggleIcon = document.getElementById(`toggle${containerId.charAt(0).toUpperCase() + containerId.slice(1)}`);
  const fileElement = document.createElement('div');
  fileElement.innerHTML = `${file} <span class="remove-button">-</span>`;
  fileElement.querySelector('.remove-button').addEventListener('click', () => {
    container.removeChild(fileElement);
    if (container.children.length === 0) {
      containerId === 'outputFilesList' ? handleEmptyOutputFiles() :
        (container.style.display = 'none', toggleIcon.textContent = '▼', saveState());
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

function getSelectedFiles(multipleInputFilesSelectDiv) {
  const fileElements = multipleInputFilesSelectDiv.getElementsByTagName('div');
  return Array.from(fileElements).map(el => el.textContent.replace(' -', '') || '');
}

function updateMultipleFileSelect(selectId, toggleIconId, files) {
  const selectDiv = document.getElementById(selectId);
  const toggleIcon = document.getElementById(toggleIconId);
  const existingFiles = getSelectedFiles(selectDiv);
  const newFiles = files.filter(file => !existingFiles.includes(file));
  if (newFiles.length > 0) {
    newFiles.forEach(file => {
      addFileToList(selectId, file);
    });
    selectDiv.style.display = 'block';
    toggleIcon.textContent = '▲';
    vscode.postMessage({ command: 'showInformationMessage', text: `Added ${newFiles.length} file(s) to ${selectId}` });
  }
  saveState();
}

function initializeOutputFiles() {
  const inputFileSelect = document.getElementById('inputFileSelect');
  const multipleInputFilesSelect = document.getElementById('multipleInputFilesSelect');
  const outputFilesList = document.getElementById('outputFilesList');
  outputFilesList.innerHTML = '';

  // Add the main input file
  if (inputFileSelect.value) {
    addFileToList('outputFilesList', inputFileSelect.value);
  }

  // Add multiple input files
  const additionalFiles = getSelectedFiles(multipleInputFilesSelect);
  additionalFiles.forEach(file => {
    addFileToList('outputFilesList', file);
  });
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

function handleRecentCommits(message) {
  const commitButtons = [
    'packLatexDiffVCButton',
    'cleanLatexDiffVCButton',
    'latexDiffVCButton'
  ];
  const commitSelect = document.getElementById('commitSelect');
  commitSelect.innerHTML = '';

  if (message.isGitRepo === false) {
    addOptionToSelect(commitSelect, '', 'Not a Git repository');
    setElementsDisabled([commitSelect, ...commitButtons], true);
  } else {
    addOptionToSelect(commitSelect, 'HEAD', 'HEAD');
    message.commits.forEach(commit => {
      const [commitHash, ...commitMessageParts] = commit.split(': ');
      const commitMessage = commitMessageParts.join(': ');
      addOptionToSelect(commitSelect, commitHash, commit);
    });
    setElementsDisabled([commitSelect, ...commitButtons], false);
  }
}

function addOptionToSelect(select, value, text) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = text;
  select.appendChild(option);
}

function setElementsDisabled(elements, disabled) {
  elements.forEach(element => {
    if (typeof element === 'string') {
      document.getElementById(element).disabled = disabled;
    } else {
      element.disabled = disabled;
    }
  });
}

window.onload = function () {
  const dataRequests = [
    'getTheme',
    'requestInputFile',
    'requestSampleFile',
    'requestAuxFile',
    'requestFigureFile',
    'requestRecentCommits',
  ];

  dataRequests.forEach(request => {
    vscode.postMessage({ command: request });
  });

  // Set default state for new folders
  setDefaultState();
};

function setDefaultState() {
  // Hide output name override by default
  const outputNameOverride = document.getElementById('outputNameOverride');
  const toggleOutputNameOverride = document.getElementById('toggleOutputNameOverride');
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
    'multipleSampleFilesSelect',
    'multipleAuxFilesSelect',
    'multipleFiguresSelect'
  ];

  multipleSelections.forEach(id => {
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
      taskSelect: 'correct-tex',
      reflectSelect: 'True',
      commitSelect: 'HEAD'
    };

    const valueElements = [
      'modelSelect', 'taskSelect', 'inputFileSelect', 'auxFileSelect',
      'figureFileSelect', 'sampleFileSelect', 'editedFileSelect',
      'taskInput', 'reflectSelect', 'commitSelect', 'outputNameOverride'
    ];

    valueElements.forEach(id => {
      document.getElementById(id).value = previousState[id] || defaultValues[id] || '';
    });

    const checkboxElements = [
      'autoExtractFigure', 'autoExtractTikzFigure',
      'includeTikzReflection', 'includeTexCount'
    ];
    checkboxElements.forEach(id => {
      document.getElementById(id).checked = previousState[id] || false;
    });

    const multipleSelections = [
      { id: 'multipleInputFilesSelect', toggleId: 'toggleMultipleInputFiles' },
      { id: 'multipleSampleFilesSelect', toggleId: 'toggleMultipleSampleFiles' },
      { id: 'multipleAuxFilesSelect', toggleId: 'toggleMultipleAuxFiles' },
      { id: 'multipleFiguresSelect', toggleId: 'toggleMultipleFigures' }
    ];

    multipleSelections.forEach(({ id, toggleId }) => {
      const selectDiv = document.getElementById(id);
      const toggleIcon = document.getElementById(toggleId);
      selectDiv.innerHTML = '';
      if (previousState[id] && previousState[id].length > 0) {
        previousState[id].forEach(file => {
          addFileToList(id, file);
        });
        setMultipleFileSelectVisibility(id, toggleId, previousState[`${id}Visible`]);
      } else {
        setMultipleFileSelectVisibility(id, toggleId, false);
      }
    });

    const outputFilesContainer = document.getElementById('outputFilesContainer');
    const toggleIcon = document.getElementById('toggleOutputFiles');
    if (previousState.outputFilesContainerVisible && previousState.outputFiles && previousState.outputFiles.length > 0) {
      outputFilesContainer.style.display = 'block';
      toggleIcon.textContent = '▲';
      const outputFilesList = document.getElementById('outputFilesList');
      outputFilesList.innerHTML = '';
      previousState.outputFiles.forEach(file => {
        addFileToList('outputFilesList', file);
      });
    } else {
      outputFilesContainer.style.display = 'none';
      toggleIcon.textContent = '▼';
    }

    const outputNameOverride = document.getElementById('outputNameOverride');
    const toggleOutputNameOverride = document.getElementById('toggleOutputNameOverride');
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

function emptyMultipleFiles(containerId, toggleId) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  container.style.display = 'none';
  document.getElementById(toggleId).textContent = '▼';
  saveState();
}

window.addEventListener('message', event => {
  const message = event.data;
  switch (message.command) {
    case 'setInputFile':
    case 'setSampleFile':
    case 'setAuxFile':
    case 'setFigureFile':
      updateFileSelect(`${message.command.charAt(3).toLowerCase() + message.command.slice(4)}Select`, message.files);
      break;
    case 'setMultipleInputFiles':
    case 'setMultipleSampleFiles':
    case 'setMultipleAuxFiles':
    case 'setMultipleFigures':
      updateMultipleFileSelect(
        `${message.command.replace('setMultiple', 'multiple')}Select`,
        `toggle${message.command.replace('set', '')}`,
        message.files
      );
      break;
    case 'setEditedFiles':
      updateFileSelect('editedFileSelect', message.files);
      break;
    case 'inputFileSelected':
      document.getElementById('inputFileSelect').value = message.filePath;
      vscode.postMessage({
        command: 'requestEditedFile',
        inputFile: message.filePath,
        outputNameOverride: message.outputNameOverride
      });
      break;
    case 'sampleFileSelected':
    case 'auxFileSelected':
    case 'figureFileSelected':
    case 'editedFileSelected':
      document.getElementById(`${message.command.replace('Selected', 'Select')}`).value = message.filePath;
      break;
    case 'modelSelected':
      document.getElementById('modelSelect').value = message.model;
      break;
    case 'setRecentCommits':
      handleRecentCommits(message);
      break;
    case 'setCurrentFile':
      const fileSelect = document.getElementById(`${message.fileType}FileSelect`);
      const options = Array.from(fileSelect.options);
      const matchingOption = options.find(option => option.value === message.filePath);
      if (matchingOption) {
        fileSelect.value = message.filePath;
        // Trigger change event to update related fields
        fileSelect.dispatchEvent(new Event('change'));
      } else {
        vscode.window.showInformationMessage(`The current file is not in the ${message.fileType} file list: ${message.filePath}`);
      }
      break;
    case 'setTheme':
      document.body.className = message.theme;
      break;
    case 'setOpenedFiles':
      updateMultipleFileSelect('multipleInputFilesSelect', 'toggleMultipleInputFiles', message.files);
      // sus
      break;
  }

  // Restore previous state
  restoreState();
});

document.addEventListener('DOMContentLoaded', function () {
  const sortableElements = [
    'multipleInputFilesSelect',
    'multipleAuxFilesSelect',
    'multipleFiguresSelect',
    'multipleSampleFilesSelect',
    'outputFilesList'
  ];

  sortableElements.forEach(id => {
    const element = document.getElementById(id);
    if (element) {
      new Sortable(element, {
        animation: 150,
        onEnd: saveState
      });
    } else {
      console.warn(`Element with id '${id}' not found for Sortable initialization`);
    }
  });

  document.getElementById('taskSelect').addEventListener('change', function () {
    const selectedTask = this.value;
    if (selectedTask.startsWith('correct')) {
      document.getElementById('figureFileSelect').value = '';
      document.getElementById('reflectSelect').value = 'False';
    } else {
      // Refresh the figure file options
      vscode.postMessage({ command: 'requestFigureFile' });
    }
    saveState();
  });
  document.getElementById('modelSelect').addEventListener('change', function () {
    vscode.postMessage({
      command: 'modelSelected',
      model: this.value
    });
  });
  document.getElementById('inputFileSelect').addEventListener('change', function () {
    const inputFile = this.value;
    const outputNameOverride = document.getElementById('outputNameOverride').value.trim() || null;
    vscode.postMessage({
      command: 'inputFileSelected',
      filePath: inputFile,
      outputNameOverride: outputNameOverride
    });
  });
  document.getElementById('sampleFileSelect').addEventListener('change', function () {
    const sampleFile = this.value;
    vscode.postMessage({
      command: 'sampleFileSelected',
      filePath: sampleFile
    });
  });
  const multipleFileSelectors = [
    { id: 'InputFiles', selectId: 'inputFileSelect' },
    { id: 'SampleFiles', selectId: 'sampleFileSelect' },
    { id: 'AuxFiles', selectId: 'auxFileSelect' },
    { id: 'Figures', selectId: 'figureFileSelect' }
  ];

  multipleFileSelectors.forEach(({ id, selectId }) => {
    document.getElementById(`selectMultiple${id}Button`).addEventListener('click', function () {
      const currentFile = document.getElementById(selectId).value;
      vscode.postMessage({
        command: 'selectMultipleFiles',
        fileType: id,
        currentFile: currentFile
      });
    });
  });

  const emptyButtons = [
    { id: 'emptyMultipleInputFilesButton', selectId: 'multipleInputFilesSelect', toggleId: 'toggleMultipleInputFiles' },
    { id: 'emptyMultipleSampleFilesButton', selectId: 'multipleSampleFilesSelect', toggleId: 'toggleMultipleSampleFiles' },
    { id: 'emptyMultipleAuxFilesButton', selectId: 'multipleAuxFilesSelect', toggleId: 'toggleMultipleAuxFiles' },
    { id: 'emptyMultipleFiguresButton', selectId: 'multipleFiguresSelect', toggleId: 'toggleMultipleFigures' }
  ];

  emptyButtons.forEach(({ id, selectId, toggleId }) => {
    document.getElementById(id).addEventListener('click', () => emptyMultipleFiles(selectId, toggleId));
  });

  document.getElementById('emptyInstructionsButton').addEventListener('click', function () {
    document.getElementById('taskInput').value = '';
    saveState();
  });

  const checkBoxes = [
    'autoExtractFigure',
    'autoExtractTikzFigure',
    'includeTikzReflection',
    'includeTexCount'
  ];
  checkBoxes.forEach(id => {
    document.getElementById(id).addEventListener('change', handleCheckboxChange);
  });

  const buttonCommands = {
    'cleanOutputButton': 'cleanOutput',
    'cleanBuildButton': 'cleanBuild',
    'indentTexButton': 'indentTex',
    'refreshCommitsButton': 'refreshCommits'
  };

  Object.entries(buttonCommands).forEach(([id, command]) => {
    document.getElementById(id).addEventListener('click', () => {
      vscode.postMessage({ command });
    });
  });

  document.getElementById('executeButton').addEventListener('click', function () {
    const task = document.getElementById('taskSelect').value;
    const inputFile = document.getElementById('inputFileSelect').value;
    const instructions = document.getElementById('taskInput').value;
    const reflect = document.getElementById('reflectSelect').value;
    const model = document.getElementById('modelSelect').value;
    const autoExtractFigure = document.getElementById('autoExtractFigure').checked;
    const autoExtractTikzFigure = document.getElementById('autoExtractTikzFigure').checked;
    const includeTikzReflection = document.getElementById('includeTikzReflection').checked;
    const includeTexCount = document.getElementById('includeTexCount').checked;

    const getFiles = (selectId, singleFileId) => {
      const selectDiv = document.getElementById(selectId);
      const singleFile = document.getElementById(singleFileId).value;
      return selectDiv.style.display === 'block'
        ? getSelectedFiles(selectDiv)
        : (singleFile ? [singleFile] : []);
    };

    const additionalInputFiles = getFiles('multipleInputFilesSelect', 'inputFileSelect')
      .filter(file => file !== inputFile);
    const sampleFiles = getFiles('multipleSampleFilesSelect', 'sampleFileSelect');
    const auxFiles = getFiles('multipleAuxFilesSelect', 'auxFileSelect');
    const figureFiles = getFiles('multipleFiguresSelect', 'figureFileSelect');

    const outputFilesContainer = document.getElementById('outputFilesContainer');
    const outputFiles = outputFilesContainer.style.display === 'block'
      ? getSelectedFiles(document.getElementById('outputFilesList'))
      : null;
    const outputNameOverride = document.getElementById('outputNameOverride').value.trim();

    vscode.postMessage({
      command: 'execute',
      task: task,
      inputFile: inputFile,
      additionalInputFiles: additionalInputFiles,
      sampleFiles: sampleFiles,
      auxFiles: auxFiles,
      figureFiles: figureFiles,
      instructions: instructions,
      reflect: reflect,
      model: model,
      autoExtractFigure: autoExtractFigure,
      autoExtractTikzFigure: autoExtractTikzFigure,
      includeTikzReflection: includeTikzReflection,
      includeTexCount: includeTexCount,
      outputFiles: outputFiles,
      outputNameOverride: outputNameOverride || null,
    });
  });
  document.getElementById('packSingleButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const task = document.getElementById('taskSelect').value;
    const reflect = document.getElementById('reflectSelect').value;
    const model = document.getElementById('modelSelect').value;
    const outputNameOverride = document.getElementById('outputNameOverride').value.trim() || null;
    vscode.postMessage({
      command: 'packSingle',
      inputFile: inputFile,
      task: task,
      reflect: reflect,
      model: model,
      outputNameOverride: outputNameOverride
    });
  });
  document.getElementById('cleanSingleButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const task = document.getElementById('taskSelect').value;
    const reflect = document.getElementById('reflectSelect').value;
    const model = document.getElementById('modelSelect').value;
    const outputNameOverride = document.getElementById('outputNameOverride').value.trim() || null;
    vscode.postMessage({
      command: 'cleanSingle',
      inputFile: inputFile,
      task: task,
      reflect: reflect,
      model: model,
      outputNameOverride: outputNameOverride
    });
  });
  document.getElementById('latexDiffButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const editedFile = document.getElementById('editedFileSelect').value;
    vscode.postMessage({
      command: 'latexDiff',
      inputFile: inputFile,
      editedFile: editedFile
    });
  });
  document.getElementById('latexDiffVCButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const commitHash = document.getElementById('commitSelect').value;
    vscode.postMessage({
      command: 'latexDiffVC',
      inputFile: inputFile,
      commitHash: commitHash
    });
  });
  document.getElementById('packLatexDiffVCButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const commitHash = document.getElementById('commitSelect').value;
    vscode.postMessage({
      command: 'packLatexDiffVC',
      inputFile: inputFile,
      commitHash: commitHash,
      clean: false
    });
  });
  document.getElementById('cleanLatexDiffVCButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const commitHash = document.getElementById('commitSelect').value;
    vscode.postMessage({
      command: 'packLatexDiffVC',
      inputFile: inputFile,
      commitHash: commitHash,
      clean: true
    });
  });
  document.getElementById('currentEditedFileButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const outputNameOverride = document.getElementById('outputNameOverride').value.trim() || null;
    vscode.postMessage({
      command: 'requestEditedFile',
      inputFile: inputFile,
      outputNameOverride: outputNameOverride
    });
  });
  document.getElementById('mergeButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const editedFile = document.getElementById('editedFileSelect').value;
    vscode.postMessage({
      command: 'merge',
      inputFile: inputFile,
      editedFile: editedFile
    });
  });

  // Save state on input changes
  const elementsToWatch = [
    'modelSelect', 'taskSelect', 'inputFileSelect', 'sampleFileSelect',
    'auxFileSelect', 'figureFileSelect', 'reflectSelect',
    'commitSelect', 'autoExtractFigure', 'autoExtractTikzFigure',
    'includeTikzReflection', 'includeTexCount'
  ];

  elementsToWatch.forEach(id => {
    document.getElementById(id).addEventListener('change', saveState);
  });

  // Special case for taskInput as it uses 'input' event
  document.getElementById('taskInput').addEventListener('input', saveState);

  document.getElementById('toggleOutputFiles').addEventListener('click', toggleOutputFiles);

  new Sortable(document.getElementById('outputFilesList'), {
    animation: 150,
    onEnd: saveState
  });

  document.getElementById('outputNameOverride').addEventListener('input', saveState);

  document.getElementById('toggleOutputNameOverride').addEventListener('click', toggleOutputNameOverride);

  // Add these event listeners
  document.getElementById('packMultipleButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const additionalInputFiles = getSelectedFiles(document.getElementById('multipleInputFilesSelect'));
    const task = document.getElementById('taskSelect').value;
    const reflect = document.getElementById('reflectSelect').value;
    const model = document.getElementById('modelSelect').value;
    const outputNameOverride = document.getElementById('outputNameOverride');
    const outputNameOverrideValue = outputNameOverride.style.display !== 'none'
      ? outputNameOverride.value
      : null;
    const outputFiles = getSelectedFiles(document.getElementById('outputFilesList'));

    vscode.postMessage({
      command: 'packMultiple',
      inputFile: inputFile,
      additionalInputFiles: additionalInputFiles,
      task: task,
      reflect: reflect,
      model: model,
      outputNameOverride: outputNameOverrideValue,
      outputFiles: outputFiles
    });
  });

  document.getElementById('cleanMultipleButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const additionalInputFiles = getSelectedFiles(document.getElementById('multipleInputFilesSelect'));
    const task = document.getElementById('taskSelect').value;
    const reflect = document.getElementById('reflectSelect').value;
    const model = document.getElementById('modelSelect').value;
    const outputNameOverride = document.getElementById('outputNameOverride');
    const outputNameOverrideValue = outputNameOverride.style.display !== 'none'
      ? outputNameOverride.value
      : null;
    const outputFiles = getSelectedFiles(document.getElementById('outputFilesList'));

    vscode.postMessage({
      command: 'cleanMultiple',
      inputFile: inputFile,
      additionalInputFiles: additionalInputFiles,
      task: task,
      reflect: reflect,
      model: model,
      outputNameOverride: outputNameOverrideValue,
      outputFiles: outputFiles
    });
  });

  const toggles = [
    { containerId: 'multipleInputFilesSelect', toggleId: 'toggleMultipleInputFiles' },
    { containerId: 'multipleSampleFilesSelect', toggleId: 'toggleMultipleSampleFiles' },
    { containerId: 'multipleAuxFilesSelect', toggleId: 'toggleMultipleAuxFiles' },
    { containerId: 'multipleFiguresSelect', toggleId: 'toggleMultipleFigures' }
  ];

  toggles.forEach(({ containerId, toggleId }) => {
    document.getElementById(toggleId).addEventListener('click', () => toggleMultipleFiles(containerId, toggleId));
  });

  // Add this event listener with the other button event listeners
  document.getElementById('addOpenedFilesButton').addEventListener('click', function () {
    vscode.postMessage({
      command: 'addOpenedFiles'
    });
  });


  // Add event listeners for current file buttons
  ['Input', 'Sample', 'Aux', 'Figure'].forEach(type => {
    document.getElementById(`current${type}FileButton`).addEventListener('click', () => {
      vscode.postMessage({ command: 'getCurrentFile', fileType: type.toLowerCase() });
    });
  });
});

function toggleMultipleFiles(containerId, toggleIconId) {
  const container = document.getElementById(containerId);
  const toggleIcon = document.getElementById(toggleIconId);
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

function hideEmptyMultipleFileSelects() {
  const multipleSelections = [
    'multipleInputFilesSelect',
    'multipleSampleFilesSelect',
    'multipleAuxFilesSelect',
    'multipleFiguresSelect'
  ];

  multipleSelections.forEach(id => {
    const selectDiv = document.getElementById(id);
    const toggleId = `toggle${id.charAt(0).toUpperCase() + id.slice(1)}`;
    if (selectDiv.children.length === 0) {
      setMultipleFileSelectVisibility(id, toggleId, false);
    }
  });
}

function saveState() {
  const state = {};
  const elementsToSave = [
    'modelSelect', 'taskSelect', 'inputFileSelect', 'sampleFileSelect',
    'auxFileSelect', 'figureFileSelect', 'taskInput', 'reflectSelect',
    'commitSelect', 'autoExtractFigure', 'autoExtractTikzFigure',
    'includeTikzReflection', 'includeTexCount', 'outputNameOverride'
  ];

  elementsToSave.forEach(id => {
    const element = document.getElementById(id);
    state[id] = element.type === 'checkbox' ? element.checked : element.value;
  });

  const multipleSelects = [
    'multipleInputFilesSelect', 'multipleSampleFilesSelect',
    'multipleAuxFilesSelect', 'multipleFiguresSelect'
  ];

  multipleSelects.forEach(id => {
    state[`${id}Visible`] = document.getElementById(id).style.display === 'block';
    state[id] = getSelectedFiles(document.getElementById(id));
  });

  state.outputFilesContainerVisible = document.getElementById('outputFilesContainer').style.display === 'block';
  state.outputFiles = getSelectedFiles(document.getElementById('outputFilesList'));
  state.outputNameOverrideVisible = document.getElementById('outputNameOverride').style.display !== 'none';

  vscode.setState(state);
}

